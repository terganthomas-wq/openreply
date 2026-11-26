import { createDMWorker } from "@/lib/queue/dm-worker";
import { startMetaUsageReports } from "@/lib/ops/meta-usage";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { attachPendingNextReels } from "@/lib/automation/attach-next-reel";
import { checkInstagramConnections } from "@/lib/instagram/connection-check";
import { checkMessagingSilences } from "@/lib/instagram/messaging-silence-check";
import {
  resumeConnectionCatchUps,
  stopConnectionCatchUps,
} from "@/lib/instagram/connection-catch-up";
import {
  resumeLostTapSearches,
  stopLostTapSearches,
} from "@/lib/instagram/lost-tap-search";
import os from "node:os";

// A WARNING in Diagnostics once a Meta response reports 80 % of a request
// limit, before Meta starts refusing messages.
startMetaUsageReports();
const worker = createDMWorker();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  // A1: one cheap read of each connected account's own node, so a
  // connection Meta dropped opens an incident and e-mails the owners
  // (lib/instagram/connection-check.ts). Before the sweep, on its own: a
  // failure here never stops the sweep.
  try {
    const checked = await checkInstagramConnections({
      intervalMs: POLL_INTERVAL_MS,
    });
    const { ok = 0, paused = 0, ...others } = checked.outcomes;
    if (Object.keys(others).length > 0) {
      console.log("[DM Worker] Connection check:", { ok, paused, ...others });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Connection check failed:", message);
  }

  // A2: from the database alone, whether Instagram still passes on button
  // taps, DMs and read receipts for each account, so a silence like the one
  // of 2026-11-25/26 opens an incident and e-mails the owners
  // (lib/instagram/messaging-silence-check.ts). After the connection check,
  // whose incidents it stands back for; on its own, like it.
  try {
    const silences = await checkMessagingSilences({ intervalMs: POLL_INTERVAL_MS });
    const { quiet = 0, "no-campaign": noCampaign = 0, ...others } = silences.outcomes;
    if (Object.keys(others).length > 0 || silences.mailed > 0) {
      console.log("[DM Worker] Messaging silence check:", {
        quiet,
        noCampaign,
        ...others,
        mailed: silences.mailed,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Messaging silence check failed:", message);
  }

  // A2: the search for the taps a silence swallowed, owed but neither running
  // nor queued (its request was lost, or the worker restarted), is asked for
  // again. No Meta call here; the search itself runs as a queue job
  // (lib/instagram/lost-tap-search.ts).
  try {
    const searches = await resumeLostTapSearches();
    if (searches.requested > 0) {
      console.log("[DM Worker] Search for lost taps:", searches);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Lost-tap search look failed:", message);
  }

  // A1: a catch-up of missed comments that is owed but neither running nor
  // queued (its request was lost, or the worker restarted) is asked for
  // again, and an all-clear e-mail still owed goes out. No Meta call here;
  // the catch-up itself runs as a queue job (lib/instagram/connection-catch-up.ts).
  try {
    const resumed = await resumeConnectionCatchUps();
    if (resumed.requested > 0 || resumed.mailed > 0) {
      console.log("[DM Worker] Catch-up after a lost connection:", resumed);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Catch-up look failed:", message);
  }

  try {
    const attached = await attachPendingNextReels();
    if (attached.bound > 0 || attached.failedAccounts > 0) {
      console.log("[DM Worker] Next-reel attachment:", attached);
    }
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  // A catch-up or a search for lost taps that reads stops before its next
  // read and queues the rest for a minute later, so the shutdown does not
  // wait for its reads.
  stopConnectionCatchUps();
  stopLostTapSearches();
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
