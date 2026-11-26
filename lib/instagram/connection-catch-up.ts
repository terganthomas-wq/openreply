/**
 * The catch-up after a lost Instagram connection (A1 requirement 5).
 *
 * While Meta refused the account, no webhook arrived and the sweep's reads
 * failed: keyword comments of that time got no DM. When the incident ends (a
 * check gets through, or the owner reconnects: lib/instagram/connection-state.ts)
 * the worker runs this once for the incident, as the queue job
 * `catchup_<account>_<start>`:
 *
 * - It reads the account's posts (/media, newest first, at most 300; a
 *   campaign's own post and its ads too, should they be older) and, for every
 *   post an active campaign covers and that has comments, the comments
 *   newest first, page by page (50 each, at most 500 pages in all) until they
 *   are older than the incident's start minus 45 minutes
 *   (CONNECTION_CATCH_UP_MARGIN_MS). Whatever the caps or a failed read left
 *   out is logged, and the all-clear says so.
 * - A comment is queued when it was made since then and inside Instagram's 7
 *   days for a private reply, is not the account's own, matches an active
 *   campaign as the sweep and the worker match (keywords, whole word, the
 *   question filter, a campaign bound to the post before an any-post one:
 *   campaignForComment) and has no DmLog row. As the ordinary comment job
 *   `recover_<ig>_<comment>` (source RECOVERY), oldest first, one every 20
 *   seconds, the first right away: a long outage never bursts into Meta's
 *   limit. Every claim of processComment holds for it as for any comment.
 * - A matching comment the owner already answered by hand gets no DM (the
 *   owner may have sent the guide by hand). It is listed in the all-clear
 *   e-mail and in Diagnostics with author, text, time and the post's link.
 *
 * Exactly once per incident: the job id is the same for every request (the
 * check, the reconnect, the worker's sweep), the run holds a lease on the
 * account row (connectionCatchUpClaimedAt, renewed while it reads), and its
 * end is one conditional update that sets connectionCatchUpFrom back to null
 * with the result. A comment queued twice still gets one job (the id), and
 * one DM (the worker's claim).
 *
 * Meta's limits: nothing is read while the account is paused (R1,
 * lib/queue/account-pause.ts). A pause, a request limit on a read, Meta
 * reporting 60 % of a limit, or a worker shutting down stops the run where it
 * is: how far it got is kept (connectionCatchUpProgress) and a job for later
 * goes on from there. The reads are two seconds apart. After 24 hours of
 * trying it ends with what it has.
 *
 * Then the all-clear e-mail (lib/ops/connection-all-clear.ts).
 */

import { Prisma } from "@/app/generated/prisma/client";
import { campaignForComment } from "@/lib/automation/comment-match";
import { SAFE_ID_PATTERN, withinPrivateReplyWindow, PRIVATE_REPLY_WINDOW_MS } from "@/lib/comments/manual";
import { prisma } from "@/lib/db/client";
import {
  CATCH_UP_MAX_COMMENT_PAGES,
  CATCH_UP_MAX_LISTED,
  CATCH_UP_MAX_POSTS,
  CATCH_UP_SPACING_MS,
  catchUpComplete,
  catchUpJobId,
  EMPTY_SKIPPED,
  readCatchUpProgress,
  safePermalink,
  skippedPosts,
  type CatchUpPost,
  type CatchUpProgress,
  type CatchUpResult,
} from "@/lib/instagram/catch-up-state";
import { classifyConnectionError } from "@/lib/instagram/connection-check";
import {
  CONNECTION_CATCH_UP_MARGIN_MS,
  queueConnectionCatchUp,
} from "@/lib/instagram/connection-state";
import { createInstagramContext, type InstagramContext } from "@/lib/instagram/context";
import { isMetaThrottle, throttlePauseMs } from "@/lib/instagram/delivery-errors";
import {
  getMediaCommentsPage,
  getUserMediaPage,
  type InstagramComment,
  type InstagramMediaSummary,
} from "@/lib/meta/client";
import { DEFAULT_THROTTLE_PAUSE_MINUTES } from "@/lib/meta/limits";
import { accountUsagePercent, latestMetaUsage } from "@/lib/meta/usage";
import { sendConnectionAllClear } from "@/lib/ops/connection-all-clear";
import { CONNECTION_CATCH_UP_EVENT } from "@/lib/ops/event-details";
import type { MailTransport } from "@/lib/ops/mail";
import { adMediaFor } from "@/lib/polling/comment-reconciler";
import { checkAccountPause, formatPauseTime, pausedRunAt } from "@/lib/queue/account-pause";
import { COMMENT_JOB_NAME, getDMQueue, type ProcessCommentJob } from "@/lib/queue/client";
import { formatError, logWorkerEvent } from "@/lib/queue/send-helpers";

/** A run's lease on the account row; another run takes over once it is this old. */
export const CATCH_UP_LEASE_MS = 10 * 60_000;
// The lease is renewed when a third of it has passed.
const LEASE_RENEW_MS = CATCH_UP_LEASE_MS / 3;
/** The time between two reads of a run. */
export const CATCH_UP_READ_GAP_MS = 2_000;
/** From this share of a Meta limit (percent) on, a run stops and goes on later. */
export const CATCH_UP_USAGE_BRAKE_PERCENT = 60;
/** How long a run that stopped for the usage brake waits. */
export const CATCH_UP_BRAKE_WAIT_MS = 15 * 60_000;
/** How long a run that stopped for an error, or for a refused account, waits. */
export const CATCH_UP_RETRY_MS = 30 * 60_000;
/** How long a run that stopped for a worker shutdown waits. */
const SHUTDOWN_WAIT_MS = 60_000;
/** After this long since its first run, a catch-up ends with what it has. */
export const CATCH_UP_GIVE_UP_MS = 24 * 60 * 60_000;
/** Comment jobs one catch-up queues at most: about five and a half hours of DMs. */
export const CATCH_UP_MAX_QUEUED = 1_000;
// Ids kept for the owner's answered comments, beyond the listed ones.
const MAX_ANSWERED_IDS = 2_000;
// Progress is saved after this many posts, so a worker that dies loses little.
const CHECKPOINT_POSTS = 20;
// A comment is queued only if Instagram still allows its private reply this
// long after the job's planned time.
const WINDOW_MARGIN_MS = 60 * 60_000;
// Comment reads in a row that Meta refuses for the account (a permission or
// a missing object, not one post) before the run stops as for a lost
// connection, and reads them again later.
const MAX_REFUSED_IN_ROW = 3;
// A continuation may run this much before the time it was queued for.
const RESUME_TOLERANCE_MS = 30_000;
// The worker's sweep asks again for a continuation this long overdue.
const RESUME_GRACE_MS = 5 * 60_000;
// A comment's text as it is kept for the owner's list, at most.
const TEXT_MAX = 300;

/** The comment job id of a catch-up: `recover_<instagram id>_<comment id>`. */
export function recoverJobId(instagramId: string, commentId: string): string {
  return `recover_${instagramId}_${commentId}`;
}

const ACCOUNT_SELECT = {
  id: true,
  workspaceId: true,
  instagramId: true,
  username: true,
  provider: true,
  metaLogin: true,
  accessToken: true,
  zernioAccountId: true,
  connectionLostAt: true,
  connectionRecoveredAt: true,
  connectionCatchUpFrom: true,
  connectionCatchUpClaimedAt: true,
  connectionCatchUpProgress: true,
} satisfies Prisma.InstagramAccountSelect;

type CatchUpAccount = Prisma.InstagramAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  postId: true,
  matchAnyPost: true,
  keywords: true,
  matchAnyWord: true,
  wholeWordMatch: true,
  ignoreQuestionComments: true,
  isActive: true,
} satisfies Prisma.AutomationSelect;

type Campaign = Prisma.AutomationGetPayload<{ select: typeof CAMPAIGN_SELECT }>;

export type CatchUpOutcome =
  /** Nothing is owed (or was owed by an account that is not read through Meta). */
  | "none"
  /** A new incident is open: its end asks again. */
  | "lost"
  /** A run that stopped early queued itself for later. */
  | "waiting"
  /** Another run holds the lease. */
  | "busy"
  /** The account is paused for a Meta limit (R1): goes on after the pause. */
  | "paused"
  /** Stopped early for a limit, the usage brake, an error or a shutdown: goes on later. */
  | "stopped"
  /** The lease was lost, or the incident changed under the run: another run does it. */
  | "superseded"
  /** Finished; the all-clear e-mail is sent or owed. */
  | "done";

export interface CatchUpRunOptions {
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The all-clear's transport and settings (tests); the worker's by default. */
  transport?: MailTransport | null;
  env?: Record<string, string | undefined>;
}

type Stop = {
  kind: "stop";
  reason: "paused" | "limit" | "usage" | "lost" | "error" | "shutdown";
  /** When the run may go on (epoch ms). */
  resumeAt: number;
  detail?: string;
};
type Superseded = { kind: "superseded" };

interface Run {
  account: CatchUpAccount;
  from: Date;
  /** The account's connectionRecoveredAt as the lease was taken on it. */
  recoveredAt: Date | null;
  lease: Date;
  progress: CatchUpProgress;
  queued: Set<string>;
  answered: Set<string>;
  startedAt: number;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
}

let shutdownRequested = false;

/**
 * The worker is shutting down: a run that reads stops before its next read,
 * keeps how far it got and queues itself for a minute later, so the
 * shutdown does not wait for it (worker/dm-worker.ts).
 */
export function stopConnectionCatchUps(): void {
  shutdownRequested = true;
}

/** Tests: a new process. */
export function resetConnectionCatchUps(): void {
  shutdownRequested = false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** The progress that belongs to this catch-up, or a fresh one. */
function progressFor(
  stored: CatchUpProgress | null,
  from: Date,
  recoveredAt: Date | null,
  now: number
): CatchUpProgress {
  const fromIso = from.toISOString();
  const recoveredIso = (recoveredAt ?? from).toISOString();
  if (stored && stored.from === fromIso && stored.recoveredAt === recoveredIso) {
    return stored;
  }
  const fresh: CatchUpProgress = {
    v: 1,
    from: fromIso,
    recoveredAt: recoveredIso,
    startedAt: iso(now),
    posts: null,
    next: 0,
    pages: 0,
    queuedIds: [],
    firstJobAt: null,
    lastJobAt: null,
    answeredIds: [],
    answered: [],
    seen: 0,
    handled: 0,
    skipped: { ...EMPTY_SKIPPED },
    stops: 0,
    resumeAt: null,
  };
  if (stored && stored.from === fromIso) {
    // One more incident ended while this catch-up was owed: every post is
    // read again, as it may have new comments, but what was queued stays
    // queued and the owner's answers stay listed.
    return {
      ...fresh,
      queuedIds: stored.queuedIds,
      firstJobAt: stored.firstJobAt,
      lastJobAt: stored.lastJobAt,
      answeredIds: stored.answeredIds,
      answered: stored.answered,
    };
  }
  return fresh;
}

function isAccountAuthor(
  author: { id?: string | null; username?: string | null } | undefined,
  account: { instagramId: string; username: string }
): boolean {
  if (!author) return false;
  return (
    author.id === account.instagramId ||
    (Boolean(author.username) &&
      author.username!.toLowerCase() === account.username.toLowerCase())
  );
}

function shortText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX - 1).trimEnd()}…` : line;
}

/**
 * Run the account's catch-up, or the part of it that is left. The job of
 * `catchup_<account>_<start>` (lib/queue/dm-worker.ts) and its continuations.
 */
export async function runConnectionCatchUp(
  accountId: string,
  options: CatchUpRunOptions = {}
): Promise<CatchUpOutcome> {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const now = clock();
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: ACCOUNT_SELECT,
  });
  const from = account?.connectionCatchUpFrom;
  if (!account || !from) return "none";
  // Meta refuses the account again: the end of that incident asks again,
  // and this catch-up's start is kept for it (clearConnectionIncident).
  if (account.connectionLostAt) return "lost";

  // Only an account connected through Meta can have had an incident.
  if (account.provider !== "META" || !account.accessToken) {
    await prisma.instagramAccount.updateMany({
      where: { id: account.id, connectionCatchUpFrom: from },
      data: {
        connectionCatchUpFrom: null,
        connectionCatchUpClaimedAt: null,
        connectionCatchUpProgress: Prisma.DbNull,
      },
    });
    return "none";
  }

  const progress = progressFor(
    readCatchUpProgress(account.connectionCatchUpProgress),
    from,
    account.connectionRecoveredAt,
    now
  );
  if (progress.resumeAt && Date.parse(progress.resumeAt) > now + RESUME_TOLERANCE_MS) {
    return "waiting";
  }

  const lease = new Date(now);
  const claimed = await prisma.instagramAccount.updateMany({
    where: {
      id: account.id,
      connectionCatchUpFrom: from,
      connectionRecoveredAt: account.connectionRecoveredAt,
      connectionLostAt: null,
      OR: [
        { connectionCatchUpClaimedAt: null },
        { connectionCatchUpClaimedAt: { lt: new Date(now - CATCH_UP_LEASE_MS) } },
      ],
    },
    data: { connectionCatchUpClaimedAt: lease },
  });
  if (claimed.count !== 1) {
    // Another run holds the lease: should it have died with it, this one
    // tries again right after the lease runs out. Or the row changed since
    // it was read (one more incident ended, whose request found this job
    // still running): a fresh look in a moment.
    const heldSince = account.connectionCatchUpClaimedAt;
    const held = heldSince !== null && now - heldSince.getTime() < CATCH_UP_LEASE_MS;
    await queueConnectionCatchUp(account, from, {
      runAt: held ? heldSince.getTime() + CATCH_UP_LEASE_MS + 1_000 : now + 5_000,
      now,
    });
    return "busy";
  }

  progress.resumeAt = null;
  const run: Run = {
    account,
    from,
    recoveredAt: account.connectionRecoveredAt,
    lease,
    progress,
    queued: new Set(progress.queuedIds),
    answered: new Set(progress.answeredIds),
    startedAt: now,
    clock,
    sleep,
  };

  try {
    if (now - Date.parse(progress.startedAt) >= CATCH_UP_GIVE_UP_MS) {
      progress.skipped.gaveUp = true;
      if (progress.posts) {
        progress.skipped.postsNotRead += Math.max(0, progress.posts.length - progress.next);
        progress.next = progress.posts.length;
      }
      return await finish(run, options);
    }
    const step = await scan(run);
    if (step.kind === "superseded") return "superseded";
    if (step.kind === "stop") return await stop(run, step);
    return await finish(run, options);
  } catch (error) {
    // The database or the queue: what was queued is kept and the lease given
    // back, so the job's retry need not wait for it.
    await saveProgress(run, { release: true }).catch(() => false);
    throw error;
  }
}

type ScanStep = { kind: "done" } | Stop | Superseded;

/** Read the posts and their comments, and queue what is owed. */
async function scan(run: Run): Promise<ScanStep> {
  const { account, progress } = run;
  let context: InstagramContext;
  try {
    context = await createInstagramContext(account);
  } catch (error) {
    return stopFor(run, "error", CATCH_UP_RETRY_MS, `token could not be read: ${formatError(error)}`);
  }
  if (context.provider !== "META") {
    return stopFor(run, "error", CATCH_UP_RETRY_MS, "not connected through Meta");
  }

  const campaigns = await prisma.automation.findMany({
    where: { instagramAccountId: account.id, isActive: true },
    select: CAMPAIGN_SELECT,
    orderBy: { createdAt: "asc" },
  });

  if (!progress.posts) {
    if (campaigns.length === 0) {
      // No active campaign: nothing could match, so nothing is read.
      progress.posts = [];
    } else {
      const listed = await readPosts(run, context, campaigns);
      if (listed.kind !== "posts") return listed;
      progress.posts = listed.posts;
      progress.skipped.olderPosts = listed.olderPosts;
    }
    progress.next = 0;
  }

  const windowStart = run.from.getTime() - CONNECTION_CATCH_UP_MARGIN_MS;
  const posts = progress.posts;
  let sinceCheckpoint = 0;
  // Comment reads in a row that Meta refused for the account (from the post
  // at refusedFirst on): counted as failed posts only once a read after them
  // gets through.
  let refusedFirst = 0;
  let refusedCount = 0;

  while (progress.next < posts.length) {
    if (progress.pages >= CATCH_UP_MAX_COMMENT_PAGES) {
      progress.skipped.postsNotRead += posts.length - progress.next;
      progress.next = posts.length;
      break;
    }
    const post = posts[progress.next];
    // Nothing older than 7 days can get a DM, whatever the incident's start.
    const readBack = Math.max(windowStart, run.clock() - PRIVATE_REPLY_WINDOW_MS);
    const read = await readComments(run, context, post, readBack);
    if (read.kind === "stop" || read.kind === "superseded") {
      // The posts refused before this one stay counted as failed.
      progress.skipped.postsFailed += refusedCount;
      return read;
    }

    if (read.kind === "refused" && !post.listed) {
      // A campaign's older post or an ad that is gone: this post only.
      progress.skipped.postsFailed += refusedCount + 1;
      refusedCount = 0;
      console.warn(`[Catch-up] @${account.username}: comments of a post not readable (${read.detail})`);
      progress.next += 1;
      await run.sleep(CATCH_UP_READ_GAP_MS);
      continue;
    }
    if (read.kind === "refused") {
      if (refusedCount === 0) refusedFirst = progress.next;
      refusedCount += 1;
      if (refusedCount >= MAX_REFUSED_IN_ROW) {
        // The account, not a post: read these again later.
        progress.next = refusedFirst;
        return stopFor(run, "lost", CATCH_UP_RETRY_MS, read.detail);
      }
      console.warn(`[Catch-up] @${account.username}: comments of a post not readable (${read.detail})`);
      progress.next += 1;
      await run.sleep(CATCH_UP_READ_GAP_MS);
      continue;
    }
    progress.skipped.postsFailed += refusedCount;
    refusedCount = 0;
    if (read.kind === "failed") {
      progress.skipped.postsFailed += 1;
      console.warn(`[Catch-up] @${account.username}: comments of a post not readable (${read.detail})`);
    } else {
      if (read.partial === "budget") progress.skipped.postsPartial += 1;
      if (read.partial === "failed") progress.skipped.postsFailed += 1;
      await takeComments(run, post, read.comments, windowStart, campaigns);
    }
    progress.next += 1;

    sinceCheckpoint += 1;
    if (sinceCheckpoint >= CHECKPOINT_POSTS) {
      sinceCheckpoint = 0;
      if (!(await saveProgress(run, { release: false }))) return { kind: "superseded" };
    }
    // Meta reports the app close to a limit: the DMs need what is left.
    if (progress.next < posts.length && usageHigh(run)) {
      return stopFor(run, "usage", CATCH_UP_BRAKE_WAIT_MS);
    }
    if (progress.next < posts.length) await run.sleep(CATCH_UP_READ_GAP_MS);
  }
  progress.skipped.postsFailed += refusedCount;
  return { kind: "done" };
}

function stopFor(
  run: Run,
  reason: Stop["reason"],
  waitMs: number,
  detail?: string
): Stop {
  return { kind: "stop", reason, resumeAt: run.clock() + waitMs, detail };
}

function limitStop(run: Run, error: unknown): Stop {
  return stopFor(
    run,
    "limit",
    throttlePauseMs(error) || DEFAULT_THROTTLE_PAUSE_MINUTES * 60_000,
    formatError(error)
  );
}

/**
 * Before every read: a shutdown or the account's pause stops the run (no
 * call to Meta while paused), and the lease is renewed when due.
 */
async function beforeRead(run: Run): Promise<Stop | Superseded | null> {
  if (shutdownRequested) return stopFor(run, "shutdown", SHUTDOWN_WAIT_MS);
  const now = run.clock();
  const pausedUntil = await checkAccountPause(run.account.instagramId, now);
  if (pausedUntil !== null) {
    return {
      kind: "stop",
      reason: "paused",
      // After the pause, spread like every job that waits for it.
      resumeAt: pausedRunAt(pausedUntil, catchUpJobId(run.account.id, run.from)),
    };
  }
  if (now - run.lease.getTime() >= LEASE_RENEW_MS) {
    const renewed = new Date(now);
    const { count } = await prisma.instagramAccount.updateMany({
      where: { id: run.account.id, connectionCatchUpClaimedAt: run.lease },
      data: { connectionCatchUpClaimedAt: renewed },
    });
    if (count !== 1) return { kind: "superseded" };
    run.lease = renewed;
  }
  return null;
}

function usageHigh(run: Run): boolean {
  const report = latestMetaUsage();
  return Boolean(
    report &&
      report.at >= run.startedAt &&
      accountUsagePercent(report.usage, run.account.instagramId) >=
        CATCH_UP_USAGE_BRAKE_PERCENT
  );
}

type PostList = { kind: "posts"; posts: CatchUpPost[]; olderPosts: boolean };

/**
 * The posts to read: the newest CATCH_UP_MAX_POSTS that an active campaign
 * covers (all of them with an any-post campaign) and that have comments,
 * then the posts campaigns are bound to that are older, and the ads made from
 * those posts (as the sweep finds them: adMediaFor).
 */
async function readPosts(
  run: Run,
  context: Extract<InstagramContext, { provider: "META" }>,
  campaigns: Campaign[]
): Promise<PostList | Stop | Superseded> {
  const media: InstagramMediaSummary[] = [];
  let next: string | null = null;
  let olderPosts = false;
  do {
    const guard = await beforeRead(run);
    if (guard) return guard;
    let page;
    try {
      page = await getUserMediaPage(context, {
        igUserId: run.account.instagramId,
        limit: Math.min(100, CATCH_UP_MAX_POSTS - media.length),
        next,
      });
    } catch (error) {
      if (isMetaThrottle(error)) return limitStop(run, error);
      const refused = classifyConnectionError(error).outcome === "lost";
      return stopFor(run, refused ? "lost" : "error", CATCH_UP_RETRY_MS, formatError(error));
    }
    media.push(...page.data);
    // An empty page ends the list, whatever link Meta sends with it.
    next = page.data.length > 0 ? page.next : null;
    if (media.length >= CATCH_UP_MAX_POSTS) {
      olderPosts = next !== null || media.length > CATCH_UP_MAX_POSTS;
      break;
    }
    if (next) await run.sleep(CATCH_UP_READ_GAP_MS);
  } while (next);

  const newest = media.slice(0, CATCH_UP_MAX_POSTS);
  const listed = new Map(newest.map((item) => [item.id, item]));
  const anyPost = campaigns.some((campaign) => campaign.matchAnyPost);
  const bound = [
    ...new Set(
      campaigns.flatMap((campaign) => (campaign.postId ? [campaign.postId] : []))
    ),
  ];
  const posts: CatchUpPost[] = [];
  const taken = new Set<string>();
  const add = (post: CatchUpPost) => {
    if (taken.has(post.id)) return;
    taken.add(post.id);
    posts.push(post);
  };
  for (const item of newest) {
    if (!anyPost && !bound.includes(item.id)) continue;
    // A post without a single comment has nothing to catch up.
    if (item.comments_count === 0) continue;
    add({ id: item.id, permalink: safePermalink(item.permalink), listed: true });
  }
  for (const postId of bound) {
    const item = listed.get(postId);
    if (!item) add({ id: postId, permalink: null });
    for (const ad of await adMediaFor(postId)) {
      add({
        id: ad,
        permalink: safePermalink(item?.permalink),
        originalMediaId: postId,
      });
    }
  }
  return { kind: "posts", posts, olderPosts };
}

type CommentRead =
  | { kind: "comments"; comments: InstagramComment[]; partial: false | "budget" | "failed" }
  /** Meta refused the post's comments in a way that may be the account's. */
  | { kind: "refused"; detail: string }
  /** The post's comments could not be read (a network error, a 5xx …). */
  | { kind: "failed"; detail: string }
  | Stop
  | Superseded;

/** A post's comments, newest first, back to `readBack` (epoch ms) or the page cap. */
async function readComments(
  run: Run,
  context: Extract<InstagramContext, { provider: "META" }>,
  post: CatchUpPost,
  readBack: number
): Promise<CommentRead> {
  const { progress } = run;
  const comments: InstagramComment[] = [];
  let next: string | null = null;
  do {
    const guard = await beforeRead(run);
    if (guard) return guard;
    let page;
    try {
      page = await getMediaCommentsPage(context, post.id, next);
    } catch (error) {
      // A request limit holds for every read: the post is read again later.
      if (isMetaThrottle(error)) return limitStop(run, error);
      const classified = classifyConnectionError(error);
      if (classified.outcome === "lost" && classified.kind === "token") {
        // The token itself: nothing else will be read either.
        return stopFor(run, "lost", CATCH_UP_RETRY_MS, formatError(error));
      }
      // What its first pages brought is kept.
      if (comments.length > 0) return { kind: "comments", comments, partial: "failed" };
      return classified.outcome === "lost"
        ? { kind: "refused", detail: classified.reason }
        : { kind: "failed", detail: formatError(error) };
    }
    progress.pages += 1;
    comments.push(...page.data);
    // Newest first: once a page reaches back before the window, older pages
    // hold nothing to catch up.
    const oldest = page.data[page.data.length - 1];
    const reachedBack =
      !oldest || (Boolean(oldest.timestamp) && Date.parse(oldest.timestamp) < readBack);
    next = reachedBack ? null : page.next;
    if (next && progress.pages >= CATCH_UP_MAX_COMMENT_PAGES) {
      return { kind: "comments", comments, partial: "budget" };
    }
    if (next) await run.sleep(CATCH_UP_READ_GAP_MS);
  } while (next);
  return { kind: "comments", comments, partial: false };
}

/** Queue what a post's comments owe, and note what the owner answered. */
async function takeComments(
  run: Run,
  post: CatchUpPost,
  comments: InstagramComment[],
  windowStart: number,
  campaigns: Campaign[]
): Promise<void> {
  const { account, progress } = run;
  const candidates: InstagramComment[] = [];
  for (const comment of comments) {
    const at = comment.timestamp ? Date.parse(comment.timestamp) : Number.NaN;
    // Before the incident (and its margin): the webhooks or the sweep had it.
    if (!Number.isFinite(at) || at < windowStart) continue;
    progress.seen += 1;
    if (!comment.from?.id || isAccountAuthor(comment.from, account)) continue;
    if (
      !campaignForComment(campaigns, {
        text: comment.text ?? "",
        mediaId: post.id,
        originalMediaId: post.originalMediaId,
      })
    ) {
      continue;
    }
    candidates.push(comment);
  }
  if (candidates.length === 0) return;

  // A DmLog row means a job already handles the comment (sent, failed or on
  // its way): never the catch-up's to queue again.
  const logged = new Set(
    (
      await prisma.dmLog.findMany({
        where: {
          instagramAccountId: account.id,
          commentId: { in: candidates.map((comment) => comment.id) },
        },
        select: { commentId: true },
      })
    ).map((row) => row.commentId)
  );

  const owed: InstagramComment[] = [];
  for (const comment of candidates) {
    if (logged.has(comment.id)) {
      progress.handled += 1;
      continue;
    }
    const answeredByOwner = (comment.replies?.data ?? []).some((reply) =>
      isAccountAuthor(reply.from, account)
    );
    if (answeredByOwner) {
      noteAnswered(run, post, comment);
      continue;
    }
    owed.push(comment);
  }
  owed.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const comment of owed) await queueComment(run, post, comment);
}

function noteAnswered(run: Run, post: CatchUpPost, comment: InstagramComment): void {
  const { progress } = run;
  if (run.answered.has(comment.id)) return;
  // Listed only while "DM senden" can still send it.
  if (!withinPrivateReplyWindow(comment.timestamp, run.clock())) return;
  if (run.answered.size < MAX_ANSWERED_IDS) {
    run.answered.add(comment.id);
    progress.answeredIds.push(comment.id);
  }
  if (progress.answered.length < CATCH_UP_MAX_LISTED) {
    progress.answered.push({
      commentId: comment.id,
      username: comment.from?.username ?? null,
      text: shortText(comment.text ?? ""),
      timestamp: new Date(Date.parse(comment.timestamp)).toISOString(),
      permalink: post.permalink,
    });
  }
}

/** One comment's job, 20 seconds after the one before. */
async function queueComment(
  run: Run,
  post: CatchUpPost,
  comment: InstagramComment
): Promise<void> {
  const { account, progress } = run;
  if (run.queued.has(comment.id)) return;
  if (run.queued.size >= CATCH_UP_MAX_QUEUED) {
    progress.skipped.notQueued += 1;
    return;
  }
  if (!SAFE_ID_PATTERN.test(comment.id) || !SAFE_ID_PATTERN.test(account.instagramId)) {
    // No job id that could not collide: left to the Kommentare page.
    console.warn(`[Catch-up] @${account.username}: a comment id that cannot name a job was skipped`);
    progress.skipped.notQueued += 1;
    return;
  }
  const now = run.clock();
  const last = progress.lastJobAt ? Date.parse(progress.lastJobAt) : null;
  const runAt = last === null ? now : Math.max(now, last + CATCH_UP_SPACING_MS);
  if (!withinPrivateReplyWindow(comment.timestamp, runAt + WINDOW_MARGIN_MS)) {
    progress.skipped.tooOld += 1;
    return;
  }

  const data: ProcessCommentJob = {
    instagramAccountId: account.instagramId,
    accountConnectionId: account.id,
    commentId: comment.id,
    commentText: comment.text ?? "",
    commenterId: comment.from!.id,
    commenterName: comment.from?.username,
    mediaId: post.id,
    ...(post.originalMediaId ? { originalMediaId: post.originalMediaId } : {}),
    source: "RECOVERY",
  };
  // Removed once it ends: a finished job never swallows a later one, and a
  // comment whose DM went out has its DmLog row by then.
  await getDMQueue().add(COMMENT_JOB_NAME, data, {
    jobId: recoverJobId(account.instagramId, comment.id),
    delay: runAt - now,
    removeOnComplete: true,
    removeOnFail: true,
  });
  run.queued.add(comment.id);
  progress.queuedIds.push(comment.id);
  progress.firstJobAt ??= iso(runAt);
  progress.lastJobAt = iso(runAt);
}

/**
 * Keep how far the run got, on the row it holds the lease of: renewed, or
 * given back. False when the lease is no longer this run's.
 */
async function saveProgress(run: Run, { release }: { release: boolean }): Promise<boolean> {
  const renewed = new Date(run.clock());
  const { count } = await prisma.instagramAccount.updateMany({
    where: {
      id: run.account.id,
      connectionCatchUpFrom: run.from,
      connectionCatchUpClaimedAt: run.lease,
    },
    data: {
      connectionCatchUpProgress: asJson(run.progress),
      connectionCatchUpClaimedAt: release ? null : renewed,
    },
  });
  if (count === 1 && !release) run.lease = renewed;
  return count === 1;
}

/** Stop early: keep the progress, give the lease back, queue the rest for later. */
async function stop(run: Run, step: Stop): Promise<CatchUpOutcome> {
  const { account, progress } = run;
  progress.resumeAt = iso(step.resumeAt);
  progress.stops += 1;
  if (!(await saveProgress(run, { release: true }))) return "superseded";
  await queueConnectionCatchUp(account, run.from, {
    runAt: step.resumeAt,
    now: run.clock(),
  });
  console.log(
    `[Catch-up] @${account.username}: stopped (${step.reason}${step.detail ? `: ${step.detail}` : ""}); goes on at ${formatPauseTime(step.resumeAt)}`
  );
  return step.reason === "paused" ? "paused" : "stopped";
}

function describeSkipped(result: CatchUpResult): string {
  const { skipped } = result;
  const parts = [
    skipped.olderPosts ? `posts older than the newest ${CATCH_UP_MAX_POSTS}` : null,
    skipped.postsNotRead
      ? `${skipped.postsNotRead} posts not read (limit of ${CATCH_UP_MAX_COMMENT_PAGES} comment pages)`
      : null,
    skipped.postsPartial ? `${skipped.postsPartial} posts read in part (same limit)` : null,
    skipped.postsFailed ? `${skipped.postsFailed} posts whose comments could not be read` : null,
    skipped.tooOld ? `${skipped.tooOld} comments older than 7 days` : null,
    skipped.notQueued ? `${skipped.notQueued} comments over the limit of ${CATCH_UP_MAX_QUEUED}` : null,
    skipped.gaveUp ? "stopped after 24 hours" : null,
  ].filter(Boolean);
  return parts.length > 0 ? `; skipped: ${parts.join(", ")}` : "";
}

/** The end: the result on the row, at most once, then the all-clear e-mail. */
async function finish(run: Run, options: CatchUpRunOptions): Promise<CatchUpOutcome> {
  const { account, progress } = run;
  const finishedAt = new Date(run.clock());
  const windowStart = run.from.getTime() - CONNECTION_CATCH_UP_MARGIN_MS;
  const result: CatchUpResult = {
    v: 1,
    lostAt: run.from.toISOString(),
    recoveredAt: (run.recoveredAt ?? run.from).toISOString(),
    finishedAt: finishedAt.toISOString(),
    since: iso(Math.max(windowStart, Date.parse(progress.startedAt) - PRIVATE_REPLY_WINDOW_MS)),
    queued: progress.queuedIds.length,
    firstJobAt: progress.firstJobAt,
    lastJobAt: progress.lastJobAt,
    ownerAnswered: progress.answered,
    ownerAnsweredTotal: Math.max(progress.answeredIds.length, progress.answered.length),
    posts: progress.next,
    pages: progress.pages,
    skipped: progress.skipped,
    complete: catchUpComplete(progress.skipped),
  };
  const { count } = await prisma.instagramAccount.updateMany({
    where: {
      id: account.id,
      connectionCatchUpFrom: run.from,
      connectionCatchUpClaimedAt: run.lease,
      connectionRecoveredAt: run.recoveredAt,
      connectionLostAt: null,
    },
    data: {
      connectionCatchUpFrom: null,
      connectionCatchUpClaimedAt: null,
      connectionCatchUpProgress: Prisma.DbNull,
      connectionCatchUpResult: asJson(result),
      connectionAllClearDueAt: finishedAt,
    },
  });
  if (count !== 1) {
    // A new incident began, or one more ended and was merged into this
    // catch-up (its start kept): what was queued stays queued, and the
    // catch-up runs again once the account can be read.
    if (await saveProgress(run, { release: true })) {
      const current = await prisma.instagramAccount.findUnique({
        where: { id: account.id },
        select: { connectionLostAt: true, connectionCatchUpFrom: true },
      });
      if (current?.connectionCatchUpFrom && !current.connectionLostAt) {
        await queueConnectionCatchUp(account, current.connectionCatchUpFrom, {
          runAt: run.clock() + 1_000,
          now: run.clock(),
        });
      }
    }
    return "superseded";
  }

  const message = `Catch-up for @${account.username} after the lost connection: ${result.queued} comments queued (one every ${CATCH_UP_SPACING_MS / 1000} s), ${result.ownerAnsweredTotal} answered by hand and not sent; ${result.posts} posts and ${result.pages} comment pages read for comments since ${result.since}${describeSkipped(result)}`;
  console.log(`[Catch-up] ${message}`);
  await logWorkerEvent({
    workspaceId: account.workspaceId,
    level: result.complete ? "INFO" : "WARNING",
    message,
    payload: {
      kind: CONNECTION_CATCH_UP_EVENT,
      account: account.username,
      queued: result.queued,
      answered: result.ownerAnsweredTotal,
      complete: result.complete,
      posts: result.posts,
      pages: result.pages,
      skippedPosts: skippedPosts(result.skipped),
      skipped: asJson(result.skipped),
    },
  });

  try {
    await sendConnectionAllClear(account.id, {
      now: run.clock(),
      ...(options.transport !== undefined ? { transport: options.transport } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
  } catch (error) {
    // Still owed: the worker's next sweep sends it.
    console.error("[Catch-up] All-clear e-mail not sent yet:", formatError(error));
  }
  return "done";
}

/**
 * With every comment sweep (worker/dm-worker.ts): ask again for a catch-up
 * that is owed and neither running nor queued for later (its request was
 * lost, or the worker restarted), and send an all-clear e-mail that is still
 * owed. Database reads only, no Meta call.
 */
export async function resumeConnectionCatchUps({
  clock = Date.now,
  transport,
  env,
}: {
  clock?: () => number;
  transport?: MailTransport | null;
  env?: Record<string, string | undefined>;
} = {}): Promise<{ requested: number; mailed: number }> {
  const now = clock();
  const accounts = await prisma.instagramAccount.findMany({
    where: {
      OR: [
        { connectionCatchUpFrom: { not: null } },
        { connectionAllClearDueAt: { not: null } },
      ],
    },
    select: {
      id: true,
      instagramId: true,
      username: true,
      connectionLostAt: true,
      connectionRecoveredAt: true,
      connectionCatchUpFrom: true,
      connectionCatchUpClaimedAt: true,
      connectionCatchUpProgress: true,
      connectionAllClearDueAt: true,
    },
  });
  let requested = 0;
  let mailed = 0;
  for (const account of accounts) {
    try {
      const from = account.connectionCatchUpFrom;
      const running =
        account.connectionCatchUpClaimedAt !== null &&
        now - account.connectionCatchUpClaimedAt.getTime() < CATCH_UP_LEASE_MS;
      if (from && !account.connectionLostAt && !running) {
        const stored = readCatchUpProgress(account.connectionCatchUpProgress);
        const ours =
          stored &&
          stored.from === from.toISOString() &&
          stored.recoveredAt === (account.connectionRecoveredAt ?? from).toISOString();
        const resumeAt = ours && stored.resumeAt ? Date.parse(stored.resumeAt) : null;
        if (resumeAt === null || now >= resumeAt + RESUME_GRACE_MS) {
          if (await queueConnectionCatchUp(account, from, { now })) requested += 1;
        }
      }
      if (account.connectionAllClearDueAt) {
        const outcome = await sendConnectionAllClear(account.id, {
          now,
          ...(transport !== undefined ? { transport } : {}),
          ...(env ? { env } : {}),
        });
        if (outcome === "sent") mailed += 1;
      }
    } catch (error) {
      console.error(
        `[Catch-up] @${account.username}: could not look at the catch-up:`,
        formatError(error)
      );
    }
  }
  return { requested, mailed };
}
