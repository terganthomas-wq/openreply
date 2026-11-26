/**
 * Manual send ("Manuell senden", M1): the owner sends a campaign's DM for a
 * comment from the Kommentare page, for comments the keywords missed ("kallt",
 * "Guide bitte", the keyword inside a longer word) or that the owner first
 * answered by hand.
 *
 * The page lists the recent comments (GET /api/instagram/comments), the send
 * queues the worker's comment job for exactly the chosen campaign
 * (POST /api/instagram/comments/send, lib/comments/server.ts), and the worker
 * sends it like any comment's DM (processComment, forceAutomationId), with
 * the same claim, so a comment never gets two.
 *
 * Constants and ids only: the page, the API and the worker share them, and
 * nothing here may import server code.
 */

/** What a manual send records as the DmLog's matched keyword. */
export const MANUAL_MATCHED_KEYWORD = "(manuell)";

/**
 * Instagram allows a comment's private reply for 7 days after the comment.
 * The page lists only comments within it, and the send refuses older ones.
 */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Posts the page reads at first, and how many more each "Mehr laden" adds. */
export const COMMENTS_PAGE_POSTS = 15;
/** At most this many posts: 1 media read plus one comment read per post. */
export const COMMENTS_MAX_POSTS = 60;
/** The newest comments read per post: one page, Meta's largest. */
export const COMMENTS_PER_POST = 50;

/** Manual sends a person may queue per minute. */
export const MANUAL_SEND_RATE_LIMIT = 30;

/**
 * Manual sends of one Instagram account go out at least this far apart: a
 * list clicked through quickly is sent one by one, not in a burst.
 */
export const MANUAL_SEND_SPACING_MS = 20_000;

/**
 * Manual sends one Instagram account may queue per MANUAL_SEND_ACCOUNT_WINDOW_MS,
 * whoever clicks. On 2026-11-21 about 25 private replies (with 50 conversation
 * reads) in one hour ran into Meta's app limit, which paused every DM of the
 * account.
 */
export const MANUAL_SEND_ACCOUNT_LIMIT = 15;
export const MANUAL_SEND_ACCOUNT_WINDOW_MS = 60 * 60_000;

/** What a worker that sends manual jobs says in its heartbeat. */
export const MANUAL_SEND_FEATURE = "manual-send";

/**
 * Comment, campaign and Instagram ids as they may appear in a job id:
 * letters, digits, "_" and "-". BullMQ refuses ":" in custom ids, and an id
 * outside this alphabet could make two sends share one.
 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The post count for a request: 15, 30, … up to 60. */
export function commentsPostCount(value: string | null | undefined): number {
  const count = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(count) || count < 1) return COMMENTS_PAGE_POSTS;
  return Math.min(COMMENTS_MAX_POSTS, count);
}

/** Whether a comment of this time is still inside the private-reply window. */
export function withinPrivateReplyWindow(
  timestamp: string | number | Date,
  now: number = Date.now()
): boolean {
  const at =
    timestamp instanceof Date
      ? timestamp.getTime()
      : typeof timestamp === "number"
        ? timestamp
        : Date.parse(timestamp);
  return Number.isFinite(at) && now - at < PRIVATE_REPLY_WINDOW_MS;
}

/**
 * What the manual send's jobs are named after: one comment, one campaign.
 * The worker builds its own copies from it (`<base>_pause_<n>` while the
 * account is paused, `<base>_retry_<n>` for the hourly limit), so they never
 * share an id with the copies of the comment's automatic job, which carry
 * other data.
 */
export function manualSendJobBase({
  instagramId,
  commentId,
  automationId,
}: {
  instagramId: string;
  commentId: string;
  automationId: string;
}): string {
  return `manual_${instagramId}_${commentId}_${automationId}`;
}

/**
 * The manual send's job id: `manual_<ig>_<comment>_<campaign>_<attempts>`,
 * with the send attempts the campaign's DmLog row has for this comment.
 *
 * A double click queues the same id, which BullMQ takes once. A send that
 * Instagram refused counted an attempt, so trying again after a FAILED send
 * gets a new id instead of being swallowed by a job that still waits for a
 * retry. The job is removed as soon as it ends (lib/comments/server.ts), so
 * a finished one never swallows the next click either.
 */
export function manualSendJobId(input: {
  instagramId: string;
  commentId: string;
  automationId: string;
  attempts: number;
}): string {
  return `${manualSendJobBase(input)}_${Math.max(0, Math.floor(input.attempts))}`;
}
