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

// MANUAL: the owner sent it from the Kommentare page (lib/comments/server.ts).
// RECOVERY: the catch-up after a lost connection queued it
// (lib/instagram/connection-catch-up.ts).
export type CommentSource = "WEBHOOK" | "POLLING" | "MANUAL" | "RECOVERY";

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
  // How often this comment was put back for the account's pause after a Meta
  // request limit (lib/queue/account-pause.ts), capped at MAX_PAUSE_REQUEUES.
  // Its copies are queued as comment_<account>_<comment>_pause_<n>.
  pauseRequeue?: number;
  // How often this comment looked again because another campaign's DM for it
  // was on its way (Instagram allows one private reply per comment): its
  // copies are <job base>_dedup_<n> (lib/queue/dm-worker.ts).
  dedupRecheck?: number;
  // A catch-up job (source RECOVERY): how often it waited because Meta
  // reported 60 % of a request limit, as recover_<account>_<comment>_wait_<n>.
  usageWait?: number;
  // Which path enqueued this comment. It is not copied to ProcessedComment or
  // used for reconciliation dedup.
  source?: CommentSource;
  // A manual send (source MANUAL): exactly this campaign answers, whatever
  // its keywords, its question filter, its post and whether it is active.
  // Every claim and the one private reply per comment hold as for any
  // comment. Its job id and its copies' are manualSendJobId and
  // manualSendJobBase (lib/comments/manual.ts).
  forceAutomationId?: string;
  // With forceAutomationId: whether the public reply goes out, in place of
  // the campaign's own setting (off when the owner already answered in
  // public). Absent: the campaign decides.
  publicReplyOverride?: boolean;
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
  // On a re-check, or a copy queued for the account's pause: when the tap it
  // repeats happened (epoch ms). That tap opened Instagram's messaging
  // window, while the job itself was queued later. Absent on taps and on
  // re-checks queued before it was carried, which fall back to the job's own
  // timestamp.
  tappedAt?: number;
  // On a copy queued for the account's pause: the id the tap had in the job
  // it copies (its mid, or that job's id). The tap's claim and its offer
  // start are keyed on it, so the copy can never count as a new tap.
  tapId?: string;
  // How often this tap was put back for the account's pause after a Meta
  // request limit (lib/queue/account-pause.ts), capped at MAX_PAUSE_REQUEUES.
  pauseRequeue?: number;
  // A2: a tap that a messaging silence swallowed, which the search after it
  // found in the person's conversation (lib/instagram/lost-tap-search.ts):
  // `mid` is the tap's id there and `tappedAt` its time. Before it does
  // anything, the job stands back if the person tapped again or got the link
  // since (lib/instagram/lost-tap-records.ts); its copies for a pause and its
  // follow re-checks carry the flag on but continue the same tap.
  lostTap?: boolean;
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
  // How often the follow-up was put back for the account's pause.
  pauseRequeue?: number;
}

// An inbound DM from a user. Campaigns with `dmTriggerEnabled` whose keywords
// match the text reply to the sender.
export interface ProcessMessageJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  messageId: string;
  messageText: string;
  senderId: string;
  // On a copy queued for the account's pause: when the DM arrived (epoch
  // ms), which opened Instagram's messaging window. The webhook's own job
  // was queued on arrival, so its timestamp is that time.
  receivedAt?: number;
  // How often the DM was put back for the account's pause.
  pauseRequeue?: number;
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
  // How often this message was put back for the account's pause after a
  // Meta request limit, capped at MAX_PAUSE_REQUEUES.
  pauseRequeue?: number;
}

// The catch-up after a lost Instagram connection (A1,
// lib/instagram/connection-catch-up.ts) for one account. Queued when an
// incident ends (by the worker's check or by the reconnect callback), and by
// the worker's sweep for a catch-up still owed. It sends nothing itself: it
// reads the comments of the meantime and queues their comment jobs.
export interface ProcessCatchUpJob {
  // The InstagramAccount row id.
  accountConnectionId: string;
  // The Instagram business id, which recordWorkerFailure reads.
  instagramAccountId: string;
  // Not used: the catch-up keeps its own progress on the account row. Here
  // because code that handles any job reads it.
  pauseRequeue?: number;
}

// The search for lost taps after a messaging silence (A2,
// lib/instagram/lost-tap-search.ts) for one account. Queued when a silence
// ends (at the webhook route or by the worker's check), and by the worker's
// sweep for a search still owed. It sends nothing itself: it reads the
// conversations of the people who got an opening DM in the silence and
// queues the postback job of each tap it finds.
export interface ProcessLostTapSearchJob {
  // The InstagramAccount row id.
  accountConnectionId: string;
  // The Instagram business id, which recordWorkerFailure reads.
  instagramAccountId: string;
  // Not used: the search keeps its own progress on the account row. Here
  // because code that handles any job reads it.
  pauseRequeue?: number;
}

export type DmQueueJob =
  | ProcessCommentJob
  | ProcessPostbackJob
  | ProcessFollowUpJob
  | ProcessMessageJob
  | ProcessOfferJob
  | ProcessCatchUpJob
  | ProcessLostTapSearchJob;

// The worker runs a comment job only under this name (or none at all), so a
// job name it does not know yet is ignored instead of being read as a comment.
export const COMMENT_JOB_NAME = "process-comment";
export const POSTBACK_JOB_NAME = "process-postback";
export const FOLLOWUP_JOB_NAME = "process-followup";
export const MESSAGE_JOB_NAME = "process-message";
export const OFFER_JOB_NAME = "process-offer";
// A worker from before the catch-up ignores this name (dispatchJob), and the
// catch-up stays owed in the database until a newer worker runs it.
export const CATCH_UP_JOB_NAME = "process-catch-up";
// The same holds for the search for lost taps after a messaging silence.
export const LOST_TAP_SEARCH_JOB_NAME = "process-lost-taps";

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
