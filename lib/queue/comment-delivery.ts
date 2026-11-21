import { prisma } from "@/lib/db/client";

export const MAX_COMMENT_SEND_ATTEMPTS = 3;

// A durable, atomic claim precedes the external side effect. If the process
// crashes or the final log write fails, an uncertain send must not be repeated.
export async function claimCommentDelivery(
  automationId: string,
  commentId: string,
  leg: "dm" | "public",
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
          }
        : { publicReplyDeliveryUnconfirmed: true },
  });
  return result.count === 1;
}

/**
 * Give back the DM claim of a send that Meta refused for a request limit, as
 * if it had never been taken: the row waits as PENDING with `errorMessage`,
 * free to be claimed again, and the refused try does not count as one of the
 * comment's send attempts. A request limit proves nothing was sent.
 *
 * Only the claim itself is given back: a row that is not claimed (or was
 * recorded as sent) stays as it is. False then.
 */
export async function releaseCommentClaim(
  automationId: string,
  commentId: string,
  errorMessage: string,
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
      status: "PENDING",
      errorMessage,
    },
  });
  return result.count === 1;
}
