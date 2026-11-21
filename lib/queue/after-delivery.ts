/**
 * Work that follows a delivered link DM.
 *
 * It used to run inside the send's try block, where any error counted as a
 * failed send: a Redis error while scheduling the follow-up marked a delivered
 * button tap FAILED and unconfirmed, and in the DM keyword trigger it led to a
 * retry that sent the link a second time. Callers therefore run this only after
 * the SENT write and outside their send handling, and it never throws. Each
 * step catches its own errors, so one failing step does not skip the next.
 */

import { addContactTags, ensureContact } from "@/lib/contacts/store";
import { enqueueOfferStart } from "@/lib/offers/jobs";
import { offerStartKey, offerStartsLate } from "@/lib/offers/schedule";
import { FOLLOWUP_JOB_NAME, getDMQueue } from "./client";
import { formatError, logWorkerEvent } from "./send-helpers";

// How the link reached the person. Only a button tap or an inbound DM opens
// Instagram's 24-hour messaging window; the comment's private reply is the one
// message allowed without it, and a read fallback only got through because the
// window happened to be open.
export type LinkDeliveryVia = "private-reply" | "tap" | "read-fallback" | "dm";

// Only the fields read here, so every delivery path can pass the campaign row
// it already loaded.
export interface LinkDelivery {
  automation: {
    id: string;
    workspaceId: string;
    instagramAccountId: string;
    deliveryTag: string | null;
    followUpEnabled: boolean;
    followUpMessage: string | null;
    followUpDelayMinutes: number;
    offersEnabled: boolean;
    offerDelayHours: number;
    instagramAccount: { instagramId: string };
  };
  userId: string;
  commenterName: string | null;
  // The contact the delivery path recorded for this person, or null when that
  // write failed.
  contactId: string | null;
  via: LinkDeliveryVia;
  // When the tap or the DM behind this delivery happened (epoch ms), the start
  // of the messaging window. Null for a private reply and a read fallback,
  // which open no window.
  interactionAt: number | null;
  // What set this delivery off, by the id Instagram gave it: the comment for
  // a private reply, the button tap's mid for a tap (a follow re-check
  // carries the mid of the tap it repeats), the inbound message's mid for a
  // DM. A redelivered webhook, a retried job or a repeated tap with the same
  // mid carries the same id.
  triggerId: string;
}

export async function afterLinkDelivered({
  automation,
  userId,
  commenterName,
  contactId,
  via,
  interactionAt,
  triggerId,
}: LinkDelivery): Promise<void> {
  // The campaign's delivery tag, e.g. "[LM] Guide sent": the person has this
  // campaign's link. It is set on every path that delivers the link, and only
  // after the SENT write, never for an opening DM or a follow prompt. A tag
  // the contact already has keeps the time it was first set.
  const deliveryTag = automation.deliveryTag?.trim();
  if (deliveryTag) {
    try {
      // No contactId means the delivery path's own contact write failed. That
      // one is best effort so it never holds up a DM; the tag needs the row,
      // so it is tried once more here.
      const id =
        contactId ??
        (
          await ensureContact({
            workspaceId: automation.workspaceId,
            instagramAccountId: automation.instagramAccountId,
            igsid: userId,
            username: commenterName,
            interactionAt:
              interactionAt === null ? null : new Date(interactionAt),
          })
        ).id;
      await addContactTags(automation.workspaceId, id, [deliveryTag]);
    } catch (error) {
      console.error(
        "[DM Worker] Failed to tag the contact:",
        formatError(error),
      );
      await logWorkerEvent({
        workspaceId: automation.workspaceId,
        level: "WARNING",
        message: "Delivery tag not added after a delivered link",
        payload: {
          automationId: automation.id,
          userId,
          via,
          tag: deliveryTag,
          error: formatError(error),
        },
      });
    }
  }

  // Optional appreciation follow-up: a short thank-you after the link. It is
  // its own delayed job so it can go out some minutes later
  // (followUpDelayMinutes) rather than immediately, and the deterministic job
  // id collapses repeat taps into one follow-up per person. A private reply
  // does not open the conversation, so no follow-up could be delivered after
  // one.
  try {
    if (
      via !== "private-reply" &&
      automation.followUpEnabled &&
      automation.followUpMessage?.trim()
    ) {
      await getDMQueue().add(
        FOLLOWUP_JOB_NAME,
        {
          instagramAccountId: automation.instagramAccount.instagramId,
          accountConnectionId: automation.instagramAccountId,
          userId,
          automationId: automation.id,
          commenterName,
        },
        {
          delay: Math.max(0, automation.followUpDelayMinutes ?? 0) * 60_000,
          jobId: `followup_${automation.id}_${userId}`,
        },
      );
    }
  } catch (error) {
    console.error(
      "[DM Worker] Failed to schedule the follow-up:",
      formatError(error),
    );
    await logWorkerEvent({
      workspaceId: automation.workspaceId,
      level: "WARNING",
      message: "Follow-up not scheduled after a delivered link",
      payload: {
        automationId: automation.id,
        userId,
        via,
        error: formatError(error),
      },
    });
  }

  // Lead-magnet offers (Weg 2). Instagram lets a business message a person
  // only within 24 hours of the person's last tap or DM, and a comment's
  // private reply is the one message allowed without either. A link that
  // went out as a private reply or a read fallback therefore cannot be
  // followed by an offer: that is skipped and recorded, so the owner sees
  // why. Otherwise a start job picks the offer (lib/offers/worker.ts).
  if (!automation.offersEnabled) return;
  if (
    interactionAt === null ||
    via === "private-reply" ||
    via === "read-fallback"
  ) {
    await logWorkerEvent({
      workspaceId: automation.workspaceId,
      level: "INFO",
      message: "Offer skipped: the link was not delivered after a tap or DM",
      payload: { automationId: automation.id, userId, via },
    });
    return;
  }
  // The start is keyed on the campaign and the trigger: every new tap or DM
  // that brings the link starts the next offer this person has not had, and
  // a repeat of the same trigger starts nothing. Like the follow-up, a lost
  // start is recorded and the delivered link stays SENT. A start lost to a
  // crash right after the delivery stays lost: a second offer for the same
  // trigger would be worse, and the person gets one with their next trigger.
  // A campaign that starts its offers late queues the start 22 hours after
  // the trigger, while Instagram's window is still open.
  try {
    await enqueueOfferStart({
      workspaceId: automation.workspaceId,
      accountConnectionId: automation.instagramAccountId,
      instagramAccountId: automation.instagramAccount.instagramId,
      automationId: automation.id,
      userId,
      interactionAt,
      startKey: offerStartKey(automation.id, via, triggerId),
      lateStart: offerStartsLate(automation.offerDelayHours),
    });
  } catch (error) {
    console.error("[DM Worker] Failed to start the offer:", formatError(error));
    await logWorkerEvent({
      workspaceId: automation.workspaceId,
      level: "WARNING",
      message: "Offer not started after a delivered link",
      payload: {
        automationId: automation.id,
        userId,
        via,
        error: formatError(error),
      },
    });
  }
}
