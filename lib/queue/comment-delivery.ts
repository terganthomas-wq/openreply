import type { DmStatus } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { hasLegacyUnconfirmedDelivery } from "@/lib/instagram/delivery-errors";

export const MAX_COMMENT_SEND_ATTEMPTS = 3;

// A durable, atomic claim precedes the external side effect. If the process
// crashes or the final log write fails, an uncertain send must not be repeated.
//
// `label` is written with the DM claim, in the same statement: a manual send
// from the Kommentare page marks the row "(manuell)" exactly when it is the
// one that claimed it, never a row another job claimed or sent.
export async function claimCommentDelivery(
  automationId: string,
  commentId: string,
  leg: "dm" | "public",
  label?: { matchedKeyword: string },
): Promise<boolean> {
  const result = await prisma.dmLog.updateMany({
    where: {
      automationId,
      commentId,
      ...(leg === "dm"
        ? {
            status: { not: "SENT" as const },
            dmDeliveryUnconfirmed: false,
            attempts: { lt: MAX_COMMENT_SEND_ATTEMPTS },
          }
        : { publicReplySentAt: null, publicReplyDeliveryUnconfirmed: false }),
    },
    data:
      leg === "dm"
        ? {
            dmDeliveryUnconfirmed: true,
            attempts: { increment: 1 },
            status: "PENDING",
            errorMessage: null,
            ...(label ? { matchedKeyword: label.matchedKeyword } : {}),
          }
        : { publicReplyDeliveryUnconfirmed: true },
  });
  return result.count === 1;
}

/**
 * Give back the DM claim of a send that never went out, as if it had never
 * been taken: Meta refused it for a request limit, or another campaign took
 * the comment's one private reply in the meantime. The row is free to be
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

/**
 * Whether a campaign's DmLog row says the comment's private reply is used:
 * the DM went out (SENT), may have gone out (unconfirmed, which a claim in
 * flight is too), or an old worker logged an uncertain Meta answer as a
 * failure. Instagram allows one private reply per comment, so such a row
 * rules out every other DM for the comment.
 */
export function privateReplyTaken(row: {
  status: DmStatus;
  dmDeliveryUnconfirmed: boolean;
  errorMessage: string | null;
}): boolean {
  return (
    row.status === "SENT" ||
    row.dmDeliveryUnconfirmed ||
    (row.status === "FAILED" && hasLegacyUnconfirmedDelivery(row.errorMessage))
  );
}
