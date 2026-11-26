/**
 * The end of a lost-connection incident (A1), shared by the worker's check
 * (lib/instagram/connection-check.ts) and the reconnect callback
 * (app/api/instagram/callback/route.ts).
 *
 * An incident ends with a check that gets through again, or with a
 * reconnect. Its start is not forgotten then: it moves to
 * connectionCatchUpFrom, and the catch-up of the comments missed in the
 * meantime runs in the worker (lib/instagram/connection-catch-up.ts), which
 * onIncidentEnded asks for through the queue.
 *
 * Database and queue only, no Meta or mail import: the web app's callback
 * uses it too.
 */

import { prisma } from "@/lib/db/client";
import { catchUpJobId } from "@/lib/instagram/catch-up-state";
import { CONNECTION_BACK_EVENT } from "@/lib/ops/event-details";
import {
  CATCH_UP_JOB_NAME,
  getDMQueue,
  type ProcessCatchUpJob,
} from "@/lib/queue/client";

/**
 * How far before an incident's start the catch-up of the missed comments
 * looks (A1 catch-up): the time between the last check that got through and
 * the first failed one, plus a margin.
 */
export const CONNECTION_CATCH_UP_MARGIN_MS = 45 * 60_000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** An incident that ended, for the hook below and the caller. */
export interface EndedIncident {
  accountId: string;
  workspaceId: string;
  /** The Instagram business id. */
  instagramId: string;
  username: string;
  /** When the incident began (its connectionLostAt). */
  lostAt: Date;
  recoveredAt: Date;
  /** connectionCatchUpFrom after the end: lostAt, or a still pending earlier start. */
  catchUpFrom: Date;
  via: "check" | "reconnect";
}

// How long a request for the catch-up waits for Redis. The reconnect must
// not hang on it; the worker's sweep asks again for a catch-up still owed.
const QUEUE_TIMEOUT_MS = 5_000;

/**
 * Ask the worker to run the account's catch-up (A1 requirement 5): the job
 * `catchup_<account>_<start>` (catchUpJobId), so the check that ends an
 * incident, the reconnect and the worker's sweep queue it once while it
 * waits or runs. With `runAt`, a delayed job for that time, under its own id:
 * a catch-up that stopped early (an R1 pause, a Meta limit) goes on then.
 * Removed once it ends, so a later request is never swallowed by a finished
 * one. False when it could not be queued; never throws.
 */
export async function queueConnectionCatchUp(
  account: { id: string; instagramId: string },
  from: Date,
  { runAt, now = Date.now() }: { runAt?: number; now?: number } = {}
): Promise<boolean> {
  const data: ProcessCatchUpJob = {
    accountConnectionId: account.id,
    instagramAccountId: account.instagramId,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      getDMQueue().add(CATCH_UP_JOB_NAME, data, {
        jobId: catchUpJobId(account.id, from, runAt),
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
      "[Connection check] Could not queue the catch-up:",
      describeError(error)
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Called once when an incident ends: by the worker when a check gets through
 * again (via "check"), and by the reconnect callback (via "reconnect").
 *
 * The incident's start stays in connectionCatchUpFrom (the earlier one, when
 * a catch-up is still pending), and when it ended in connectionRecoveredAt.
 * This records that the connection is back and asks the worker for the
 * catch-up of the missed comments and the all-clear e-mail
 * (lib/instagram/connection-catch-up.ts), which scan from `catchUpFrom` minus
 * CONNECTION_CATCH_UP_MARGIN_MS and set connectionCatchUpFrom back to null
 * once they have run. Should the request not reach the queue, the worker's
 * next sweep asks again. Never throws.
 */
export async function onIncidentEnded(ended: EndedIncident): Promise<void> {
  const minutes = Math.max(
    1,
    Math.round((ended.recoveredAt.getTime() - ended.lostAt.getTime()) / 60_000)
  );
  try {
    await prisma.operationalEvent.create({
      data: {
        workspaceId: ended.workspaceId,
        source: ended.via === "check" ? "WORKER" : "SYSTEM",
        level: "INFO",
        message: `Instagram connection for @${ended.username} is back after about ${minutes} min (${ended.via === "check" ? "a check got through" : "reconnected"}; lost since ${ended.lostAt.toISOString()})`,
        payload: {
          kind: CONNECTION_BACK_EVENT,
          account: ended.username,
          lostAt: ended.lostAt.toISOString(),
          recoveredAt: ended.recoveredAt.toISOString(),
          catchUpFrom: ended.catchUpFrom.toISOString(),
          via: ended.via,
        },
      },
    });
  } catch (error) {
    console.error(
      "[Connection check] Could not record the end of an incident:",
      describeError(error)
    );
  }
  await queueConnectionCatchUp(
    { id: ended.accountId, instagramId: ended.instagramId },
    ended.catchUpFrom
  );
}

/**
 * End the account's incident, or forget its one lost check: after a check
 * that got through, or a reconnect. The incident's start moves to
 * connectionCatchUpFrom (onIncidentEnded). Reads the row fresh, so a
 * reconnect also ends an incident the worker opened a moment before; tries
 * again when the state changed in between. Returns the ended incident, or
 * null when none was open.
 */
export async function clearConnectionIncident(
  accountId: string,
  { via, now = Date.now() }: { via: EndedIncident["via"]; now?: number }
): Promise<EndedIncident | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await prisma.instagramAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        workspaceId: true,
        instagramId: true,
        username: true,
        connectionLostAt: true,
        connectionCheckFailedAt: true,
        connectionCatchUpFrom: true,
      },
    });
    if (!current) return null;

    const lostAt = current.connectionLostAt;
    if (!lostAt) {
      if (!current.connectionCheckFailedAt) return null;
      const cleared = await prisma.instagramAccount.updateMany({
        where: {
          id: accountId,
          connectionLostAt: null,
          connectionCheckFailedAt: current.connectionCheckFailedAt,
        },
        data: { connectionCheckFailedAt: null },
      });
      if (cleared.count === 1) return null;
      continue;
    }

    const pending = current.connectionCatchUpFrom;
    const catchUpFrom = pending && pending < lostAt ? pending : lostAt;
    const recoveredAt = new Date(now);
    const ended = await prisma.instagramAccount.updateMany({
      where: { id: accountId, connectionLostAt: lostAt },
      data: {
        connectionLostAt: null,
        connectionLostReason: null,
        connectionCheckFailedAt: null,
        connectionAlertCount: 0,
        connectionRecoveredAt: recoveredAt,
        connectionCatchUpFrom: catchUpFrom,
      },
    });
    if (ended.count === 1) {
      const incident: EndedIncident = {
        accountId,
        workspaceId: current.workspaceId,
        instagramId: current.instagramId,
        username: current.username,
        lostAt,
        recoveredAt,
        catchUpFrom,
        via,
      };
      await onIncidentEnded(incident);
      return incident;
    }
  }
  return null;
}
