/**
 * Comment reconciliation (polling safety net).
 *
 * Instagram webhooks are best-effort and never fire for a large class of
 * comments (collapsed "load more" comments, non-follower / low-signal accounts,
 * anything Instagram filters). Those comments are otherwise invisible: never
 * replied to, never DM'd.
 *
 * This sweep is deliberately narrow. For each active campaign it looks only at
 * that campaign's post, only at recent comments, and acts on a comment ONLY when
 * both are true:
 *   1. the comment matches the campaign keyword, and
 *   2. the account owner has not already replied to it.
 * The reply check reads the comment's actual replies on Instagram, so a comment
 * you (or the tool) already answered is skipped — the poll never re-touches
 * handled comments. Each sweep is capped so it can never flood the comment API
 * (which Instagram rate-limits aggressively, error 368).
 *
 * It runs on an interval in the worker process because Vercel's free crons only
 * fire once a day. Matching and sending reuse the worker's processComment, so
 * rate limiting and logging behave exactly as for webhook-delivered comments.
 *
 * Known limitation, handled not fixed: comments removed by Instagram's Hidden
 * Words / spam filter may not be returned by the Graph API at all. Disable that
 * filter on the account to widen results.
 *
 * Meta's request limits: a read that Meta refuses with one (a throttle or a
 * block) ends the whole sweep there, recorded once; the next sweep tries
 * again. An account whose messaging is paused for a limit
 * (lib/queue/account-pause.ts) is not swept at all while the pause lasts:
 * nothing could be sent for its comments, and the first sweep after the pause
 * finds them.
 *
 * After a lost connection (A1) the account is not swept either while its
 * catch-up runs and until the last comment job it queued has run
 * (catchUpHoldsSweep): the catch-up reads every post since the incident began
 * and spaces the DMs 20 seconds apart, and the sweep would queue the same
 * comments again all at once.
 */

import { matchCommentToCampaign } from "@/lib/automation/comment-match";
import {
  catchUpHoldsSweep,
  CATCH_UP_SWEEP_HOLD_MAX_MS,
} from "@/lib/instagram/catch-up-state";
import { MAX_COMMENT_SEND_ATTEMPTS } from "@/lib/queue/comment-delivery";
import {
  hasLegacyUnconfirmedDelivery,
  isMetaThrottle,
} from "@/lib/instagram/delivery-errors";
import { prisma } from "@/lib/db/client";
import { SWEEP_LIMIT_EVENT } from "@/lib/ops/event-details";
import { checkAccountPause, formatPauseTime } from "@/lib/queue/account-pause";
import { COMMENT_JOB_NAME, getDMQueue } from "@/lib/queue/client";
import {
  getAllUserMedia,
  getRecentMediaComments,
  MetaApiError,
  type InstagramComment,
} from "@/lib/instagram/provider";
import {
  createInstagramContext,
  type InstagramContext,
} from "@/lib/instagram/provider";

// Only consider comments from the last few days — older ones are outside
// Instagram's private-reply window anyway, so a DM to them would just fail.
const LOOKBACK_HOURS = Number(process.env.COMMENT_POLL_LOOKBACK_HOURS ?? 72);
// Hard cap on how many new comments a single campaign can enqueue per sweep,
// across all of its posts, so a viral post or a backlog on many posts drains
// gradually instead of bursting into the comment API.
const MAX_NEW_PER_SWEEP = Number(process.env.COMMENT_POLL_MAX_PER_SWEEP ?? 30);

export const DEFAULT_COMMENT_POLL_MEDIA_LIMIT = 10;
const MAX_COMMENT_POLL_MEDIA_LIMIT = 50;

/**
 * For "any post" campaigns, how many of the newest posts a sweep reads
 * (COMMENT_POLL_MEDIA_LIMIT): a whole number from 1 to 50, 10 by default.
 *
 * Only this count bounds the posts, never their age: an older reel still
 * gets comments, and the lookback (COMMENT_POLL_LOOKBACK_HOURS) bounds those.
 * An account that posts ten times a day reaches back only one day with the
 * default. Each post costs one comment read per sweep and account, shared by
 * every campaign of the account.
 */
export function commentPollMediaLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_COMMENT_POLL_MEDIA_LIMIT;
  }
  const limit = Number(value);
  if (!Number.isFinite(limit)) return DEFAULT_COMMENT_POLL_MEDIA_LIMIT;
  return Math.min(MAX_COMMENT_POLL_MEDIA_LIMIT, Math.max(1, Math.floor(limit)));
}

const RECENT_MEDIA_LIMIT = commentPollMediaLimit(
  process.env.COMMENT_POLL_MEDIA_LIMIT
);

interface SweepStat {
  campaign: string;
  keywords: string;
  matched: number;
  alreadyReplied: number;
  enqueued: number;
  errors: string[];
  // A read Meta refused with a request limit. It ends the sweep and is
  // recorded on its own (recordSweepStopped), not among the errors.
  limit?: unknown;
}

function errMessage(error: unknown): string {
  if (error instanceof MetaApiError)
    return `Meta ${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

/** One reconciliation pass across every active campaign. */
export async function reconcileComments(): Promise<void> {
  const automations = await prisma.automation.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      postId: true,
      matchAnyPost: true,
      matchAnyWord: true,
      keywords: true,
      wholeWordMatch: true,
      ignoreQuestionComments: true,
      publicReplyEnabled: true,
      workspaceId: true,
      instagramAccount: {
        select: {
          id: true,
          instagramId: true,
          username: true,
          accessToken: true,
          provider: true,
          metaLogin: true,
          workspaceId: true,
          zernioAccountId: true,
          connectionRecoveredAt: true,
          connectionCatchUpFrom: true,
        },
      },
    },
  });

  const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const tokenCache = new Map<string, InstagramContext | null>();
  const reads: SweepReads = { media: new Map(), comments: new Map() };
  // Each account's pause, read once per sweep.
  const pauses = new Map<string, number | null>();
  // Accounts whose catch-up after a lost connection holds the sweep back.
  const catchingUp = new Map<string, boolean>();

  for (const automation of automations) {
    const account = automation.instagramAccount;
    let held = catchingUp.get(account.id);
    if (held === undefined) {
      held = await sweepHeldForCatchUp(account);
      catchingUp.set(account.id, held);
      if (held) {
        console.log(
          `[Sweep] @${account.username} is catching up on the comments of a lost connection; not swept`
        );
      }
    }
    if (held) continue;

    let pausedUntil = pauses.get(account.id);
    if (pausedUntil === undefined) {
      pausedUntil = await checkAccountPause(account.instagramId);
      pauses.set(account.id, pausedUntil);
      if (pausedUntil !== null) {
        console.log(
          `[Sweep] @${account.username} is paused for an Instagram request limit until ${formatPauseTime(pausedUntil)}; not swept`
        );
      }
    }
    if (pausedUntil !== null) continue;

    const stat = await sweepCampaign({
      automation: automation,
      sinceMs: sinceMs,
      tokenCache: tokenCache,
      reads: reads,
    }).catch(
      (error): SweepStat => ({
        campaign: automation.name,
        keywords: automation.keywords.join(","),
        matched: 0,
        alreadyReplied: 0,
        enqueued: 0,
        errors: [errMessage(error)],
      })
    );
    await recordSweep(automation.workspaceId, stat);
    if (stat.limit !== undefined) {
      // Every further read would be refused as well, and would only keep
      // the limit going: the rest of the sweep waits for the next one.
      await recordSweepStopped(automation, stat.limit);
      return;
    }
  }
}

/**
 * Whether the account's catch-up after a lost connection holds the sweep
 * back (catchUpHoldsSweep). The catch-up's JSON (when its last job runs) is
 * read only in the hours after an incident, and once per account and sweep.
 * A failed read holds nothing back: the sweep is the safety net.
 */
async function sweepHeldForCatchUp(account: {
  id: string;
  connectionRecoveredAt?: Date | null;
  connectionCatchUpFrom?: Date | null;
}): Promise<boolean> {
  const now = Date.now();
  const recoveredAt = account.connectionRecoveredAt;
  if (!recoveredAt || now - recoveredAt.getTime() > CATCH_UP_SWEEP_HOLD_MAX_MS) {
    return false;
  }
  if (account.connectionCatchUpFrom) return catchUpHoldsSweep(account, now);
  const row = await prisma.instagramAccount
    .findUnique({
      where: { id: account.id },
      select: {
        connectionRecoveredAt: true,
        connectionCatchUpFrom: true,
        connectionCatchUpProgress: true,
        connectionCatchUpResult: true,
      },
    })
    .catch(() => null);
  return row ? catchUpHoldsSweep(row, now) : false;
}

/**
 * Reads shared by every campaign in one sweep.
 *
 * Campaigns of one account look at the same feed and the same comments. With a
 * dozen "any post" campaigns, reading them per campaign meant a dozen identical
 * reads of the media list and of every post's comments in each sweep: enough to
 * run into Meta's app request limit (error 4), which then also refused DMs. Each
 * read is made once per sweep and its result, or its failure, is shared. The
 * lookback is the same for the whole sweep, so it is not part of the key.
 */
interface SweepReads {
  media: Map<string, Promise<string[]>>;
  comments: Map<string, Promise<InstagramComment[]>>;
}

function recentMediaIds(
  reads: SweepReads,
  accountId: string,
  context: InstagramContext
): Promise<string[]> {
  let media = reads.media.get(accountId);
  if (!media) {
    // Page by page until the limit is reached, should Instagram return
    // fewer posts per page than asked for.
    media = getAllUserMedia({ context, max: RECENT_MEDIA_LIMIT }).then((rows) =>
      rows.map((m) => m.id)
    );
    reads.media.set(accountId, media);
  }
  return media;
}

function recentComments(
  reads: SweepReads,
  accountId: string,
  context: InstagramContext,
  mediaId: string,
  sinceMs: number
): Promise<InstagramComment[]> {
  const key = `${accountId}:${mediaId}`;
  let comments = reads.comments.get(key);
  if (!comments) {
    comments = getRecentMediaComments({ context, mediaId, sinceMs });
    reads.comments.set(key, comments);
  }
  return comments;
}

async function sweepCampaign({
  automation,
  sinceMs,
  tokenCache,
  reads,
}: {
  automation: {
    id: string;
    name: string;
    postId: string | null;
    matchAnyPost: boolean;
    matchAnyWord: boolean;
    keywords: string[];
    wholeWordMatch: boolean;
    ignoreQuestionComments: boolean;
    publicReplyEnabled: boolean;
    instagramAccount: {
      id: string;
      instagramId: string;
      username: string;
      accessToken: string;
      provider: "META" | "ZERNIO";
      metaLogin: "INSTAGRAM" | "UNIFIED";
      workspaceId: string;
      zernioAccountId: string | null;
    };
  };
  sinceMs: number;
  tokenCache: Map<string, InstagramContext | null>;
  reads: SweepReads;
}): Promise<SweepStat> {
  const account = automation.instagramAccount;
  const stat: SweepStat = {
    campaign: automation.name,
    keywords: automation.matchAnyWord
      ? "(any word)"
      : automation.keywords.join(","),
    matched: 0,
    alreadyReplied: 0,
    enqueued: 0,
    errors: [],
  };

  // Decrypt the account token once per sweep.
  let accessToken = tokenCache.get(account.id);
  if (accessToken === undefined) {
    try {
      accessToken = await createInstagramContext(account);
    } catch {
      accessToken = null;
    }
    tokenCache.set(account.id, accessToken);
  }
  if (!accessToken) {
    stat.errors.push("Failed to decrypt access token");
    return stat;
  }

  // Which media this campaign covers: its own post, or the recent feed if it
  // matches any post.
  const mediaIds: string[] = [];
  if (automation.postId) {
    mediaIds.push(automation.postId);
    mediaIds.push(...(await adMediaFor(automation.postId)));
  } else if (automation.matchAnyPost) {
    try {
      mediaIds.push(...(await recentMediaIds(reads, account.id, accessToken)));
    } catch (error) {
      if (isMetaThrottle(error)) {
        stat.limit = error;
        return stat;
      }
      stat.errors.push(`Media list: ${errMessage(error)}`);
    }
  }
  if (mediaIds.length === 0) return stat;

  // The comments the campaign still has to act on, from all of its posts.
  // The cap applies to the campaign, not to each post: per post, one sweep of
  // an any-post campaign over 30 posts could queue 900 private replies at
  // once, the burst that runs into Meta's request limits.
  const candidates: { comment: InstagramComment; mediaId: string }[] = [];

  for (const mediaId of mediaIds) {
    let comments: InstagramComment[];
    try {
      comments = await recentComments(
        reads,
        account.id,
        accessToken,
        mediaId,
        sinceMs
      );
    } catch (error) {
      // The remaining posts would be refused as well. What the posts before
      // brought is still queued below.
      if (isMetaThrottle(error)) {
        stat.limit = error;
        break;
      }
      stat.errors.push(`Comments ${mediaId}: ${errMessage(error)}`);
      continue;
    }

    // Keep only comments that (a) aren't the account's own, (b) match the
    // keyword, and (c) have no reply from the account owner yet.
    const needsAction = comments.filter((c) => {
      const authorId = c.from?.id;
      if (!authorId || authorId === account.instagramId) return false;

      // The worker's own rule (lib/automation/comment-match.ts), which the
      // Kommentare page uses too. Questions the campaign leaves to a human
      // are not work for the sweep: the worker skips them without writing a
      // log row, so nothing would ever mark them handled, and they would come
      // back every sweep for the whole lookback and use up places in the
      // per-sweep cap that comments the campaign does answer need.
      if (!matchCommentToCampaign(automation, c.text ?? "").matched) {
        return false;
      }
      stat.matched += 1;

      const ownerReplied = (c.replies?.data ?? []).some(
        (r) => r.from?.id === account.instagramId
      );
      if (ownerReplied) {
        stat.alreadyReplied += 1;
        return false;
      }
      return true;
    });
    if (needsAction.length === 0) continue;

    // Second guard against races: skip comments this campaign has already fully
    // handled. "Fully handled" depends on the campaign: if it posts a public
    // reply, the completion signal is publicReplySentAt (a DM alone is not
    // enough — the reply still has to land); otherwise a SENT DM is enough. This
    // is what lets a comment whose DM sent but whose public reply failed come
    // back and retry the reply. A comment another campaign answered is done
    // for this one whatever its settings: the private reply was used, and the
    // public reply is the answering campaign's.
    const logs = await prisma.dmLog.findMany({
      where: {
        automationId: automation.id,
        commentId: { in: needsAction.map((c) => c.id) },
      },
      select: {
        commentId: true, status: true, attempts: true, errorMessage: true,
        dmDeliveryUnconfirmed: true, publicReplySentAt: true,
        publicReplyDeliveryUnconfirmed: true,
      },
    });
    const handledSet = new Set(logs.filter((log) => {
      if (log.status === "SKIPPED_DEDUP") return true;
      const dmStopped = log.status === "SENT" || log.status === "SKIPPED_PLAN_LIMIT" ||
        log.dmDeliveryUnconfirmed || log.attempts >= MAX_COMMENT_SEND_ATTEMPTS ||
        (log.status === "FAILED" && hasLegacyUnconfirmedDelivery(log.errorMessage));
      const replyStopped = !automation.publicReplyEnabled ||
        log.publicReplySentAt || log.publicReplyDeliveryUnconfirmed;
      return dmStopped && replyStopped;
    }).map((log) => log.commentId));

    for (const comment of needsAction) {
      if (!handledSet.has(comment.id)) candidates.push({ comment, mediaId });
    }
  }

  // Oldest first across all the campaign's posts, so whoever commented
  // earliest gets answered first, capped. Feed order would let the newest
  // posts crowd out older comments that the lookback is about to drop.
  const fresh = candidates
    .sort(
      (a, b) => Date.parse(a.comment.timestamp) - Date.parse(b.comment.timestamp)
    )
    .slice(0, MAX_NEW_PER_SWEEP);

  const queue = getDMQueue();
  for (const { comment: c, mediaId } of fresh) {
    // No deterministic jobId here: a retained completed/failed job from an
    // earlier sweep would otherwise be treated as a duplicate and silently
    // drop this add, so the comment would never be retried. Dedup is handled
    // above and by the worker's atomic, durable per-leg claims. Send attempts
    // are counted in DmLog across jobs, so a sweep cannot reset the budget.
    await queue.add(COMMENT_JOB_NAME, {
      instagramAccountId: account.instagramId,
      accountConnectionId: account.id,
      commentId: c.id,
      commentText: c.text ?? "",
      commenterId: c.from!.id,
      commenterName: c.from?.username,
      mediaId,
      // When the sweep is looking at an ad, the campaign is bound to the post
      // the ad was made from: without this the worker matches nothing and
      // drops the comment, so the sweep would enqueue it again every five
      // minutes and never deliver it.
      originalMediaId:
        automation.postId && mediaId !== automation.postId
          ? automation.postId
          : undefined,
      source: "POLLING",
    });
    stat.enqueued += 1;
  }

  return stat;
}

/**
 * Ad copies of a post, as seen in webhooks already received.
 *
 * Boosting a post gives it a second media id: comments left on the ad arrive
 * with the ad's `media.id` and the post's id in `original_media_id`. The sweep
 * would otherwise only ever look at the post itself, so a comment Meta fails to
 * deliver on the ad is lost for good — exactly the case this safety net exists
 * for, and the one where volume is highest.
 *
 * The ad ids are recovered from the webhooks themselves rather than from the
 * ads API, which would need ads_management on top of the permissions the app
 * already asks for. The trade-off: an ad becomes visible to the sweep only once
 * a single comment on it has arrived. That is enough for the failure being
 * covered here, where some webhooks arrive and others do not.
 */
export async function adMediaFor(postId: string): Promise<string[]> {
  try {
    const rows = await prisma.$queryRaw<{ mediaId: string | null }[]>`
      SELECT DISTINCT change->'value'->'media'->>'id' AS "mediaId"
      FROM "WebhookEvent" w,
           jsonb_array_elements(w.payload::jsonb->'entry') entry,
           jsonb_array_elements(entry->'changes') change
      WHERE change->>'field' = 'comments'
        AND change->'value'->'media'->>'original_media_id' = ${postId}
        AND w."createdAt" > now() - interval '90 days'
    `;
    return rows
      .map((r) => r.mediaId)
      .filter((id): id is string => Boolean(id) && id !== postId);
  } catch {
    // A failure here must not stop the sweep: the post itself is still checked.
    return [];
  }
}

async function recordSweep(
  workspaceId: string,
  stat: SweepStat
): Promise<void> {
  // Only log when something happened or something went wrong.
  if (stat.enqueued === 0 && stat.errors.length === 0) return;

  await prisma.operationalEvent
    .create({
      data: {
        workspaceId,
        source: "SYSTEM",
        level: stat.errors.length > 0 ? "WARNING" : "INFO",
        message: `Comment sweep "${stat.campaign}" [${stat.keywords}]: ${stat.enqueued} enqueued, ${stat.matched} matched, ${stat.alreadyReplied} already replied`,
        // Not the request limit that may have ended the sweep: that one is
        // recorded on its own (recordSweepStopped).
        payload: {
          campaign: stat.campaign,
          keywords: stat.keywords,
          matched: stat.matched,
          alreadyReplied: stat.alreadyReplied,
          enqueued: stat.enqueued,
          errors: stat.errors,
        },
      },
    })
    .catch(() => {});
}

/**
 * One event for a sweep that a request limit ended: which campaign's read
 * Meta refused and how. The next sweep runs as scheduled.
 */
async function recordSweepStopped(
  automation: {
    name: string;
    workspaceId: string;
    instagramAccount: { instagramId: string; username: string };
  },
  limit: unknown
): Promise<void> {
  const account = automation.instagramAccount;
  await prisma.operationalEvent
    .create({
      data: {
        workspaceId: automation.workspaceId,
        source: "SYSTEM",
        level: "WARNING",
        message: `Comment sweep stopped early: Instagram request limit while reading for "${automation.name}" (@${account.username}); the next sweep tries again`,
        payload: {
          kind: SWEEP_LIMIT_EVENT,
          campaign: automation.name,
          account: account.username,
          instagramAccountId: account.instagramId,
          error: errMessage(limit),
        },
      },
    })
    .catch(() => {});
}
