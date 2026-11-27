/**
 * B13 (Meta submission plan, part B, S1c): GET /api/instagram/overview reads
 * insights for the 12 newest posts only, keeps each post's insights for 6
 * hours and the whole answer for 10 minutes, and takes today's follower
 * total from the daily snapshot when there is one. A Zernio account is
 * reported as before.
 *
 * The provider (Meta and Zernio), the database and the session are mocks,
 * Redis the in-memory stand-in on the faked clock. Nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mocks, mockPrisma, mockWorkspaceId, state } = vi.hoisted(() => ({
  mocks: {
    createInstagramContext: vi.fn(),
    getAllUserMedia: vi.fn(),
    getMediaInsights: vi.fn(),
    getUserInfo: vi.fn(),
    getFollowerCountSeries: vi.fn(),
    getZernioFollowerSnapshots: vi.fn(),
  },
  mockPrisma: {
    instagramAccount: { findFirst: vi.fn(), findMany: vi.fn() },
    followerSnapshot: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockWorkspaceId: vi.fn(),
  state: { redis: null as unknown },
}));

vi.mock("@/lib/instagram/provider", async () => {
  const meta = await vi.importActual<typeof import("../lib/meta/client")>("../lib/meta/client");
  return {
    MetaApiError: meta.MetaApiError,
    PermissionError: meta.PermissionError,
    RateLimitError: meta.RateLimitError,
    TokenExpiredError: meta.TokenExpiredError,
    ...mocks,
  };
});
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: mockWorkspaceId }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => state.redis }));

import { GET } from "../app/api/instagram/overview/route";
import { insightsCacheKey } from "../lib/instagram/overview-cache";
import { PermissionError, RateLimitError } from "../lib/meta/client";
import { FakeRedis } from "./helpers/fake-redis";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const META_ACCOUNT = {
  id: "account_1",
  workspaceId: "workspace_1",
  instagramId: "ig_owner",
  username: "studio",
  provider: "META",
  metaLogin: "UNIFIED",
  zernioAccountId: null,
  accessToken: "encrypted",
};
const ZERNIO_ACCOUNT = {
  ...META_ACCOUNT,
  id: "account_z",
  provider: "ZERNIO",
  zernioAccountId: "zernio_1",
  accessToken: "",
};

// 60 posts, newest first; every even one a reel.
const MEDIA = Array.from({ length: 60 }, (_, i) => ({
  id: `media-${i}`,
  caption: `Beitrag ${i}`,
  media_type: i % 2 === 0 ? "VIDEO" : "IMAGE",
  media_product_type: i % 2 === 0 ? "REELS" : "FEED",
  permalink: `https://www.instagram.com/p/${i}/`,
  timestamp: new Date(NOW - i * HOUR).toISOString(),
  like_count: 10,
  comments_count: 2,
}));

const INSIGHTS = { views: 100, reach: 80, saved: 5, shares: 3, total_interactions: 20 };

let redis: FakeRedis;

function request(query = "") {
  return GET(new NextRequest(`https://dm.example.test/api/instagram/overview${query}`));
}

async function overview(query = "") {
  const response = await request(query);
  expect(response.status).toBe(200);
  return (await response.json()).data;
}

const insightCalls = () =>
  mocks.getMediaInsights.mock.calls.map(([args]) => (args as { mediaId: string }).mediaId);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  redis = new FakeRedis();
  state.redis = redis;
  mockWorkspaceId.mockResolvedValue("workspace_1");
  mockPrisma.instagramAccount.findFirst.mockResolvedValue(META_ACCOUNT);
  mockPrisma.instagramAccount.findMany.mockResolvedValue([{ id: "account_1", username: "studio" }]);
  mockPrisma.followerSnapshot.findUnique.mockResolvedValue(null);
  mockPrisma.followerSnapshot.findMany.mockResolvedValue([]);
  mockPrisma.followerSnapshot.upsert.mockResolvedValue({});
  mockPrisma.followerSnapshot.count.mockResolvedValue(10);
  mocks.createInstagramContext.mockImplementation(async (account: { provider: string }) =>
    account.provider === "ZERNIO"
      ? { provider: "ZERNIO", apiKey: "zk", accountId: "zernio_1", instagramId: "ig_owner" }
      : { provider: "META", accessToken: "local-test-token", instagramId: "ig_owner", unifiedLogin: true }
  );
  mocks.getAllUserMedia.mockImplementation(async ({ max }: { max: number }) => MEDIA.slice(0, max));
  mocks.getMediaInsights.mockImplementation(async ({ metrics }: { metrics: string[] }) =>
    metrics.includes("views") ? { ...INSIGHTS } : { reach: 40, saved: 1, shares: 1, total_interactions: 5 }
  );
  mocks.getUserInfo.mockResolvedValue({ id: "ig_owner", username: "studio", followers_count: 999 });
  mocks.getFollowerCountSeries.mockResolvedValue(null);
  mocks.getZernioFollowerSnapshots.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("insights for the 12 newest posts", () => {
  it("opens with the 12 newest posts by default", async () => {
    const data = await overview();
    expect(mocks.getAllUserMedia).toHaveBeenCalledWith(expect.objectContaining({ max: 12 }));
    expect(data.requestedCount).toBe(12);
    expect(data.posts).toHaveLength(12);
    expect(data.insightPosts).toBe(12);
    expect(insightCalls()).toHaveLength(12);
  });

  it("asks for at most 12 posts' insights for the last 50, and shows likes and comments for all", async () => {
    const data = await overview("?count=50");
    expect(insightCalls()).toEqual(MEDIA.slice(0, 12).map((m) => m.id));
    expect(data.posts).toHaveLength(50);
    expect(data.insightPosts).toBe(12);
    expect(data.insightsAvailable).toBe(true);
    expect(data.posts[11].reach).toBe(40);
    expect(data.posts[12]).toMatchObject({ views: null, reach: null, saved: null, shares: null, likes: 10, comments: 2 });
    // Views, reach, saved and shares sum only the 12 posts with insights
    // (6 reels and 6 images); likes and comments all 50.
    expect(data.totals).toMatchObject({
      posts: 50,
      views: 6 * 100,
      reach: 6 * 80 + 6 * 40,
      saved: 6 * 5 + 6 * 1,
      shares: 6 * 3 + 6 * 1,
      likes: 50 * 10,
      comments: 50 * 2,
    });
  });

  it("asks for at most 12 posts' insights for all time too", async () => {
    const data = await overview("?count=all");
    expect(mocks.getAllUserMedia).toHaveBeenCalledWith(expect.objectContaining({ max: 500 }));
    expect(data.requestedCount).toBe("all");
    expect(data.posts).toHaveLength(60);
    expect(insightCalls()).toHaveLength(12);
  });

  it("makes no call for a post whose insights are stored", async () => {
    await redis.set(
      insightsCacheKey("account_1", "media-3"),
      JSON.stringify({ reach: 7, saved: 7, shares: 7, total_interactions: 7 }),
      "PX",
      String(6 * HOUR)
    );
    const data = await overview();
    expect(insightCalls()).toHaveLength(11);
    expect(insightCalls()).not.toContain("media-3");
    expect(data.posts[3]).toMatchObject({ reach: 7, saved: 7, shares: 7 });
  });

  it("keeps each post's insights for 6 hours", async () => {
    await overview();
    expect(insightCalls()).toHaveLength(12);

    // The whole answer is older than 10 minutes: the posts are read again,
    // their insights come from the 6-hour store.
    vi.setSystemTime(NOW + 11 * MINUTE);
    const later = await overview();
    expect(mocks.getAllUserMedia).toHaveBeenCalledTimes(2);
    expect(insightCalls()).toHaveLength(12);
    expect(later.fromCache).toBe(false);
    expect(later.totals.views).toBe(6 * 100);

    vi.setSystemTime(NOW + 6 * HOUR + MINUTE);
    await overview();
    expect(insightCalls()).toHaveLength(24);
  });

  it("still reports missing insight permission", async () => {
    mocks.getMediaInsights.mockRejectedValue(new PermissionError("(#10) no permission"));
    const data = await overview();
    expect(data.insightsAvailable).toBe(false);
    expect(data.totals.views).toBe(0);
    expect(data.posts[0].views).toBeNull();

    // One refused post among working ones: as before, the page asks to reconnect.
    mocks.getMediaInsights.mockReset();
    mocks.getMediaInsights.mockImplementation(async ({ mediaId }: { mediaId: string }) => {
      if (mediaId === "media-5") throw new PermissionError("(#10) no permission");
      return { ...INSIGHTS };
    });
    const mixed = await overview("?count=25");
    expect(mixed.insightsAvailable).toBe(false);
  });

  it("stops asking after a request limit", async () => {
    mocks.getMediaInsights.mockRejectedValue(new RateLimitError("(#4) limit", undefined, undefined, 4));
    const data = await overview();
    expect(insightCalls().length).toBeLessThanOrEqual(3);
    expect(data.posts).toHaveLength(12);
  });
});

describe("the 10-minute answer", () => {
  it("makes no Instagram call when the page is opened again within 10 minutes", async () => {
    const first = await overview("?count=25");
    expect(first.fromCache).toBe(false);
    expect(first.cachedAt).toBe(new Date(NOW).toISOString());
    vi.clearAllMocks();
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "account_1", username: "studio" },
      { id: "account_2", username: "second" },
    ]);

    vi.setSystemTime(NOW + 9 * MINUTE);
    const again = await overview("?count=25");
    expect(again.fromCache).toBe(true);
    expect(again.cachedAt).toBe(first.cachedAt);
    expect(again.posts).toEqual(first.posts);
    expect(again.totals).toEqual(first.totals);
    // The workspace's accounts are read fresh from the database.
    expect(again.accounts).toHaveLength(2);
    expect(mocks.createInstagramContext).not.toHaveBeenCalled();
    expect(mocks.getAllUserMedia).not.toHaveBeenCalled();
    expect(mocks.getMediaInsights).not.toHaveBeenCalled();
    expect(mocks.getUserInfo).not.toHaveBeenCalled();
  });

  it("reads a range the page does not offer as the default, without a media read or a key of its own", async () => {
    await overview("?count=12");
    for (const count of ["13", "499", "1", "0", "-5", "abc"]) {
      const data = await overview(`?count=${count}`);
      expect(data.requestedCount, count).toBe(12);
      expect(data.fromCache, count).toBe(true);
    }
    expect(mocks.getAllUserMedia).toHaveBeenCalledTimes(1);
    expect([...redis.strings.keys()].filter((key) => key.startsWith("overview:"))).toEqual([
      "overview:v1:account_1:12",
    ]);
  });

  it("keeps each range apart", async () => {
    await overview("?count=12");
    const fifty = await overview("?count=50");
    expect(fifty.fromCache).toBe(false);
    expect(fifty.posts).toHaveLength(50);
    expect(mocks.getAllUserMedia).toHaveBeenCalledTimes(2);
    // The second range reuses the 12 posts' stored insights.
    expect(insightCalls()).toHaveLength(12);
  });

  it("reads Instagram as before when Redis does not work", async () => {
    state.redis = {
      get: vi.fn().mockRejectedValue(new Error("down")),
      set: vi.fn().mockRejectedValue(new Error("down")),
    };
    await overview();
    await overview();
    expect(mocks.getAllUserMedia).toHaveBeenCalledTimes(2);
    expect(insightCalls()).toHaveLength(24);
    // After the first failure a request leaves the cache alone.
    expect((state.redis as { get: ReturnType<typeof vi.fn> }).get).toHaveBeenCalledTimes(2);
  });
});

describe("followers", () => {
  it("takes today's total from the daily snapshot without asking Instagram", async () => {
    mockPrisma.followerSnapshot.findUnique.mockResolvedValue({ followersCount: 1234, backfilled: false });
    const data = await overview();
    expect(data.followers).toBe(1234);
    expect(mocks.getUserInfo).not.toHaveBeenCalled();
    expect(mockPrisma.followerSnapshot.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          instagramAccountId_date: {
            instagramAccountId: "account_1",
            date: new Date("2026-11-27T00:00:00.000Z"),
          },
        },
      })
    );
  });

  it("reads the profile once when there is no snapshot of today yet", async () => {
    const data = await overview();
    expect(data.followers).toBe(999);
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(1);
    expect(mockPrisma.followerSnapshot.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not take a backfilled estimate for today's total", async () => {
    mockPrisma.followerSnapshot.findUnique.mockResolvedValue({ followersCount: 1, backfilled: true });
    const data = await overview();
    expect(data.followers).toBe(999);
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(1);
  });
});

describe("an account connected through Zernio", () => {
  it("is reported as before: every listed post's insights, no cache", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(ZERNIO_ACCOUNT);
    mocks.getAllUserMedia.mockImplementation(async ({ max }: { max: number }) =>
      MEDIA.slice(0, Math.min(max, 25))
    );
    const data = await overview("?count=25");
    expect(data.provider).toBe("ZERNIO");
    expect(data.posts).toHaveLength(25);
    expect(insightCalls()).toHaveLength(25);
    expect(data.insightPosts).toBe(25);
    expect(data.truncated).toBe(true);
    expect(data.limitations).toHaveLength(2);
    expect(mocks.getZernioFollowerSnapshots).toHaveBeenCalledTimes(1);
    expect(mockPrisma.followerSnapshot.findUnique).not.toHaveBeenCalled();
    expect(redis.commands).toEqual([]);

    const again = await overview("?count=25");
    expect(again.fromCache).toBe(false);
    expect(mocks.getAllUserMedia).toHaveBeenCalledTimes(2);
    expect(insightCalls()).toHaveLength(50);
  });
});

describe("refusals", () => {
  it("answers 401 without a session and 400 without an account, before any read", async () => {
    mockWorkspaceId.mockResolvedValueOnce(null);
    expect((await request()).status).toBe(401);
    mockPrisma.instagramAccount.findFirst.mockResolvedValueOnce(null);
    expect((await request()).status).toBe(400);
    expect(mocks.getAllUserMedia).not.toHaveBeenCalled();
    expect(redis.commands).toEqual([]);
  });
});
