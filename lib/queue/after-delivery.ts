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
    followUpEnabled: boolean;
    followUpMessage: string | null;
    followUpDelayMinutes: number;
    instagramAccount: { instagramId: string };
  };
  userId: string;
  commenterName: string | null;
  via: LinkDeliveryVia;
}

export async function afterLinkDelivered({
  automation,
  userId,
  commenterName,
  via,
}: LinkDelivery): Promise<void> {
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
}
