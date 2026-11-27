import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import {
  INSIGHTS_CACHE_TTL_MS,
  OVERVIEW_CACHE_TTL_MS,
  insightsCacheKey,
  overviewCache,
  overviewCacheKey,
} from "@/lib/instagram/overview-cache";
import {
  getAllUserMedia,
  getMediaInsights,
  PermissionError,
  RateLimitError,
  TokenExpiredError,
  type InstagramMedia,
  type InstagramMediaInsights,
} from "@/lib/instagram/provider";
import { createInstagramContext } from "@/lib/instagram/provider";
import {
  ensureFollowerHistory,
  getFollowerHistory,
  getTodaysFollowerCount,
  type FollowerHistoryPoint,
} from "@/lib/reports/follower-history";

// Allow time for paginated media + per-post insight calls on larger accounts.
export const maxDuration = 60;

// Safety ceiling for "all time": bounds pagination so we can't hammer the
// API or time out.
const MAX_POSTS = 500;

// B13 (Meta submission plan, part B, S1c): views, reach, saves and shares
// come from one insights read per post. Only the newest INSIGHT_POSTS posts
// get one, from the 6-hour cache or with a call; larger ranges show likes and
// comments for every post and make no insights call beyond them. A Zernio
// account keeps its own reporting as before.
const INSIGHT_POSTS = 12;

// How many insight requests run at once.
const INSIGHTS_CONCURRENCY = 3;

// The range when none (or no valid one) is asked for.
const DEFAULT_COUNT = 12;

// The ranges the page offers besides "all" (app/(dashboard)/overview/page.tsx).
// Any other count reads as the default: each one would cost a Meta media read
// and a 10-minute cache key of its own in the Redis the queue shares.
const COUNTS: readonly number[] = [12, 25, 50, 100];

/** Map over items with a bounded number of in-flight async operations. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

export interface OverviewPost {
  id: string;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  mediaType: string;
  timestamp: string;
  views: number | null;
  reach: number | null;
  likes: number;
  comments: number;
  saved: number | null;
  shares: number | null;
}

export interface OverviewResponse {
  account: { id: string; username: string };
  accounts: Array<{ id: string; username: string }>;
  requestedCount: "all" | number;
  truncated: boolean;
  insightsAvailable: boolean;
  /**
   * How many of the newest posts views, reach, saves and shares cover (at
   * most 12 for an account connected through Meta). The totals of those four
   * sum only these posts.
   */
  insightPosts: number;
  /** When this answer was put together from Instagram (ISO time). */
  cachedAt: string;
  /** The answer came from the 10-minute cache, without a call to Instagram. */
  fromCache: boolean;
  /** Current follower total, or null if Instagram did not return it. */
  followers: number | null;
  /**
   * Follower total per day, ascending. Independent of the selected post range —
   * limited to what has been snapshotted plus any 30-day insights backfill.
   */
  followerHistory: FollowerHistoryPoint[];
  totals: {
    posts: number;
    views: number;
    reach: number;
    likes: number;
    comments: number;
    saved: number;
    shares: number;
    interactions: number;
  };
  posts: OverviewPost[];
  provider?: "META" | "ZERNIO";
  limitations?: string[];
}

/** What the 10-minute cache keeps: the answer without the workspace's accounts. */
type CachedOverview = Omit<OverviewResponse, "accounts" | "fromCache">;

function isVideoLike(media: InstagramMedia): boolean {
  return media.media_product_type === "REELS" || media.media_type === "VIDEO";
}

function workspaceAccounts(workspaceId: string) {
  return prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { id: true, username: true },
  });
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );

  if (!account) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Instagram account not connected. Please connect your account first.",
      },
      { status: 400 }
    );
  }

  // `count` is either "all" or one of COUNTS (last N posts).
  const countParam = request.nextUrl.searchParams.get("count");
  const isAll = countParam === "all";
  const parsedCount = countParam ? Number.parseInt(countParam, 10) : NaN;
  const requestedCount: "all" | number = isAll
    ? "all"
    : COUNTS.includes(parsedCount)
      ? parsedCount
      : DEFAULT_COUNT;

  const target = isAll
    ? MAX_POSTS
    : Math.min(requestedCount as number, MAX_POSTS);

  // Accounts connected through Meta read from and write to the cache; a
  // Zernio account is reported as before.
  const isMeta = account.provider !== "ZERNIO";
  const cache = overviewCache();
  const cacheKey = overviewCacheKey(account.id, isAll ? "all" : target);

  try {
    if (isMeta) {
      const cached = await cache.get<CachedOverview>(cacheKey);
      if (cached) {
        const data: OverviewResponse = {
          ...cached,
          accounts: await workspaceAccounts(workspaceId),
          fromCache: true,
        };
        return NextResponse.json({ success: true, data });
      }
    }

    const accessToken = await createInstagramContext(account);

    const media = await getAllUserMedia({ context: accessToken, max: target });
    const truncated =
      media.length >= MAX_POSTS ||
      (account.provider === "ZERNIO" && media.length >= 25);

    // Likes and comments come free with basic media fields. Views / reach /
    // saved / shares require the insights permission, so fetch them per media
    // (bounded concurrency, the newest INSIGHT_POSTS only) and degrade
    // gracefully if the token was granted before that scope. After a request
    // limit or a dead token the remaining posts are not asked.
    let insightsAvailable = false;
    let permissionDenied = false;
    let stopAsking = false;
    const insightMedia = isMeta ? media.slice(0, INSIGHT_POSTS) : media;

    const insights = await mapWithConcurrency(
      insightMedia,
      INSIGHTS_CONCURRENCY,
      async (m): Promise<InstagramMediaInsights | null> => {
        const key = insightsCacheKey(account.id, m.id);
        if (isMeta) {
          const stored = await cache.get<InstagramMediaInsights>(key);
          if (stored) {
            insightsAvailable = true;
            return stored;
          }
        }
        if (stopAsking) return null;
        const metrics = isVideoLike(m)
          ? ["views", "reach", "saved", "shares", "total_interactions"]
          : ["reach", "saved", "shares", "total_interactions"];
        try {
          const data = await getMediaInsights({
            context: accessToken,
            mediaId: m.id,
            metrics: metrics,
          });
          insightsAvailable = true;
          if (isMeta) await cache.set(key, data, INSIGHTS_CACHE_TTL_MS);
          return data;
        } catch (err) {
          if (err instanceof PermissionError) permissionDenied = true;
          if (err instanceof RateLimitError || err instanceof TokenExpiredError) {
            stopAsking = true;
          }
          return null;
        }
      }
    );

    const posts: OverviewPost[] = media.map((m, i) => {
      const ins = insights[i] ?? null;
      const likes = m.like_count ?? 0;
      const comments = m.comments_count ?? 0;
      return {
        id: m.id,
        caption: m.caption?.trim().slice(0, 120) ?? null,
        permalink: m.permalink ?? null,
        thumbnailUrl: m.thumbnail_url ?? m.media_url ?? null,
        mediaType: m.media_product_type ?? m.media_type,
        timestamp: m.timestamp,
        views: ins?.views ?? null,
        reach: ins?.reach ?? null,
        likes,
        comments,
        saved: ins?.saved ?? null,
        shares: ins?.shares ?? null,
      };
    });

    // Views, reach, saved and shares are null for posts without insights, so
    // their totals sum only the posts that have them.
    const totals = posts.reduce(
      (acc, p) => {
        acc.posts += 1;
        acc.views += p.views ?? 0;
        acc.reach += p.reach ?? 0;
        acc.likes += p.likes;
        acc.comments += p.comments;
        acc.saved += p.saved ?? 0;
        acc.shares += p.shares ?? 0;
        acc.interactions +=
          p.likes + p.comments + (p.saved ?? 0) + (p.shares ?? 0);
        return acc;
      },
      {
        posts: 0,
        views: 0,
        reach: 0,
        likes: 0,
        comments: 0,
        saved: 0,
        shares: 0,
        interactions: 0,
      }
    );

    const accounts = await workspaceAccounts(workspaceId);

    // Followers is a point-in-time figure and deliberately not part of
    // `totals`, which sums over the selected posts. A failure here must not
    // take down the rest of the overview. Today's count, once the daily cron
    // or an earlier open recorded it, needs no profile read.
    let followers: number | null = null;
    let followerHistory: FollowerHistoryPoint[] = [];
    try {
      followers =
        (isMeta ? await getTodaysFollowerCount(account.id) : null) ??
        (await ensureFollowerHistory(
          { id: account.id, instagramId: account.instagramId },
          accessToken
        ));
      followerHistory = await getFollowerHistory(account.id);
    } catch (err) {
      console.warn(
        "[Instagram Overview] Follower history unavailable:",
        err instanceof Error ? err.message : err
      );
    }

    const answer: CachedOverview = {
      account: { id: account.id, username: account.username },
      requestedCount,
      provider: account.provider,
      limitations:
        account.provider === "ZERNIO"
          ? [
              "Post reporting covers the 25 most recent Instagram posts.",
              "Insights and follower history require the Zernio Analytics add-on and reflect its last sync. Missing metrics remain unavailable.",
            ]
          : [],
      truncated,
      insightsAvailable: insightsAvailable && !permissionDenied,
      insightPosts: insightMedia.length,
      cachedAt: new Date().toISOString(),
      followers,
      followerHistory,
      totals,
      posts,
    };
    if (isMeta) await cache.set(cacheKey, answer, OVERVIEW_CACHE_TTL_MS);

    const data: OverviewResponse = { ...answer, accounts, fromCache: false };
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[Instagram Overview] Error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to load Instagram overview" },
      { status: 500 }
    );
  }
}
