import type { DmStatus, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { hasLegacyUnconfirmedDelivery } from "@/lib/instagram/delivery-errors";

export const MAX_COMMENT_SEND_ATTEMPTS = 3;

/**
 * A DM claim younger than this is a send on its way: the claim is taken right
 * before Instagram is called and settled right after (Node's fetch gives up
 * on a send after five minutes without an answer). An older one belongs to a
 * worker that died between the two: its DM may have gone out, and nothing
 * will ever settle the claim, so it counts as unconfirmed.
 */
export const DM_CLAIM_IN_FLIGHT_MS = 10 * 60_000;

/** The DmLog fields that tell where a campaign's DM for a comment stands. */
export interface DmStateRow {
  status: DmStatus;
  dmDeliveryUnconfirmed: boolean;
  errorMessage: string | null;
  updatedAt: Date;
}

/**
 * Whether the row holds a DM claim that is on its way right now: PENDING,
 * claimed, and claimed (or changed) within DM_CLAIM_IN_FLIGHT_MS.
 */
export function dmClaimInFlight(
  row: Pick<DmStateRow, "status" | "dmDeliveryUnconfirmed" | "updatedAt">,
  now: number = Date.now()
): boolean {
  // A row without its time cannot show that its claim is young: it counts
  // as a DM that may have gone out, the safe side.
  const at = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number.NaN;
  return (
    row.status === "PENDING" &&
    row.dmDeliveryUnconfirmed &&
    now - at < DM_CLAIM_IN_FLIGHT_MS
  );
}

/**
 * Whether a campaign's DmLog row says the comment's private reply is used:
 * the DM went out (SENT), may have gone out (unconfirmed, which a claim in
 * flight is too), or an old worker logged an uncertain Meta answer as a
 * failure. Instagram allows one private reply per comment, so such a row
 * rules out every other DM for the comment.
 */
export function privateReplyTaken(
  row: Pick<DmStateRow, "status" | "dmDeliveryUnconfirmed" | "errorMessage">
): boolean {
  return (
    row.status === "SENT" ||
    row.dmDeliveryUnconfirmed ||
    (row.status === "FAILED" && hasLegacyUnconfirmedDelivery(row.errorMessage))
  );
}

/**
 * How a row that takes the comment's private reply (privateReplyTaken) does
 * so: sent; on its way (a claim in flight, dmClaimInFlight); or unconfirmed
 * (Meta's answer left it open, or the claim is older than a send takes).
 * Null when the row does not take it.
 */
export type PrivateReplyState = "sent" | "sending" | "unconfirmed";

export function privateReplyState(
  row: DmStateRow,
  now: number = Date.now()
): PrivateReplyState | null {
  if (row.status === "SENT") return "sent";
  if (!privateReplyTaken(row)) return null;
  return dmClaimInFlight(row, now) ? "sending" : "unconfirmed";
}

/** Another campaign's row that takes the comment's private reply. */
export interface PrivateReplyRival {
  automationId: string;
  name: string;
  state: PrivateReplyState;
}

// A sent DM before one that may have gone out, before a claim on its way:
// the strongest reason why no other campaign may send.
const STATE_RANK: Record<PrivateReplyState, number> = {
  sent: 0,
  unconfirmed: 1,
  sending: 2,
};

type DmLogReader = Pick<Prisma.TransactionClient, "dmLog">;

/**
 * The other campaign whose row takes this comment's private reply, or null:
 * every campaign of the comment but `automationId`.
 */
export async function findPrivateReplyRival(
  commentId: string,
  automationId: string,
  { db = prisma, now = Date.now() }: { db?: DmLogReader; now?: number } = {}
): Promise<PrivateReplyRival | null> {
  const rows = await db.dmLog.findMany({
    where: { commentId, automationId: { not: automationId } },
    select: {
      automationId: true,
      status: true,
      dmDeliveryUnconfirmed: true,
      errorMessage: true,
      updatedAt: true,
      automation: { select: { name: true } },
    },
  });
  let rival: PrivateReplyRival | null = null;
  for (const row of rows) {
    const state = privateReplyState(row, now);
    if (!state) continue;
    if (!rival || STATE_RANK[state] < STATE_RANK[rival.state]) {
      rival = {
        automationId: row.automationId,
        name: row.automation?.name ?? "unknown",
        state,
      };
    }
  }
  return rival;
}

/** What a DM claim (claimCommentPrivateReply) found. */
export type PrivateReplyClaim =
  /** This campaign's row holds the comment's private reply now. */
  | { claimed: true; rival: null }
  /**
   * Not claimed. With a rival: another campaign's row takes the comment's
   * private reply. Without: this campaign's own row cannot be claimed (its
   * DM went out, another job holds its claim, or its attempts are used up).
   */
  | { claimed: false; rival: PrivateReplyRival | null };

export interface DmClaimOptions {
  /**
   * Written with the claim, in the same statement: the row names what the
   * job that claimed it matched. A manual send from the Kommentare page
   * marks it "(manuell)" exactly when it is the one that claimed it, and an
   * automatic job that claims a row a manual send created writes its own
   * keyword over that label.
   */
  matchedKeyword?: string | null;
  /**
   * Close the campaign's public reply for this comment in the same
   * transaction as the claim (a manual send with "Öffentlich antworten"
   * switched off), with this reason: from the moment the claim can be seen,
   * no other job posts the campaign's public reply. Only a public reply that
   * was neither posted nor tried is closed.
   */
  closePublicReply?: string;
  /**
   * Open a public reply again that was closed with exactly this reason (a
   * later manual send with "Öffentlich antworten" switched on): it was never
   * posted nor tried, so this cannot post it twice.
   */
  reopenPublicReply?: string;
  now?: number;
}

// One lock per comment, for the length of a claim's transaction: every DM
// claim of a comment, whichever campaign and job, takes it first.
function privateReplyLockKey(commentId: string): string {
  return `openreply:private-reply:${commentId}`;
}

/**
 * Claim a campaign's DM for a comment before Instagram is called: the durable,
 * atomic claim that keeps a send that may have reached Instagram from ever
 * being repeated, and the comment at one private reply across campaigns.
 *
 * In one transaction, under a lock on the comment (a Postgres advisory lock,
 * held until the transaction ends): look for another campaign's row that
 * takes the comment's private reply (findPrivateReplyRival), and only without
 * one claim this campaign's row (PENDING, dmDeliveryUnconfirmed, one more
 * attempt). Two jobs that claim the same comment for two campaigns at the
 * same moment are therefore one after the other: the second finds the first
 * one's claim and claims nothing. A transaction's writes become visible
 * together, so the options' public-reply changes are seen with the claim.
 */
export async function claimCommentPrivateReply(
  automationId: string,
  commentId: string,
  {
    matchedKeyword,
    closePublicReply,
    reopenPublicReply,
    now = Date.now(),
  }: DmClaimOptions = {}
): Promise<PrivateReplyClaim> {
  return prisma.$transaction(
    async (tx): Promise<PrivateReplyClaim> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${privateReplyLockKey(commentId)}, 0))`;
      const rival = await findPrivateReplyRival(commentId, automationId, {
        db: tx,
        now,
      });
      if (rival) return { claimed: false, rival };

      const { count } = await tx.dmLog.updateMany({
        where: {
          automationId,
          commentId,
          status: { not: "SENT" },
          dmDeliveryUnconfirmed: false,
          attempts: { lt: MAX_COMMENT_SEND_ATTEMPTS },
        },
        data: {
          dmDeliveryUnconfirmed: true,
          attempts: { increment: 1 },
          status: "PENDING",
          errorMessage: null,
          ...(matchedKeyword !== undefined ? { matchedKeyword } : {}),
        },
      });
      if (count !== 1) return { claimed: false, rival: null };

      if (closePublicReply) {
        await tx.dmLog.updateMany({
          where: {
            automationId,
            commentId,
            publicReplySentAt: null,
            publicReplyDeliveryUnconfirmed: false,
          },
          data: {
            publicReplyDeliveryUnconfirmed: true,
            publicReplyError: closePublicReply,
          },
        });
      } else if (reopenPublicReply) {
        await tx.dmLog.updateMany({
          where: {
            automationId,
            commentId,
            publicReplySentAt: null,
            publicReplyDeliveryUnconfirmed: true,
            publicReplyError: reopenPublicReply,
          },
          data: { publicReplyDeliveryUnconfirmed: false, publicReplyError: null },
        });
      }
      return { claimed: true, rival: null };
    },
    // Short statements only, no call to Meta inside: the wait is for a pool
    // connection while other jobs run.
    { maxWait: 10_000, timeout: 10_000 }
  );
}

// A durable, atomic claim precedes the external side effect. If the process
// crashes or the final log write fails, an uncertain send must not be repeated.
//
// The DM leg is claimed per comment as well (claimCommentPrivateReply); false
// whenever it is not claimed, for whatever reason. `label` is written with the
// DM claim, in the same statement.
export async function claimCommentDelivery(
  automationId: string,
  commentId: string,
  leg: "dm" | "public",
  label?: { matchedKeyword: string },
): Promise<boolean> {
  if (leg === "dm") {
    const claim = await claimCommentPrivateReply(automationId, commentId, {
      matchedKeyword: label?.matchedKeyword,
    });
    return claim.claimed;
  }
  const result = await prisma.dmLog.updateMany({
    where: {
      automationId,
      commentId,
      publicReplySentAt: null,
      publicReplyDeliveryUnconfirmed: false,
    },
    data: { publicReplyDeliveryUnconfirmed: true },
  });
  return result.count === 1;
}

/**
 * Give back the DM claim of a send that never went out, as if it had never
 * been taken: Meta refused it for a request limit, or refused the account
 * while the connection check is looking into it. The row is free to be
 * claimed again, shows `status` (PENDING, the row waits; SKIPPED_DEDUP,
 * another campaign answers the comment) with `errorMessage`, and the try
 * does not count as one of the comment's send attempts.
 *
 * Only the claim itself is given back: a row that is not claimed (or was
 * recorded as sent) stays as it is. False then.
 */
export async function releaseCommentClaim(
  automationId: string,
  commentId: string,
  errorMessage: string,
  status: Extract<DmStatus, "PENDING" | "SKIPPED_DEDUP"> = "PENDING",
): Promise<boolean> {
  const result = await prisma.dmLog.updateMany({
    where: {
      automationId,
      commentId,
      status: { not: "SENT" },
      dmDeliveryUnconfirmed: true,
      attempts: { gt: 0 },
    },
    data: {
      dmDeliveryUnconfirmed: false,
      attempts: { decrement: 1 },
      status,
      errorMessage,
    },
  });
  return result.count === 1;
}
