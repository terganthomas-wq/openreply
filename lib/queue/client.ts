/**
 * BullMQ Queue Client
 *
 * Provides the DM processing queue and Redis connection for BullMQ.
 */

import { Queue } from "bullmq";
import Redis from "ioredis";

let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // Required by BullMQ
    });
  }
  return connection;
}

// ─── DM Queue ───────────────────────────────────────────────────────────────────

export type CommentSource = "WEBHOOK" | "POLLING";

export interface ProcessCommentJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
  // Set when the comment came from an ad: the organic post the ad was made
  // from. Campaigns are bound to that post, so both ids have to be matched.
  originalMediaId?: string;
  requeueAttempt?: number;
  // Which path enqueued this comment. It is not copied to ProcessedComment or
  // used for reconciliation dedup.
  source?: CommentSource;
}

// Delivered when a user taps an opening DM's button — carries the reveal target.
export interface ProcessPostbackJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  userId: string;
  payload: string;
  mid?: string;
  fallback?: boolean;
  // Set on the delayed second pass of a follow-gate check. Instagram does not
  // report a brand-new follow immediately, so the first `false` is re-checked
  // later instead of rejecting the tap outright.
  followRecheck?: boolean;
  // How many delayed re-checks have run, counting this one. Absent on jobs
  // queued before re-checks were counted, where `followRecheck` meant one.
  followRecheckAttempt?: number;
  // On a re-check: when the tap it repeats happened (epoch ms). That tap
  // opened Instagram's messaging window, while the re-check job itself was
  // queued by the pass before it. Absent on taps and on re-checks queued
  // before it was carried, which fall back to the job's own timestamp.
  tappedAt?: number;
}

// Scheduled after the link is delivered, to send the appreciation follow-up.
// Enqueued with a delay (followUpDelayMinutes) so it can fire later, not just
// immediately.
export interface ProcessFollowUpJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  userId: string;
  automationId: string;
  commenterName?: string | null;
}

// An inbound DM from a user. Campaigns with `dmTriggerEnabled` whose keywords
// match the text reply to the sender.
export interface ProcessMessageJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  messageId: string;
  messageText: string;
  senderId: string;
}

// One step of a lead-magnet offer (lib/offers/worker.ts). "start" picks the
// offer after a delivered link and creates its ContactOffer row; every later
// phase sends one message for that row and queues the next one. "signup" is
// the chat confirmation after the landing page reported the sign-up
// (POST /api/offers/signup, which the web app queues).
export type OfferPhase =
  | "start"
  | "offer"
  | "confirm"
  | "card"
  | "reminder"
  | "signup";

export interface ProcessOfferJob {
  workspaceId: string;
  // The InstagramAccount row id.
  accountConnectionId: string;
  // The Instagram business id, which recordWorkerFailure reads.
  instagramAccountId: string;
  phase: OfferPhase;
  // start: the campaign whose link was delivered, the recipient's IGSID and
  // when the tap or DM behind the delivery happened (epoch ms).
  automationId?: string;
  userId?: string;
  interactionAt?: number;
  // start: the campaign plus the trigger behind the delivery (ContactOffer
  // .startKey). Every new trigger starts the next offer; a repeat of the
  // same trigger starts nothing.
  startKey?: string;
  // start: queued to run 22 hours after the delivery (the campaign's
  // offerDelayHours when its link went out). The ContactOffer row records it
  // and gets no reminder. Absent on starts that run right away.
  lateStart?: boolean;
  // Every other phase: the ContactOffer row.
  contactOfferId?: string;
  // offer, confirm: the index of the message.
  step?: number;
}

export type DmQueueJob =
  | ProcessCommentJob
  | ProcessPostbackJob
  | ProcessFollowUpJob
  | ProcessMessageJob
  | ProcessOfferJob;

// The worker runs a comment job only under this name (or none at all), so a
// job name it does not know yet is ignored instead of being read as a comment.
export const COMMENT_JOB_NAME = "process-comment";
export const POSTBACK_JOB_NAME = "process-postback";
export const FOLLOWUP_JOB_NAME = "process-followup";
export const MESSAGE_JOB_NAME = "process-message";
export const OFFER_JOB_NAME = "process-offer";

let dmQueue: Queue<DmQueueJob> | null = null;

export function getDMQueue(): Queue<DmQueueJob> {
  if (!dmQueue) {
    dmQueue = new Queue<DmQueueJob>("dm-processing", {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 }, // Keep last 1000 completed jobs
        // Clear failed jobs shortly after they exhaust retries. Job ids are
        // deterministic (comment_<acct>_<id>), so a retained failed job would
        // block the polling reconciler from ever retrying that comment. Clearing
        // them lets a later sweep re-enqueue and try again once a transient
        // failure (e.g. an Instagram rate-limit window) has passed. Failure
        // detail is still preserved in DmLog.
        removeOnFail: { age: 300, count: 2000 },
        attempts: 3,
        backoff: {
          type: "custom",
        },
      },
    });
  }
  return dmQueue;
}
