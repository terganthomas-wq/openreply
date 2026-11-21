/**
 * Comment reconciliation — ad copies of a boosted post.
 *
 * Comments left on an ad carry the ad's own media id, so the sweep has to look
 * at those media too or a webhook Meta never delivers is lost for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, queueAdd, readComments, readMedia } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRaw: vi.fn(),
    automation: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  queueAdd: vi.fn(),
  readComments: vi.fn(),
  readMedia: vi.fn(),
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: queueAdd }),
  COMMENT_JOB_NAME: "process-comment",
}));
vi.mock("@/lib/instagram/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instagram/provider")>()),
  createInstagramContext: async () => ({
    provider: "META",
    accessToken: "local-test",
  }),
  getRecentMediaComments: readComments,
  getUserMedia: readMedia,
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  adMediaFor,
  reconcileComments,
} from "../lib/polling/comment-reconciler";

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
