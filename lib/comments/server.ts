/**
 * The Kommentare page's server side (M1): read the recent comments, show
 * where each comment's DM stands, and queue a manual send.
 *
 * Meta's request limits cost real time here (on 2026-11-21 about 25 private
 * replies and 50 conversation reads in an hour stopped every call), so every
 * read is counted and cached:
 * - A page view reads the account's newest posts (one media read) and one
 *   page of each post's newest comments (one read per post), five at a time.
 *   Each read is kept in Redis for 60 seconds per account, so a reload, a
 *   second tab or "Mehr laden" read only what is not cached yet. Nothing is
 *   read in the background.
 * - While the account's sending is paused for a Meta limit
 *   (lib/queue/account-pause.ts) the page reads nothing at all and shows the
 *   pause. A limit on a read itself stops the remaining reads.
 * - A manual send reads the one comment it sends for (and the posts, unless
 *   they are cached) and queues the worker's comment job; the DM itself is
 *   sent by the worker, with every claim of a comment's DM (dm-worker.ts).
 */

import type { DmStatus, Prisma } from "@/app/generated/prisma/client";
import { campaignForComment } from "@/lib/automation/comment-match";
import { isQuestionComment } from "@/lib/automation/question-filter";
import { prisma } from "@/lib/db/client";
import { isMetaThrottle } from "@/lib/instagram/delivery-errors";
import {
  createInstagramContext,
  type InstagramContext,
  type ProviderAccount,
} from "@/lib/instagram/context";
import {
  getAllUserMedia,
  getComment,
  getLatestMediaComments,
  PermissionError,
  type InstagramComment,
} from "@/lib/meta/client";
import { checkAccountPause } from "@/lib/queue/account-pause";
import {
  COMMENT_JOB_NAME,
  getDMQueue,
  getRedisConnection,
  type ProcessCommentJob,
} from "@/lib/queue/client";
import {
  MAX_COMMENT_SEND_ATTEMPTS,
  privateReplyTaken,
} from "@/lib/queue/comment-delivery";
import { runningWorkerLacks } from "@/lib/ops/worker-health";
import {
  COMMENTS_MAX_POSTS,
  COMMENTS_PER_POST,
  MANUAL_MATCHED_KEYWORD,
  MANUAL_SEND_FEATURE,
  MANUAL_SEND_RATE_LIMIT,
  manualSendJobId,
  withinPrivateReplyWindow,
} from "./manual";
import type {
  CampaignOption,
  CommentDelivery,
  CommentLog,
  CommentRow,
  CommentsPageData,
  CommentStatus,
} from "./view";

/** How long a read of the posts or of a post's comments is reused. */
export const COMMENTS_CACHE_TTL_MS = 60_000;
// Comment reads at once: quick, without a burst of 15 parallel calls.
const READ_CONCURRENCY = 5;
// A cache that does not answer is skipped, never waited for.
const CACHE_TIMEOUT_MS = 1_500;
// The worker's error text a row shows, at most.
const ERROR_MESSAGE_MAX = 300;

/** The account as the comment reads and the send need it. */
export type CommentsAccount = ProviderAccount & {
  id: string;
  username: string;
};

// ─── Cache ─────────────────────────────────────────────────────────────────

interface CachedMedia {
  id: string;
  permalink: string | null;
}

interface CachedComment {
  id: string;
  text: string;
  timestamp: string;
  authorId: string | null;
  username: string | null;
  ownerReplied: boolean;
}

export function commentsMediaCacheKey(accountId: string): string {
  return `comments:media:${accountId}`;
}

export function commentsListCacheKey(accountId: string, mediaId: string): string {
  return `comments:list:${accountId}:${mediaId}`;
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("cache timeout")), CACHE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await withTimeout(getRedisConnection().get(key));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    await withTimeout(
      getRedisConnection().set(key, JSON.stringify(value), "PX", COMMENTS_CACHE_TTL_MS)
    );
  } catch {
    // Best effort: the next view reads Meta again.
  }
}

// ─── Reading ───────────────────────────────────────────────────────────────

function metaContext(context: InstagramContext): Extract<InstagramContext, { provider: "META" }> {
  if (context.provider !== "META") {
    throw new Error("Manual sending needs an account connected through Meta");
  }
  return context;
}

/** The account's newest posts, cached; at least `posts` of them if it has them. */
async function readMedia(
  account: CommentsAccount,
  context: Extract<InstagramContext, { provider: "META" }>,
  posts: number
): Promise<CachedMedia[]> {
  const key = commentsMediaCacheKey(account.id);
  const cached = await cacheGet<{ count: number; media: CachedMedia[] }>(key);
  if (cached && cached.count >= posts) return cached.media.slice(0, posts);

  const media = (await getAllUserMedia(context, posts, account.instagramId)).map(
    (item) => ({ id: item.id, permalink: item.permalink ?? null })
  );
  await cacheSet(key, { count: posts, media });
  return media;
}

function toCachedComment(
  comment: InstagramComment,
  account: CommentsAccount
): CachedComment {
  return {
    id: comment.id,
    text: comment.text ?? "",
    timestamp: comment.timestamp,
    authorId: comment.from?.id ?? null,
    username: comment.from?.username ?? null,
    ownerReplied: (comment.replies?.data ?? []).some(
      (reply) => reply.from?.id === account.instagramId
    ),
  };
}

function isOwnComment(
  author: { id?: string | null; username?: string | null },
  account: { instagramId: string; username: string }
): boolean {
  return (
    author.id === account.instagramId ||
    (Boolean(author.username) &&
      author.username!.toLowerCase() === account.username.toLowerCase())
  );
}

interface CommentReads {
  comments: (CachedComment & { mediaId: string; permalink: string | null })[];
  hasMore: boolean;
  readLimited: boolean;
  failedPosts: number;
}

async function readRecentComments(
  account: CommentsAccount,
  context: Extract<InstagramContext, { provider: "META" }>,
  posts: number
): Promise<CommentReads> {
  let media: CachedMedia[];
  try {
    media = await readMedia(account, context, posts);
  } catch (error) {
    if (isMetaThrottle(error)) {
      return { comments: [], hasMore: false, readLimited: true, failedPosts: 0 };
    }
    throw error;
  }

  const lists = new Map<string, CachedComment[]>();
  const cached = await Promise.all(
    media.map((item) =>
      cacheGet<CachedComment[]>(commentsListCacheKey(account.id, item.id))
    )
  );
  media.forEach((item, index) => {
    const list = cached[index];
    if (list) lists.set(item.id, list);
  });

  let readLimited = false;
  let failedPosts = 0;
  const missing = media.filter((item) => !lists.has(item.id));
  for (let start = 0; start < missing.length && !readLimited; start += READ_CONCURRENCY) {
    const batch = missing.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((item) =>
        getLatestMediaComments(context, item.id, COMMENTS_PER_POST)
      )
    );
    await Promise.all(
      results.map(async (result, index) => {
        const item = batch[index];
        if (result.status === "fulfilled") {
          const list = result.value.map((comment) => toCachedComment(comment, account));
          lists.set(item.id, list);
          await cacheSet(commentsListCacheKey(account.id, item.id), list);
        } else if (isMetaThrottle(result.reason)) {
          // Every further read would be refused as well.
          readLimited = true;
        } else {
          failedPosts += 1;
          console.error(
            "[Comments] Could not read the comments of a post:",
            result.reason instanceof Error ? result.reason.message : "unknown error"
          );
        }
      })
    );
  }

  return {
    comments: media.flatMap((item) =>
      (lists.get(item.id) ?? []).map((comment) => ({
        ...comment,
        mediaId: item.id,
        permalink: item.permalink,
      }))
    ),
    hasMore: media.length >= posts && posts < COMMENTS_MAX_POSTS,
    readLimited,
    failedPosts,
  };
}

// ─── DmLog ─────────────────────────────────────────────────────────────────

const LOG_SELECT = {
  commentId: true,
  automationId: true,
  status: true,
  attempts: true,
  dmDeliveryUnconfirmed: true,
  errorMessage: true,
  matchedKeyword: true,
  updatedAt: true,
  automation: { select: { name: true } },
} satisfies Prisma.DmLogSelect;

type LogRow = Prisma.DmLogGetPayload<{ select: typeof LOG_SELECT }>;

function deliveryState(row: {
  status: DmStatus;
}): CommentDelivery["state"] {
  if (row.status === "SENT") return "sent";
  return row.status === "PENDING" ? "sending" : "unconfirmed";
}

/** Where a comment's DM stands, from its DmLog rows (one per campaign). */
export function commentStatus(rows: LogRow[]): CommentStatus {
  // A sent DM before one that may have gone out, before a claim in flight.
  const taken = rows
    .filter(privateReplyTaken)
    .sort((a, b) => rank(a.status) - rank(b.status));
  const delivered = taken[0];
  return {
    delivery: delivered
      ? {
          state: deliveryState(delivered),
          campaignId: delivered.automationId,
          campaignName: delivered.automation?.name ?? "",
          manual: delivered.matchedKeyword === MANUAL_MATCHED_KEYWORD,
        }
      : null,
    logs: rows.map(
      (row): CommentLog => ({
        automationId: row.automationId,
        campaignName: row.automation?.name ?? "",
        status: row.status,
        exhausted: row.attempts >= MAX_COMMENT_SEND_ATTEMPTS,
        errorMessage: row.errorMessage
          ? row.errorMessage.slice(0, ERROR_MESSAGE_MAX)
          : null,
        updatedAt: row.updatedAt.toISOString(),
        manual: row.matchedKeyword === MANUAL_MATCHED_KEYWORD,
      })
    ),
  };
}

function rank(status: DmStatus): number {
  return status === "SENT" ? 0 : status === "PENDING" ? 2 : 1;
}

async function logsByComment(
  workspaceId: string,
  accountId: string,
  commentIds: string[]
): Promise<Map<string, LogRow[]>> {
  const byComment = new Map<string, LogRow[]>();
  if (commentIds.length === 0) return byComment;
  const rows = await prisma.dmLog.findMany({
    where: { workspaceId, instagramAccountId: accountId, commentId: { in: commentIds } },
    select: LOG_SELECT,
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    const list = byComment.get(row.commentId) ?? [];
    list.push(row);
    byComment.set(row.commentId, list);
  }
  return byComment;
}

/** A poll after a send: where these comments' DMs stand, from the database only. */
export async function loadCommentStatuses({
  workspaceId,
  accountId,
  commentIds,
}: {
  workspaceId: string;
  accountId: string;
  commentIds: string[];
}): Promise<Record<string, CommentStatus>> {
  const byComment = await logsByComment(workspaceId, accountId, commentIds);
  return Object.fromEntries(
    commentIds.map((id) => [id, commentStatus(byComment.get(id) ?? [])])
  );
}

// ─── The page ──────────────────────────────────────────────────────────────

const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  isActive: true,
  postId: true,
  matchAnyPost: true,
  keywords: true,
  matchAnyWord: true,
  wholeWordMatch: true,
  ignoreQuestionComments: true,
  dmMessage: true,
  publicReplyMessage: true,
  publicReplyMessages: true,
} satisfies Prisma.AutomationSelect;

type CampaignRow = Prisma.AutomationGetPayload<{ select: typeof CAMPAIGN_SELECT }>;

function hasPublicReply(campaign: {
  publicReplyMessage: string | null;
  publicReplyMessages: string[];
}): boolean {
  return (
    campaign.publicReplyMessages.some((text) => text.trim() !== "") ||
    Boolean(campaign.publicReplyMessage?.trim())
  );
}

/** The account's campaigns with a DM text, oldest first (the worker's order). */
async function commentCampaigns(
  workspaceId: string,
  accountId: string
): Promise<CampaignRow[]> {
  const campaigns = await prisma.automation.findMany({
    where: { workspaceId, instagramAccountId: accountId },
    select: CAMPAIGN_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return campaigns.filter((campaign) => campaign.dmMessage.trim() !== "");
}

function campaignOption(campaign: CampaignRow): CampaignOption {
  return {
    id: campaign.id,
    name: campaign.name,
    isActive: campaign.isActive,
    hasPublicReply: hasPublicReply(campaign),
  };
}

/**
 * The page: the comments of the account's newest `posts` posts within the 7
 * days, newest first, never the account's own, each with where its DM stands
 * and the campaign that would answer it on its own. While the account is
 * paused for a Meta limit: the pause, and no read at all.
 */
export async function loadCommentsPage({
  workspaceId,
  account,
  posts,
  now = Date.now(),
}: {
  workspaceId: string;
  account: CommentsAccount;
  posts: number;
  now?: number;
}): Promise<CommentsPageData> {
  const [pausedUntil, campaigns] = await Promise.all([
    checkAccountPause(account.instagramId, now),
    commentCampaigns(workspaceId, account.id),
  ]);
  const base = {
    account: { id: account.id, username: account.username },
    pausedUntil: pausedUntil === null ? null : new Date(pausedUntil).toISOString(),
    campaigns: campaigns.map(campaignOption),
    posts,
    generatedAt: new Date(now).toISOString(),
  };
  if (pausedUntil !== null) {
    return { ...base, comments: [], hasMore: false, readLimited: false, failedPosts: 0 };
  }

  const context = metaContext(await createInstagramContext(account));
  const reads = await readRecentComments(account, context, posts);
  const visible = reads.comments
    .filter(
      (comment) =>
        comment.authorId !== null &&
        !isOwnComment({ id: comment.authorId, username: comment.username }, account) &&
        withinPrivateReplyWindow(comment.timestamp, now)
    )
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const logs = await logsByComment(
    workspaceId,
    account.id,
    visible.map((comment) => comment.id)
  );

  const comments = visible.map((comment): CommentRow => {
    const match = campaignForComment(campaigns, {
      text: comment.text,
      mediaId: comment.mediaId,
    });
    return {
      id: comment.id,
      text: comment.text,
      timestamp: new Date(Date.parse(comment.timestamp)).toISOString(),
      username: comment.username,
      mediaId: comment.mediaId,
      permalink: comment.permalink,
      ownerReplied: comment.ownerReplied,
      question: isQuestionComment(comment.text),
      match: match ? { id: match.campaign.id, name: match.campaign.name } : null,
      ...commentStatus(logs.get(comment.id) ?? []),
    };
  });

  return {
    ...base,
    comments,
    hasMore: reads.hasMore,
    readLimited: reads.readLimited,
    failedPosts: reads.failedPosts,
  };
}

// ─── Sending ───────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const RATE_SCRIPT =
  'local n = redis.call("INCR", KEYS[1]) if n == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end return n';

/**
 * One manual send for this person: at most MANUAL_SEND_RATE_LIMIT a minute.
 * False when the minute's sends are used up. Throws when Redis cannot be
 * asked: nothing could be queued then anyway.
 */
export async function takeManualSendSlot(userId: string): Promise<boolean> {
  const count = Number(
    await getRedisConnection().eval(
      RATE_SCRIPT,
      1,
      `manual-send:rate:${userId}`,
      String(RATE_WINDOW_MS)
    )
  );
  return count <= MANUAL_SEND_RATE_LIMIT;
}

export type ManualSendReason =
  | "campaign_not_found"
  | "not_comment_campaign"
  | "provider"
  | "worker_outdated"
  | "paused"
  | "already_sent"
  | "attempts_used"
  | "comment_not_found"
  | "own_comment"
  | "too_old"
  | "foreign_media"
  | "instagram_limit"
  | "instagram_error";

export type ManualSendResult =
  | { ok: true; queuedAt: string; previousUpdatedAt: string | null; jobId: string }
  | {
      ok: false;
      status: number;
      reason: ManualSendReason;
      error: string;
      pausedUntil?: string;
      /** For already_sent: where the comment's DM stands. */
      commentStatus?: CommentStatus;
    };

function refuse(
  status: number,
  reason: ManualSendReason,
  error: string,
  extra: { pausedUntil?: string; commentStatus?: CommentStatus } = {}
): ManualSendResult {
  return { ok: false, status, reason, error, ...extra };
}

/** Whether the media is one of the account's newest posts (cached, or one read). */
async function isAccountMedia(
  account: CommentsAccount,
  context: Extract<InstagramContext, { provider: "META" }>,
  mediaId: string
): Promise<boolean> {
  const cached = await cacheGet<{ count: number; media: CachedMedia[] }>(
    commentsMediaCacheKey(account.id)
  );
  if (cached?.media.some((item) => item.id === mediaId)) return true;
  const media = await getAllUserMedia(context, COMMENTS_MAX_POSTS, account.instagramId);
  return media.some((item) => item.id === mediaId);
}

/**
 * Queue a campaign's DM for one comment, sent by hand from the Kommentare
 * page. Checked first, cheapest first, and nothing queued unless all hold:
 * - the campaign belongs to the workspace, has a DM text, and its account is
 *   connected through Meta;
 * - the running worker knows manual sends (an older one would read the job
 *   as an ordinary comment and answer it with whichever campaign matches);
 * - the account is not paused for a Meta limit (then Meta is not asked);
 * - no campaign's DM for this comment went out, may have, or is on its way,
 *   and the chosen campaign has attempts left for it;
 * - Instagram still has the comment, it is not the account's own, it is
 *   within the 7 days, and it is under one of the account's newest posts.
 * Then the worker's comment job is queued for exactly this campaign. The
 * worker checks again before it sends, under the comment's claim.
 */
export async function sendCommentManually({
  workspaceId,
  commentId,
  automationId,
  publicReply,
  now = Date.now(),
}: {
  workspaceId: string;
  commentId: string;
  automationId: string;
  publicReply: boolean;
  now?: number;
}): Promise<ManualSendResult> {
  const campaign = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
    select: {
      id: true,
      dmMessage: true,
      instagramAccount: {
        select: {
          id: true,
          workspaceId: true,
          instagramId: true,
          username: true,
          provider: true,
          metaLogin: true,
          accessToken: true,
          zernioAccountId: true,
        },
      },
    },
  });
  if (!campaign || campaign.instagramAccount.workspaceId !== workspaceId) {
    return refuse(404, "campaign_not_found", "Campaign not found");
  }
  if (campaign.dmMessage.trim() === "") {
    return refuse(400, "not_comment_campaign", "This campaign has no DM text");
  }
  const account = campaign.instagramAccount;
  if (account.provider !== "META") {
    return refuse(
      400,
      "provider",
      "Manual sending needs an account connected through your own Meta app"
    );
  }

  if (await runningWorkerLacks(MANUAL_SEND_FEATURE)) {
    return refuse(
      409,
      "worker_outdated",
      "The running worker does not know manual sends yet; update it first"
    );
  }

  const pausedUntil = await checkAccountPause(account.instagramId, now);
  if (pausedUntil !== null) {
    return refuse(409, "paused", "Sending is paused for an Instagram limit", {
      pausedUntil: new Date(pausedUntil).toISOString(),
    });
  }

  const rows = await prisma.dmLog.findMany({
    where: { workspaceId, instagramAccountId: account.id, commentId },
    select: LOG_SELECT,
    orderBy: { createdAt: "asc" },
  });
  if (rows.some(privateReplyTaken)) {
    return refuse(
      409,
      "already_sent",
      "A DM for this comment already went out; Instagram allows one per comment",
      { commentStatus: commentStatus(rows) }
    );
  }
  const own = rows.find((row) => row.automationId === campaign.id);
  if (own && own.attempts >= MAX_COMMENT_SEND_ATTEMPTS) {
    return refuse(
      409,
      "attempts_used",
      "Instagram refused this campaign's DM for the comment three times"
    );
  }

  const context = metaContext(await createInstagramContext(account));
  let comment;
  try {
    comment = await getComment(context, commentId);
    if (!comment.media?.id) {
      return refuse(404, "comment_not_found", "Instagram does not find this comment");
    }
    if (!(await isAccountMedia(account, context, comment.media.id))) {
      return refuse(
        404,
        "foreign_media",
        "This comment is not under one of the account's newest posts"
      );
    }
  } catch (error) {
    if (isMetaThrottle(error)) {
      return refuse(503, "instagram_limit", "Instagram request limit reached");
    }
    // Meta answers a comment that is gone, or that is not the account's to
    // read, with a permission error (code 10, 100 or 200).
    if (error instanceof PermissionError) {
      return refuse(404, "comment_not_found", "Instagram does not find this comment");
    }
    console.error(
      "[Comments] Could not read the comment for a manual send:",
      error instanceof Error ? error.message : "unknown error"
    );
    return refuse(502, "instagram_error", "Could not read the comment from Instagram");
  }
  if (!comment.from?.id) {
    return refuse(404, "comment_not_found", "Instagram does not find this comment");
  }
  if (isOwnComment(comment.from, account)) {
    return refuse(409, "own_comment", "This is the account's own comment");
  }
  if (!comment.timestamp || !withinPrivateReplyWindow(comment.timestamp, now)) {
    return refuse(
      409,
      "too_old",
      "Instagram allows a DM only within 7 days of the comment"
    );
  }

  const jobId = manualSendJobId({
    instagramId: account.instagramId,
    commentId,
    automationId: campaign.id,
    attempts: own?.attempts ?? 0,
  });
  const data: ProcessCommentJob = {
    instagramAccountId: account.instagramId,
    accountConnectionId: account.id,
    commentId,
    commentText: comment.text ?? "",
    commenterId: comment.from.id,
    commenterName: comment.from.username,
    mediaId: comment.media.id,
    source: "MANUAL",
    forceAutomationId: campaign.id,
    publicReplyOverride: publicReply,
  };
  // Removed once it ends, done or failed: a finished job would swallow the
  // next click with the same id. While it waits or runs, the same id is
  // taken once, so a double click queues one job.
  await getDMQueue().add(COMMENT_JOB_NAME, data, {
    jobId,
    removeOnComplete: true,
    removeOnFail: true,
  });

  return {
    ok: true,
    jobId,
    queuedAt: new Date(now).toISOString(),
    previousUpdatedAt: own ? own.updatedAt.toISOString() : null,
  };
}
