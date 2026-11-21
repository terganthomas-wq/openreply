/**
 * Comment reconciliation — ad copies of a boosted post.
 *
 * Comments left on an ad carry the ad's own media id, so the sweep has to look
 * at those media too or a webhook Meta never delivers is lost for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, queueAdd, readComments, readMedia, redis } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRaw: vi.fn(),
    automation: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  queueAdd: vi.fn(),
  readComments: vi.fn(),
  readMedia: vi.fn(),
  redis: { current: null as unknown },
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: queueAdd }),
  getRedisConnection: () => redis.current,
  COMMENT_JOB_NAME: "process-comment",
}));
vi.mock("@/lib/instagram/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instagram/provider")>()),
  createInstagramContext: async () => ({
    provider: "META",
    accessToken: "local-test",
  }),
  getRecentMediaComments: readComments,
  // The sweep pages through the feed up to its limit (COMMENT_POLL_MEDIA_LIMIT).
  getAllUserMedia: readMedia,
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { RateLimitError } from "@/lib/meta/client";
import {
  adMediaFor,
  commentPollMediaLimit,
  reconcileComments,
} from "../lib/polling/comment-reconciler";
import { FakeRedis } from "./helpers/fake-redis";

beforeEach(() => {
  // An empty Redis: no account is paused.
  redis.current = new FakeRedis();
});

const POST = "18023946917554990";
const AD = "17899788633163100";

describe("adMediaFor", () => {
  beforeEach(() => {
    mockPrisma.$queryRaw.mockReset();
  });

  it("returns the ad media ids seen for the post", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("never returns the post itself, so it is not swept twice", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { mediaId: AD },
      { mediaId: POST },
    ]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("drops rows without a media id", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { mediaId: null },
      { mediaId: AD },
    ]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("returns nothing when the post was never boosted", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });

  it("swallows a query failure, leaving the post itself still swept", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("connection lost"));
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });
});

describe("comment polling does not recreate unsafe sends", () => {
  beforeEach(() => {
    queueAdd.mockReset();
    mockPrisma.operationalEvent.create.mockResolvedValue({});
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "campaign",
        name: "Campaign",
        workspaceId: "workspace",
        postId: POST,
        matchAnyWord: false,
        keywords: ["AI"],
        publicReplyEnabled: true,
        instagramAccount: {
          id: "connection",
          instagramId: "owner",
          provider: "META",
          accessToken: "test",
        },
      },
    ]);
    readComments.mockResolvedValue([
      {
        id: "old",
        text: "AI",
        from: { id: "reader" },
        timestamp: new Date().toISOString(),
      },
      {
        id: "new",
        text: "AI",
        from: { id: "another-reader" },
        timestamp: new Date().toISOString(),
      },
    ]);
  });
  it.each([
    { status: "FAILED", attempts: 1, dmDeliveryUnconfirmed: true },
    { status: "FAILED", attempts: 3, dmDeliveryUnconfirmed: false },
    {
      status: "FAILED",
      attempts: 1,
      errorMessage: "MetaApiError 1: An unknown error has occurred.",
    },
    { status: "PENDING", attempts: 1, dmDeliveryUnconfirmed: true },
  ])(
    "leaves an unsafe old comment alone while continuing new comments: %j",
    async (state) => {
      mockPrisma.dmLog.findMany.mockResolvedValue([
        { commentId: "old", publicReplySentAt: new Date(), ...state },
      ]);
      await reconcileComments();
      await reconcileComments();
      expect(queueAdd).toHaveBeenCalledTimes(2);
      for (const [name, data] of queueAdd.mock.calls) {
        // The worker runs only this name as a comment; any other is ignored.
        expect(name).toBe("process-comment");
        expect(data.commentId).toBe("new");
      }
    },
  );
});

describe("comments the worker leaves alone are not swept again", () => {
  const campaign = {
    id: "campaign",
    name: "Campaign",
    workspaceId: "workspace",
    postId: POST,
    matchAnyPost: false,
    matchAnyWord: false,
    keywords: ["AI"],
    wholeWordMatch: true,
    publicReplyEnabled: true,
    instagramAccount: {
      id: "connection",
      instagramId: "owner",
      provider: "META",
      accessToken: "test",
    },
  };

  function enqueuedComments(): string[] {
    return queueAdd.mock.calls.map(([, data]) => data.commentId).sort();
  }

  beforeEach(() => {
    queueAdd.mockReset();
    mockPrisma.automation.findMany.mockReset();
    mockPrisma.operationalEvent.create.mockResolvedValue({});
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.dmLog.findMany.mockResolvedValue([]);
    readComments.mockResolvedValue([
      {
        id: "question",
        text: "Is AI free?",
        from: { id: "reader" },
        timestamp: new Date().toISOString(),
      },
      {
        id: "request",
        text: "AI",
        from: { id: "another-reader" },
        timestamp: new Date().toISOString(),
      },
    ]);
  });

  it("reads the question setting with the campaigns", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);

    await reconcileComments();

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ ignoreQuestionComments: true }),
      })
    );
  });

  it("does not enqueue a question the campaign leaves to a human", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...campaign, ignoreQuestionComments: true },
    ]);

    await reconcileComments();

    expect(enqueuedComments()).toEqual(["request"]);
  });

  it("enqueues the question when the campaign takes questions", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...campaign, ignoreQuestionComments: false },
    ]);

    await reconcileComments();

    expect(enqueuedComments()).toEqual(["question", "request"]);
  });

  it("treats a comment another campaign answered as handled, even with a public reply due", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);
    mockPrisma.dmLog.findMany.mockResolvedValue([
      {
        commentId: "request",
        status: "SKIPPED_DEDUP",
        attempts: 0,
        errorMessage: "Another campaign (Other) already sent the one private reply",
        dmDeliveryUnconfirmed: false,
        publicReplySentAt: null,
        publicReplyDeliveryUnconfirmed: false,
      },
    ]);

    await reconcileComments();

    expect(enqueuedComments()).toEqual(["question"]);
  });
});

describe("campaigns of one account share the sweep's reads", () => {
  const account = {
    id: "connection",
    instagramId: "owner",
    provider: "META",
    accessToken: "test",
  };
  const anyPost = (id: string, keyword: string) => ({
    id,
    name: id,
    workspaceId: "workspace",
    postId: null,
    matchAnyPost: true,
    matchAnyWord: false,
    keywords: [keyword],
    wholeWordMatch: true,
    ignoreQuestionComments: true,
    publicReplyEnabled: true,
    instagramAccount: account,
  });
  const comment = (id: string, text: string) => ({
    id,
    text,
    from: { id: `reader-${id}` },
    timestamp: new Date().toISOString(),
  });

  beforeEach(() => {
    queueAdd.mockReset();
    readMedia.mockReset();
    readComments.mockReset();
    mockPrisma.automation.findMany.mockReset();
    mockPrisma.operationalEvent.create.mockReset();
    mockPrisma.operationalEvent.create.mockResolvedValue({});
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.dmLog.findMany.mockResolvedValue([]);
    readMedia.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    readComments.mockImplementation(async ({ mediaId }: { mediaId: string }) =>
      mediaId === "m1"
        ? [comment("c1", "SCHIMMEL"), comment("c2", "HEIZUNG")]
        : [comment("c3", "Heizung bitte")]
    );
  });

  it("reads the feed once and every post's comments once, however many campaigns", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      anyPost("schimmel", "SCHIMMEL"),
      anyPost("heizung", "HEIZUNG"),
      anyPost("kalt", "KALT"),
    ]);

    await reconcileComments();

    expect(readMedia).toHaveBeenCalledTimes(1);
    expect(
      readComments.mock.calls.map(([args]) => args.mediaId).sort()
    ).toEqual(["m1", "m2"]);
    // Each campaign still acts on its own matches.
    expect(
      queueAdd.mock.calls.map(([, data]) => data.commentId).sort()
    ).toEqual(["c1", "c2", "c3"]);
  });

  it("shares a post's comments between its own campaign and an any-post campaign", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...anyPost("post", "HEIZUNG"), postId: "m1", matchAnyPost: false },
      anyPost("schimmel", "SCHIMMEL"),
    ]);

    await reconcileComments();

    expect(
      readComments.mock.calls.map(([args]) => args.mediaId).sort()
    ).toEqual(["m1", "m2"]);
  });

  it("reads again in the next sweep", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      anyPost("schimmel", "SCHIMMEL"),
    ]);

    await reconcileComments();
    await reconcileComments();

    expect(readMedia).toHaveBeenCalledTimes(2);
    expect(readComments).toHaveBeenCalledTimes(4);
  });

  it("shares a failed read without retrying it for every campaign", async () => {
    readMedia.mockRejectedValue(new Error("Application request limit reached"));
    mockPrisma.automation.findMany.mockResolvedValue([
      anyPost("schimmel", "SCHIMMEL"),
      anyPost("heizung", "HEIZUNG"),
    ]);

    await reconcileComments();

    expect(readMedia).toHaveBeenCalledTimes(1);
    expect(readComments).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
    // Each campaign records the failure in its own sweep event.
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(2);
  });
});

describe("how many posts an any-post sweep reads", () => {
  it.each([
    [undefined, 10],
    ["", 10],
    ["abc", 10],
    ["30", 30],
    ["1", 1],
    ["0", 1],
    ["-4", 1],
    ["12.8", 12],
    ["50", 50],
    ["51", 50],
    ["1000", 50],
  ])("reads COMMENT_POLL_MEDIA_LIMIT=%j as %i", (value, limit) => {
    expect(commentPollMediaLimit(value)).toBe(limit);
  });

  const anyPost = {
    id: "any",
    name: "Any post",
    workspaceId: "workspace",
    postId: null,
    matchAnyPost: true,
    matchAnyWord: true,
    keywords: [],
    wholeWordMatch: true,
    ignoreQuestionComments: false,
    publicReplyEnabled: false,
    instagramAccount: {
      id: "connection",
      instagramId: "owner",
      username: "studio",
      provider: "META",
      accessToken: "test",
    },
  };

  beforeEach(() => {
    readMedia.mockReset().mockResolvedValue([]);
    readComments.mockReset().mockResolvedValue([]);
    mockPrisma.automation.findMany.mockReset().mockResolvedValue([anyPost]);
    mockPrisma.operationalEvent.create.mockReset().mockResolvedValue({});
  });

  it("asks for the ten newest posts by default, page by page", async () => {
    await reconcileComments();
    expect(readMedia).toHaveBeenCalledWith(expect.objectContaining({ max: 10 }));
  });

  it("asks for as many as COMMENT_POLL_MEDIA_LIMIT says", async () => {
    vi.stubEnv("COMMENT_POLL_MEDIA_LIMIT", "30");
    vi.resetModules();
    const fresh = await import("../lib/polling/comment-reconciler");
    await fresh.reconcileComments();
    expect(readMedia).toHaveBeenCalledWith(expect.objectContaining({ max: 30 }));
    vi.unstubAllEnvs();
  });

  it("reads every post it gets, however old, for the comments of the lookback", async () => {
    // An eleventh-newest reel from three weeks ago still gets swept.
    readMedia.mockResolvedValue(
      Array.from({ length: 11 }, (_, i) => ({ id: `m${i + 1}` }))
    );
    await reconcileComments();
    expect(readComments.mock.calls.map(([args]) => args.mediaId)).toEqual(
      Array.from({ length: 11 }, (_, i) => `m${i + 1}`)
    );
  });
});

// R1: a read Meta refuses with a request limit ends the sweep there, recorded
// once; an account paused for a limit is not swept until the pause is over.
describe("the sweep and Meta's request limits", () => {
  const account = (id: string) => ({
    id: `connection-${id}`,
    instagramId: `owner-${id}`,
    username: `studio_${id}`,
    provider: "META",
    accessToken: "test",
  });
  const anyPost = (id: string, accountId = "a") => ({
    id,
    name: id,
    workspaceId: "workspace",
    postId: null,
    matchAnyPost: true,
    matchAnyWord: true,
    keywords: [],
    wholeWordMatch: true,
    ignoreQuestionComments: false,
    publicReplyEnabled: false,
    instagramAccount: account(accountId),
  });
  const limit = (code: number) =>
    new RateLimitError(
      "(#4) Application request limit reached (/v25.0/owner-a/media) [code=4 sub=- type=OAuthException trace=t]",
      "t",
      undefined,
      code
    );
  const comment = (id: string) => ({
    id,
    text: "LINK",
    from: { id: `reader-${id}` },
    timestamp: new Date().toISOString(),
  });

  beforeEach(() => {
    queueAdd.mockReset();
    readMedia.mockReset().mockResolvedValue([{ id: "m1" }, { id: "m2" }, { id: "m3" }]);
    readComments.mockReset().mockResolvedValue([]);
    mockPrisma.automation.findMany.mockReset();
    mockPrisma.operationalEvent.create.mockReset().mockResolvedValue({});
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.dmLog.findMany.mockResolvedValue([]);
  });

  function events() {
    return mockPrisma.operationalEvent.create.mock.calls.map(([args]) => args.data);
  }

  it.each([4, 17, 32, 613, 80002, 80006, 368])(
    "stops the whole sweep when the feed read hits code %i, and records it once",
    async (code) => {
      readMedia.mockRejectedValue(limit(code));
      mockPrisma.automation.findMany.mockResolvedValue([
        anyPost("first"),
        anyPost("second"),
        anyPost("other-account", "b"),
      ]);

      await reconcileComments();

      // Not the second campaign, not the other account: every read would be
      // refused as well.
      expect(readMedia).toHaveBeenCalledTimes(1);
      expect(readComments).not.toHaveBeenCalled();
      expect(events()).toEqual([
        {
          workspaceId: "workspace",
          source: "SYSTEM",
          level: "WARNING",
          message:
            'Comment sweep stopped early: Instagram request limit while reading for "first" (@studio_a); the next sweep tries again',
          payload: {
            kind: "sweep-limit",
            campaign: "first",
            account: "studio_a",
            instagramAccountId: "owner-a",
            error: expect.stringContaining(`Meta ${code}:`),
          },
        },
      ]);
    }
  );

  it("stops at the post whose comments hit the limit and keeps what it queued", async () => {
    readComments.mockImplementation(async ({ mediaId }: { mediaId: string }) => {
      if (mediaId === "m1") return [comment("c1")];
      throw limit(4);
    });
    mockPrisma.automation.findMany.mockResolvedValue([
      anyPost("first"),
      anyPost("second"),
    ]);

    await reconcileComments();

    // m3 is never read, nor the second campaign.
    expect(readComments.mock.calls.map(([args]) => args.mediaId)).toEqual(["m1", "m2"]);
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0][1].commentId).toBe("c1");
    const recorded = events();
    expect(recorded).toHaveLength(2);
    // The campaign's own line, without the limit among its errors.
    expect(recorded[0]).toMatchObject({
      level: "INFO",
      payload: { enqueued: 1, errors: [] },
    });
    expect(recorded[1].payload.kind).toBe("sweep-limit");
  });

  it("still records other read failures per campaign and goes on", async () => {
    readMedia.mockRejectedValue(new Error("socket hang up"));
    mockPrisma.automation.findMany.mockResolvedValue([
      anyPost("first"),
      anyPost("other-account", "b"),
    ]);

    await reconcileComments();

    expect(readMedia).toHaveBeenCalledTimes(2);
    expect(events().map((e) => e.level)).toEqual(["WARNING", "WARNING"]);
    expect(events().some((e) => e.payload.kind === "sweep-limit")).toBe(false);
  });

  it("does not sweep an account while its sending is paused", async () => {
    const fake = new FakeRedis();
    redis.current = fake;
    await fake.set(
      "meta:pause:owner-a",
      String(Date.now() + 15 * 60_000),
      "PX",
      15 * 60_000
    );
    readComments.mockResolvedValue([comment("c1")]);
    mockPrisma.automation.findMany.mockResolvedValue([
      anyPost("first"),
      anyPost("second"),
      anyPost("other-account", "b"),
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await reconcileComments();

    // Only the other account's campaign read anything, and the pause is
    // looked up once per account.
    expect(readMedia).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls.map(([, data]) => data.instagramAccountId)).toEqual(
      Array(3).fill("owner-b")
    );
    expect(fake.commands.filter((c) => c === "GET meta:pause:owner-a")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("@studio_a is paused"));
    log.mockRestore();
  });
});
