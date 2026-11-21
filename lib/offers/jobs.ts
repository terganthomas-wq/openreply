/**
 * Queueing offer jobs. Every offer message is its own job, delayed by BullMQ:
 * a job never sleeps, so a worker slot is never held for the seconds between
 * two messages, let alone the hours before a reminder.
 */

import { createHash } from "node:crypto";
import {
  getDMQueue,
  OFFER_JOB_NAME,
  type ProcessOfferJob,
} from "@/lib/queue/client";
import { formatError } from "@/lib/queue/send-helpers";
import { lateStartDelayMs, offerJobId } from "./schedule";

/**
 * Queue one offer job. Its id is deterministic, so a job that is still
 * waiting swallows a second add of the same step.
 *
 * Completed offer jobs are dropped at once. Each offer adds several, and the
 * queue's shared set of the last 1,000 completed jobs is what keeps the
 * deterministic ids of comments and follow-ups from repeating; offer jobs
 * would push those out within minutes. The durable guards of an offer live
 * in the database, not in retained jobs.
 */
export async function enqueueOfferJob(
  data: ProcessOfferJob,
  { jobId, delayMs = 0 }: { jobId: string; delayMs?: number }
): Promise<void> {
  await getDMQueue().add(OFFER_JOB_NAME, data, {
    jobId,
    ...(delayMs > 0 ? { delay: delayMs } : {}),
    removeOnComplete: true,
  });
}

/**
 * Start an offer for a delivered link: pick it, record it, queue its first
 * message. Right away, or with `lateStart` 22 hours after the tap or DM that
 * brought the link (lateStartFireAt), when the campaign starts its offers
 * late. Such a start keeps its time even if the campaign is switched back
 * to starting right away before it runs.
 */
export async function enqueueOfferStart({
  startKey,
  lateStart = false,
  ...start
}: {
  workspaceId: string;
  accountConnectionId: string;
  instagramAccountId: string;
  automationId: string;
  userId: string;
  interactionAt: number;
  startKey: string;
  lateStart?: boolean;
}): Promise<void> {
  // The job id follows the start key, so a repeated start of one trigger is
  // dropped while the first is still queued, for the 22 hours of a late
  // start too. Once that job is done and gone, the stored key
  // (ContactOffer.startKey) keeps a late duplicate from starting a second
  // offer.
  const digest = createHash("sha256").update(startKey).digest("hex");
  await enqueueOfferJob(
    // The flag travels with the job: after the start nothing reads the
    // campaign, and its setting may have changed by then.
    { phase: "start", ...start, startKey, ...(lateStart ? { lateStart } : {}) },
    {
      jobId: offerJobId.start(start.automationId, start.userId, digest),
      delayMs: lateStart ? lateStartDelayMs(start.interactionAt) : 0,
    }
  );
}

/**
 * Remove a waiting offer job, e.g. a reminder that a tap made pointless.
 * Best effort: a job that is gone already, or running, is left alone, and
 * the job itself re-checks the row before it sends.
 */
export async function cancelOfferJob(jobId: string): Promise<void> {
  try {
    await getDMQueue().remove(jobId);
  } catch (error) {
    console.log("[Offers] Could not remove job", jobId, formatError(error));
  }
}
