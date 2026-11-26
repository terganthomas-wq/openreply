/**
 * The end of a messaging silence (A2), shared by the webhook route
 * (lib/queue/process-webhook.ts), which ends it the moment an inbound
 * messaging event arrives, and the worker's check
 * (lib/instagram/messaging-silence-check.ts), which ends it when it finds one
 * the route did not act on.
 *
 * A silence ends with one inbound messaging event: a button tap, a DM that
 * is not an echo, a read receipt or a reaction for the account. The open
 * incident (messagingSilentSince) is closed in one conditional update that
 * also keeps the silence as the account's last one (messagingSilenceResult)
 * and owes the search for the taps Instagram swallowed meanwhile
 * (messagingTapSearchFrom and messagingTapSearchUntil): onMessagingSilenceEnded
 * asks the worker for it (lib/instagram/lost-tap-search.ts), which adds what
 * it found to messagingSilenceResult and makes the all-clear e-mail due
 * (lib/ops/messaging-silence-alert.ts). A first silent check that is still
 * waiting for its second (messagingSilenceCheckAt) is forgotten.
 *
 * Database and queue only, no Meta or mail import: the web app's webhook
 * route uses it.
 */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type {
  MessagingSilenceEnd,
  MessagingSilenceResult,
} from "@/lib/instagram/messaging-silence-incident";
import { lostTapSearchJobId } from "@/lib/instagram/lost-tap-state";
import { inboundMessagingAccountIds } from "@/lib/meta/webhook";
import { MESSAGING_BACK_EVENT } from "@/lib/ops/event-details";
import {
  getDMQueue,
  LOST_TAP_SEARCH_JOB_NAME,
  type ProcessLostTapSearchJob,
} from "@/lib/queue/client";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** A silence that ended, for the hook below and the caller. */
export interface EndedSilence {
  accountId: string;
  workspaceId: string;
  /** The Instagram business id. */
  instagramId: string;
  username: string;
  /** Since when nothing arrived (the incident's messagingSilentSince). */
  since: Date;
  /** When the inbound event that ended it arrived. */
  endedAt: Date;
  via: MessagingSilenceEnd;
  /**
   * Where the search for lost taps starts (messagingTapSearchFrom after the
   * end): `since`, or the start of an earlier silence whose search is still
   * owed, which this one is searched with.
   */
  searchFrom: Date;
}

/**
 * What the end of a silence writes besides closing it, in the same update:
 * the silence as the account's last one, and the search for the taps that
 * got lost in it (A2 requirement 4), from its start (or an earlier start
 * whose search is still owed, like A1's connectionCatchUpFrom) up to its
 * end. The all-clear waits for that search, which makes it due once it has
 * finished; an all-clear of an earlier silence that is still owed would only
 * tell old news now.
 */
function afterSilence(
  ended: Pick<EndedSilence, "since" | "endedAt" | "via" | "searchFrom">
) {
  const result: MessagingSilenceResult = {
    v: 1,
    since: ended.since.toISOString(),
    endedAt: ended.endedAt.toISOString(),
    via: ended.via,
  };
  return {
    messagingSilenceResult: result as unknown as Prisma.InputJsonValue,
    messagingTapSearchFrom: ended.searchFrom,
    messagingTapSearchUntil: ended.endedAt,
    messagingAllClearDueAt: null,
  };
}

// How long a request for the search waits for Redis. The webhook route must
// not hang on it; the worker's sweep asks again for a search still owed.
const QUEUE_TIMEOUT_MS = 5_000;

/**
 * Ask the worker to search the account's lost taps: the job
 * `losttaps_<account>_<from>_<until>` (lostTapSearchJobId), so the end of the
 * silence and the worker's sweep queue it once while it waits or runs. With
 * `runAt`, a delayed job for that time, under its own id: a search that
 * stopped early (an R1 pause, Meta's usage) goes on then. Removed once it
 * ends, so a later request is never swallowed by a finished one. False when
 * it could not be queued; never throws.
 */
export async function queueLostTapSearch(
  account: { id: string; instagramId: string },
  from: Date,
  until: Date,
  { runAt, now = Date.now() }: { runAt?: number; now?: number } = {}
): Promise<boolean> {
  const data: ProcessLostTapSearchJob = {
    accountConnectionId: account.id,
    instagramAccountId: account.instagramId,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      getDMQueue().add(LOST_TAP_SEARCH_JOB_NAME, data, {
        jobId: lostTapSearchJobId(account.id, from, until, runAt),
        delay: runAt === undefined ? 0 : Math.max(0, runAt - now),
        removeOnComplete: true,
        removeOnFail: true,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the queue did not answer in time")),
          QUEUE_TIMEOUT_MS
        );
      }),
    ]);
    return true;
  } catch (error) {
    console.error(
      "[Messaging silence] Could not queue the search for lost taps:",
      describeError(error)
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Called once when a silence ended, by whoever ended it: records it in
 * Diagnostics and asks the worker for the search for lost taps. Should the
 * request not reach the queue, the worker's next sweep asks again. Never
 * throws.
 */
export async function onMessagingSilenceEnded(ended: EndedSilence): Promise<void> {
  const hours = Math.max(
    1,
    Math.round((ended.endedAt.getTime() - ended.since.getTime()) / (60 * 60_000))
  );
  try {
    await prisma.operationalEvent.create({
      data: {
        workspaceId: ended.workspaceId,
        source: ended.via === "check" ? "WORKER" : "SYSTEM",
        level: "INFO",
        message: `Instagram passes on button taps, DMs and read receipts for @${ended.username} again (${ended.via === "check" ? "the check found one" : "one arrived"}; nothing arrived for about ${hours} h, since ${ended.since.toISOString()})`,
        payload: {
          kind: MESSAGING_BACK_EVENT,
          account: ended.username,
          since: ended.since.toISOString(),
          endedAt: ended.endedAt.toISOString(),
          via: ended.via,
        },
      },
    });
  } catch (error) {
    console.error(
      "[Messaging silence] Could not record the end of a silence:",
      describeError(error)
    );
  }
  await queueLostTapSearch(
    { id: ended.accountId, instagramId: ended.instagramId },
    ended.searchFrom,
    ended.endedAt
  );
}

/**
 * End the account's silence, or forget its first silent check, because an
 * inbound messaging event arrived at `at`. Reads the row fresh, so a check
 * that opened the silence a moment before is ended too; tries again when the
 * state changed in between. Returns the ended silence, or null when none was
 * open.
 */
export async function endMessagingSilence(
  accountId: string,
  { via, at }: { via: MessagingSilenceEnd; at: Date }
): Promise<EndedSilence | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await prisma.instagramAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        workspaceId: true,
        instagramId: true,
        username: true,
        messagingSilentSince: true,
        messagingSilenceCheckAt: true,
        messagingTapSearchFrom: true,
      },
    });
    if (!current) return null;

    const since = current.messagingSilentSince;
    if (!since) {
      if (!current.messagingSilenceCheckAt) return null;
      const cleared = await prisma.instagramAccount.updateMany({
        where: {
          id: accountId,
          messagingSilentSince: null,
          messagingSilenceCheckAt: current.messagingSilenceCheckAt,
        },
        data: { messagingSilenceCheckAt: null },
      });
      if (cleared.count === 1) return null;
      continue;
    }

    // An event cannot end a silence before it began.
    const endedAt = at.getTime() > since.getTime() ? at : new Date(since.getTime() + 1);
    const pending = current.messagingTapSearchFrom ?? null;
    const searchFrom = pending && pending.getTime() < since.getTime() ? pending : since;
    const ended = await prisma.instagramAccount.updateMany({
      where: {
        id: accountId,
        messagingSilentSince: since,
        // The owed search as it was read: one that finished meanwhile is not
        // brought back with its old start.
        messagingTapSearchFrom: pending,
      },
      data: {
        messagingSilentSince: null,
        messagingSilenceCheckAt: null,
        messagingAlertCount: 0,
        ...afterSilence({ since, endedAt, via, searchFrom }),
      },
    });
    if (ended.count === 1) {
      const silence: EndedSilence = {
        accountId,
        workspaceId: current.workspaceId,
        instagramId: current.instagramId,
        username: current.username,
        since,
        endedAt,
        via,
        searchFrom,
      };
      await onMessagingSilenceEnded(silence);
      return silence;
    }
  }
  return null;
}

/** The account fields the webhook route already has from its lookup. */
export interface WebhookAccount {
  id: string;
  instagramId: string;
  messagingSilentSince?: Date | null;
  messagingSilenceCheckAt?: Date | null;
}

/**
 * The webhook route's part: for every account the payload carries an inbound
 * messaging event for, end its silence (or forget its first silent check).
 * Uses the fields of the route's own account lookup, so a webhook costs no
 * query while nothing is open. Never throws: the event is stored either way,
 * and the worker's next check ends the silence with it.
 */
export async function endMessagingSilencesFor(
  payload: Parameters<typeof inboundMessagingAccountIds>[0],
  accounts: readonly WebhookAccount[],
  { at = new Date() }: { at?: Date } = {}
): Promise<number> {
  const inbound = new Set(inboundMessagingAccountIds(payload));
  let ended = 0;
  for (const account of accounts) {
    if (!inbound.has(account.instagramId)) continue;
    if (!account.messagingSilentSince && !account.messagingSilenceCheckAt) continue;
    try {
      if (await endMessagingSilence(account.id, { via: "webhook", at })) ended += 1;
    } catch (error) {
      console.error(
        "[Messaging silence] Could not end a silence at the webhook:",
        describeError(error)
      );
    }
  }
  return ended;
}
