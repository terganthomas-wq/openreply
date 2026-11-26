/**
 * The end of a lost-connection incident (A1), shared by the worker's check
 * (lib/instagram/connection-check.ts) and the reconnect callback
 * (app/api/instagram/callback/route.ts).
 *
 * An incident ends with a check that gets through again, or with a
 * reconnect. Its start is not forgotten then: it moves to
 * connectionCatchUpFrom, where the catch-up of the comments missed in the
 * meantime finds it (onIncidentEnded).
 *
 * Database only, no Meta, queue or mail import: the web app's callback uses
 * it too.
 */

import { prisma } from "@/lib/db/client";
import { CONNECTION_BACK_EVENT } from "@/lib/ops/event-details";

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
  username: string;
  /** When the incident began (its connectionLostAt). */
  lostAt: Date;
  recoveredAt: Date;
  /** connectionCatchUpFrom after the end: lostAt, or a still pending earlier start. */
  catchUpFrom: Date;
  via: "check" | "reconnect";
}

/**
 * Called once when an incident ends: by the worker when a check gets through
 * again (via "check"), and by the reconnect callback (via "reconnect").
 *
 * The incident's start stays in connectionCatchUpFrom (the earlier one, when
 * a catch-up is still pending), and when it ended in connectionRecoveredAt.
 * Hook for the catch-up of the missed comments (A1 requirement 5) and the
 * all-clear e-mail (6): they start here, scan the comments created since
 * `catchUpFrom` minus CONNECTION_CATCH_UP_MARGIN_MS (in the worker, so a
 * reconnect queues it), and set connectionCatchUpFrom back to null once the
 * catch-up has run. Until they exist the hook only records that the
 * connection is back, and the regular sweep finds the comments of its
 * lookback as before.
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
