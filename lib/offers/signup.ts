/**
 * Sign-up feedback from an offer's landing page: recording a reported
 * sign-up.
 *
 * An offer with signupTrackingEnabled forwards a click on its link
 * (/o/<slug>?r=<recipient token>) to its destination with the person's own
 * code added as ig=<code> (lib/offers/signup-token.ts,
 * lib/offers/signup-link.ts). The landing page keeps the code with the
 * pending sign-up and, once the sign-up is confirmed, posts it back
 * (POST /api/offers/signup) with a service key that has signups:write. The
 * first report records the sign-up, signedUpAt and the offer's "signed up"
 * tag in one transaction, and queues the chat confirmation (offer phase
 * "signup", lib/offers/worker.ts) when the offer has one. A later report of
 * the same code changes nothing.
 *
 * Nothing here logs the code: the queued job carries ids only.
 */

import { addContactTags } from "@/lib/contacts/store";
import { prisma } from "@/lib/db/client";
import { formatError } from "@/lib/queue/send-helpers";
import { enqueueOfferJob } from "./jobs";
import { offerJobId } from "./schedule";

/** What a report of a code did. */
export type SignupReport =
  /** No such code in the key's workspace, or its offer reports no sign-ups. */
  | { status: "unknown" }
  /** Reported before: nothing changed. */
  | { status: "alreadyRecorded" }
  /**
   * The first report: the sign-up and its tag are recorded. The chat
   * confirmation was queued, the offer has none, or queueing it failed.
   */
  | { status: "recorded"; confirmation: "queued" | "none" | "failed" };

/**
 * Record the sign-up behind a code the landing page reported. Only codes of
 * the key's workspace count, and only while their offer reports sign-ups.
 * Throws on a database error before anything was recorded.
 */
export async function recordSignup(
  workspaceId: string,
  token: string
): Promise<SignupReport> {
  const row = await prisma.contactOffer.findFirst({
    where: {
      workspaceId,
      signupToken: token,
      offer: { signupTrackingEnabled: true },
    },
    select: {
      id: true,
      contactId: true,
      signedUpAt: true,
      offer: { select: { tagSignedUp: true, signupMessage: true } },
      contact: {
        select: {
          instagramAccountId: true,
          instagramAccount: { select: { instagramId: true } },
        },
      },
    },
  });
  if (!row) return { status: "unknown" };
  if (row.signedUpAt) return { status: "alreadyRecorded" };

  // The time and the tag together: once signedUpAt is set, a later report
  // changes nothing, so a tag that failed after it would never be written.
  const first = await prisma.$transaction(async (tx) => {
    const { count } = await tx.contactOffer.updateMany({
      where: { id: row.id, workspaceId, signedUpAt: null },
      data: { signedUpAt: new Date() },
    });
    if (count === 0) return false;
    await addContactTags(workspaceId, row.contactId, [row.offer.tagSignedUp], tx);
    return true;
  });
  // A report of the same code at the same moment recorded it.
  if (!first) return { status: "alreadyRecorded" };

  // The text is read again when the job runs; empty means the tag alone.
  if (!row.offer.signupMessage?.trim()) {
    return { status: "recorded", confirmation: "none" };
  }
  try {
    await enqueueOfferJob(
      {
        workspaceId,
        accountConnectionId: row.contact.instagramAccountId,
        instagramAccountId: row.contact.instagramAccount.instagramId,
        phase: "signup",
        contactOfferId: row.id,
      },
      { jobId: offerJobId.signup(row.id) }
    );
    return { status: "recorded", confirmation: "queued" };
  } catch (error) {
    // The sign-up and its tag stand; only the chat message is lost, as a
    // later report of the code changes nothing. Diagnostics says so.
    console.error("[Sign-up] Confirmation not queued:", formatError(error));
    await prisma.operationalEvent
      .create({
        data: {
          workspaceId,
          source: "SYSTEM",
          level: "WARNING",
          message: "Sign-up confirmation not queued",
          payload: { contactOfferId: row.id, error: formatError(error) },
        },
      })
      .catch(() => {});
    return { status: "recorded", confirmation: "failed" };
  }
}
