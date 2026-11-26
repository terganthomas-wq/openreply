/**
 * The Kommentare page's API (M1): GET /api/instagram/comments and
 * POST /api/instagram/comments/send.
 *
 * The database is a mock, Redis an in-memory stand-in (account pause, cache,
 * rate limit, worker heartbeat), the queue a mock, and Meta is fetch
 * answered here: every Graph call the routes make is counted, and none
 * leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockContext, mockQueueAdd, redis } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findFirst: vi.fn(), findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
  },
  mockContext: vi.fn(),
  mockQueueAdd: vi.fn(),
  redis: { current: null as unknown },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({
  getCurrentUserId: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
}));
// The real role check; only the signed-in context is replaced.
vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/workspace-access")>()),
  getCurrentWorkspaceContext: mockContext,
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd }),
  getRedisConnection: () => redis.current,
  COMMENT_JOB_NAME: "process-comment",
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "local-test-token" }));

import { GET } from "../app/api/instagram/comments/route";
import { POST } from "../app/api/instagram/comments/send/route";
import {
  MANUAL_SEND_ACCOUNT_LIMIT,
  MANUAL_SEND_RATE_LIMIT,
  MANUAL_SEND_SPACING_MS,
} from "../lib/comments/manual";
import { FakeRedis } from "./helpers/fake-redis";

const NOW = new Date("2026-11-25T18:00:00.000Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WORKSPACE = "workspace_1";
const GRAPH = "https://graph.facebook.com/v25.0";

const ACCOUNT = {
  id: "account_1",
  workspaceId: WORKSPACE,
  instagramId: "ig_owner",
  username: "thomas.tergan",
  name: null,
  provider: "META",
  metaLogin: "UNIFIED",
  zernioAccountId: null,
  accessToken: "encrypted",
  tokenExpiresAt: null,
  webhookSubscribed: true,
  connectedAt: new Date(NOW - 30 * DAY),
  updatedAt: new Date(NOW - 30 * DAY),
};

function context(role: "OWNER" | "ADMIN" | "MEMBER" = "OWNER", userId = "user_1") {
  return { userId, workspaceId: WORKSPACE, role, workspace: { id: WORKSPACE } };
}

// The account's campaigns as the page loads them, oldest first.
const CAMPAIGNS = [
  {
    id: "c_any",
    name: "Guide (alle Beiträge)",
    isActive: true,
    postId: null,
    matchAnyPost: true,
    keywords: ["GUIDE"],
    matchAnyWord: false,
    wholeWordMatch: true,
    ignoreQuestionComments: true,
    dmMessage: "Hier ist dein Guide",
    publicReplyMessage: null,
    publicReplyMessages: ["Schau in deine DMs"],
  },
  {
    id: "c_post",
    name: "Guide (Reel 1)",
    isActive: true,
    postId: "media_1",
    matchAnyPost: false,
    keywords: ["GUIDE"],
    matchAnyWord: false,
    wholeWordMatch: true,
    ignoreQuestionComments: false,
    dmMessage: "Hier ist dein Guide fürs Reel",
    publicReplyMessage: null,
    publicReplyMessages: [],
  },
  {
    id: "c_paused",
    name: "Alt",
    isActive: false,
    postId: null,
    matchAnyPost: true,
    keywords: ["KALLT"],
    matchAnyWord: false,
    wholeWordMatch: true,
    ignoreQuestionComments: false,
    dmMessage: "Alt",
    publicReplyMessage: "Schau rein",
    publicReplyMessages: [],
  },
  {
    id: "c_empty",
    name: "Nur Tags",
    isActive: true,
    postId: null,
    matchAnyPost: true,
    keywords: ["X"],
    matchAnyWord: false,
    wholeWordMatch: true,
    ignoreQuestionComments: false,
    dmMessage: "  ",
    publicReplyMessage: null,
    publicReplyMessages: [],
  },
];

const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "+0000");

function comment(
  id: string,
  text: string,
  ageMs: number,
  from: { id: string; username?: string } = { id: `person_${id}`, username: `user_${id}` },
  replies: { id: string; from?: { id: string } }[] = []
) {
  return { id, text, timestamp: iso(NOW - ageMs), from, replies: { data: replies } };
}

// What Meta has: posts newest first, their comments newest first.
let media: { id: string; permalink: string; comments_count?: number }[];
let comments: Record<string, ReturnType<typeof comment>[]>;
let commentById: Record<string, unknown>;
let graphErrors: Record<string, { code: number; subcode?: number }>;
let graphCalls: URL[];

function graphError(code: number, subcode?: number) {
  return new Response(
    JSON.stringify({
      error: {
        code,
        error_subcode: subcode,
        type: "OAuthException",
        message: code === 4 ? "(#4) Application request limit reached" : "Unsupported get request",
        fbtrace_id: "trace",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

function installGraph() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    graphCalls.push(url);
    // A Unified login token: graph.facebook.com, the account named by its id.
    expect(`${url.origin}${url.pathname}`.startsWith(`${GRAPH}/`)).toBe(true);
    expect(url.searchParams.get("access_token")).toBe("local-test-token");
    const path = url.pathname.slice("/v25.0/".length);
    const failure = graphErrors[path];
    if (failure) return graphError(failure.code, failure.subcode);
    if (path === "ig_owner/media") {
      const limit = Number(url.searchParams.get("limit"));
      return Response.json({
        data: media.slice(0, limit),
        ...(media.length > limit ? { paging: { next: "https://graph.example/never" } } : {}),
      });
    }
    const list = path.match(/^(.+)\/comments$/);
    if (list) {
      expect(url.searchParams.get("fields")).toBe("id,text,timestamp,from,replies{from}");
      expect(url.searchParams.get("limit")).toBe("50");
      return Response.json({
        data: comments[list[1]] ?? [],
        // There is more, but the page reads one page per post.
        paging: { next: `${GRAPH}/${list[1]}/comments?after=x` },
      });
    }
    if (commentById[path]) {
      expect(url.searchParams.get("fields")).toBe(
        "id,text,timestamp,from{id,username},media{id}"
      );
      return Response.json(commentById[path]);
    }
    return graphError(100, 33);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function getRequest(query = "") {
  return GET(new NextRequest(`https://app.example.test/api/instagram/comments${query}`));
}

function postRequest(body: unknown) {
  return POST(
    new NextRequest("https://app.example.test/api/instagram/comments/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function logRow(overrides: Record<string, unknown>) {
  return {
    commentId: "c1",
    automationId: "c_post",
    status: "PENDING",
    attempts: 0,
    dmDeliveryUnconfirmed: false,
    errorMessage: null,
    matchedKeyword: "GUIDE",
    updatedAt: new Date(NOW - MINUTE),
    automation: { name: "Guide (Reel 1)" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  redis.current = new FakeRedis();
  graphCalls = [];
  graphErrors = {};
  media = [
    { id: "media_1", permalink: "https://www.instagram.com/reel/one/" },
    { id: "media_2", permalink: "https://www.instagram.com/p/two/" },
  ];
  comments = {
    media_1: [
      comment("c1", "GUIDE bitte", 10 * MINUTE),
      // The account's own comment and an answer to it: never rows.
      comment("own", "Danke euch!", 20 * MINUTE, { id: "ig_owner", username: "thomas.tergan" }),
      comment("c2", "kallt", 3 * HOUR, undefined, [{ id: "r1", from: { id: "ig_owner" } }]),
      comment("old", "GUIDE", 8 * DAY),
    ],
    media_2: [
      comment("c3", "Ist der GUIDE kostenlos?", 5 * MINUTE),
      comment("c4", "GUIDE", 2 * DAY),
    ],
  };
  commentById = {};
  installGraph();
  mockContext.mockReset().mockResolvedValue(context());
  mockQueueAdd.mockReset().mockResolvedValue({});
  mockPrisma.instagramAccount.findFirst.mockReset().mockResolvedValue(ACCOUNT);
  mockPrisma.automation.findMany.mockReset().mockResolvedValue(CAMPAIGNS);
  mockPrisma.automation.findFirst.mockReset();
  mockPrisma.dmLog.findMany.mockReset().mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function json(response: Response) {
  return (await response.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("GET /api/instagram/comments", () => {
  it("needs a session, and an owner or admin", async () => {
    mockContext.mockResolvedValueOnce(null);
    expect((await getRequest()).status).toBe(401);

    mockContext.mockResolvedValueOnce(context("MEMBER"));
    const member = await getRequest();
    expect(member.status).toBe(403);
    expect((await json(member)).reason).toBe("forbidden");

    mockContext.mockResolvedValueOnce(context("ADMIN"));
    expect((await getRequest()).status).toBe(200);
    // The member's request read nothing.
    expect(graphCalls.filter((url) => url.pathname.endsWith("/media"))).toHaveLength(1);
  });

  it("finds the account only in the reader's workspace", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValueOnce(null);
    const response = await getRequest("?instagramAccountId=account_of_another_workspace");
    expect(response.status).toBe(404);
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "account_of_another_workspace", workspaceId: WORKSPACE },
    });
    expect(graphCalls).toHaveLength(0);
  });

  it("refuses an account connected through Zernio", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValueOnce({
      ...ACCOUNT,
      provider: "ZERNIO",
      zernioAccountId: "z1",
    });
    const response = await getRequest();
    expect(response.status).toBe(400);
    expect((await json(response)).reason).toBe("provider");
  });

  it("lists the comments of the newest posts, newest first, with their state", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      logRow({ commentId: "c4", automationId: "c_any", status: "SENT", automation: { name: "Guide (alle Beiträge)" } }),
      logRow({ commentId: "c2", automationId: "c_paused", status: "FAILED", attempts: 1, errorMessage: "MetaApiError 100: invalid" }),
    ]);

    const response = await getRequest();
    expect(response.status).toBe(200);
    const { data } = await json(response);

    // Newest first across both posts; the account's own comment and the one
    // older than 7 days are not listed.
    expect(data.comments.map((row: { id: string }) => row.id)).toEqual(["c3", "c1", "c2", "c4"]);
    expect(data.account).toEqual({ id: "account_1", username: "thomas.tergan" });
    expect(data.pausedUntil).toBeNull();
    expect(data.hasMore).toBe(false);
    expect(data.generatedAt).toBe(new Date(NOW).toISOString());

    const byId = Object.fromEntries(
      data.comments.map((row: { id: string }) => [row.id, row])
    );
    // Post-specific beats any-post, as in the worker.
    expect(byId.c1).toMatchObject({
      text: "GUIDE bitte",
      username: "user_c1",
      mediaId: "media_1",
      permalink: "https://www.instagram.com/reel/one/",
      ownerReplied: false,
      question: false,
      match: { id: "c_post", name: "Guide (Reel 1)" },
      delivery: null,
    });
    // A question: the any-post campaign leaves it to a human.
    expect(byId.c3).toMatchObject({ question: true, match: null });
    // The account answered in public; the keyword is missing.
    expect(byId.c2).toMatchObject({
      ownerReplied: true,
      match: null,
      delivery: null,
      logs: [
        expect.objectContaining({
          automationId: "c_paused",
          status: "FAILED",
          exhausted: false,
          errorMessage: "MetaApiError 100: invalid",
        }),
      ],
    });
    expect(byId.c4.delivery).toEqual({
      state: "sent",
      campaignId: "c_any",
      campaignName: "Guide (alle Beiträge)",
      manual: false,
    });

    // Only campaigns with a DM text, paused ones marked.
    expect(data.campaigns).toEqual([
      { id: "c_any", name: "Guide (alle Beiträge)", isActive: true, hasPublicReply: true },
      { id: "c_post", name: "Guide (Reel 1)", isActive: true, hasPublicReply: false },
      { id: "c_paused", name: "Alt", isActive: false, hasPublicReply: true },
    ]);
    // The DM log is read for the listed comments only, in this workspace.
    expect(mockPrisma.dmLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: WORKSPACE,
          instagramAccountId: "account_1",
          commentId: { in: ["c3", "c1", "c2", "c4"] },
        },
      })
    );
  });

  it("costs one media read and one comment read per post, and nothing more within a minute", async () => {
    await getRequest();
    expect(graphCalls.map((url) => url.pathname)).toEqual([
      "/v25.0/ig_owner/media",
      "/v25.0/media_1/comments",
      "/v25.0/media_2/comments",
    ]);
    expect(graphCalls[0].searchParams.get("limit")).toBe("15");

    vi.setSystemTime(NOW + 59_000);
    await getRequest();
    expect(graphCalls).toHaveLength(3);

    vi.setSystemTime(NOW + 61_000);
    await getRequest();
    expect(graphCalls).toHaveLength(6);
  });

  it("reads no comments of a post Meta lists without any", async () => {
    media = [
      { id: "media_1", permalink: "https://www.instagram.com/reel/one/", comments_count: 4 },
      // Posted a minute ago, no comment yet.
      { id: "media_2", permalink: "https://www.instagram.com/p/two/", comments_count: 0 },
      // An older answer without the count: read as before.
      { id: "media_3", permalink: "https://www.instagram.com/p/three/" },
    ];
    const { data } = await json(await getRequest());
    expect(graphCalls.map((url) => url.pathname)).toEqual([
      "/v25.0/ig_owner/media",
      "/v25.0/media_1/comments",
      "/v25.0/media_3/comments",
    ]);
    expect(data.comments.map((row: { mediaId: string }) => row.mediaId)).not.toContain("media_2");
  });

  it("opens with the newest account connected through Meta, not a newer one through Zernio", async () => {
    await getRequest();
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, provider: "META" },
      orderBy: { connectedAt: "desc" },
    });
    // Without any account through Meta: the newest one, which the page then
    // explains it cannot read.
    mockPrisma.instagramAccount.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...ACCOUNT, provider: "ZERNIO", zernioAccountId: "z1" });
    const response = await getRequest();
    expect(response.status).toBe(400);
    expect((await json(response)).reason).toBe("provider");
  });

  it("reads a claim older than a send takes as a DM that may have gone out", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      logRow({
        commentId: "c1",
        status: "PENDING",
        dmDeliveryUnconfirmed: true,
        // A worker died with its claim 20 minutes ago.
        updatedAt: new Date(NOW - 20 * MINUTE),
      }),
      logRow({
        commentId: "c2",
        status: "PENDING",
        dmDeliveryUnconfirmed: true,
        updatedAt: new Date(NOW - MINUTE),
      }),
    ]);
    const { data } = await json(await getRequest("?ids=c1,c2"));
    expect(data.statuses.c1.delivery.state).toBe("unconfirmed");
    expect(data.statuses.c2.delivery.state).toBe("sending");
  });

  it("reads only the posts it has not read yet when more are loaded", async () => {
    media = Array.from({ length: 20 }, (_, index) => ({
      id: `media_${index + 1}`,
      permalink: `https://www.instagram.com/p/${index + 1}/`,
    }));
    const first = await json(await getRequest("?posts=15"));
    expect(first.data.hasMore).toBe(true);
    expect(graphCalls).toHaveLength(16);

    const more = await json(await getRequest("?posts=30"));
    expect(more.data.posts).toBe(30);
    expect(more.data.hasMore).toBe(false);
    // One media read for 30 posts, then the five posts not cached yet.
    expect(graphCalls).toHaveLength(16 + 1 + 5);
    expect(graphCalls[16].searchParams.get("limit")).toBe("30");
    expect(graphCalls.slice(17).map((url) => url.pathname)).toEqual(
      [16, 17, 18, 19, 20].map((n) => `/v25.0/media_${n}/comments`)
    );
  });

  it("reads nothing while the account is paused for a Meta limit", async () => {
    const pausedUntil = NOW + 20 * MINUTE;
    await (redis.current as FakeRedis).set("meta:pause:ig_owner", String(pausedUntil), "PX", 20 * MINUTE);

    const { data } = await json(await getRequest());
    expect(data.pausedUntil).toBe(new Date(pausedUntil).toISOString());
    expect(data.comments).toEqual([]);
    expect(graphCalls).toHaveLength(0);
  });

  // A1: every read would be refused until the account is reconnected.
  it("reads nothing while the account's connection is lost, and says since when", async () => {
    const lostAt = new Date(NOW - 2 * HOUR);
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ ...ACCOUNT, connectionLostAt: lostAt });

    const response = await getRequest();
    expect(response.status).toBe(200);
    const { data } = await json(response);
    expect(data.connectionLostAt).toBe(lostAt.toISOString());
    expect(data.comments).toEqual([]);
    expect(data.hasMore).toBe(false);
    expect(graphCalls).toHaveLength(0);
    // The campaigns stay listed.
    expect(data.campaigns.map((campaign: { id: string }) => campaign.id)).toEqual([
      "c_any",
      "c_post",
      "c_paused",
    ]);
  });

  it("says nothing about a lost connection while it works", async () => {
    const { data } = await json(await getRequest());
    expect(data.connectionLostAt).toBeNull();
  });

  it("stops reading at a Meta limit and says some posts are missing", async () => {
    media = Array.from({ length: 12 }, (_, index) => ({
      id: `media_${index + 1}`,
      permalink: `https://www.instagram.com/p/${index + 1}/`,
    }));
    graphErrors["media_2/comments"] = { code: 4 };

    const { data } = await json(await getRequest());
    expect(data.readLimited).toBe(true);
    // The media read and the first five comment reads; the rest wait.
    expect(graphCalls).toHaveLength(1 + 5);
    // A read sets no pause: only a refused message does.
    expect(await (redis.current as FakeRedis).get("meta:pause:ig_owner")).toBeNull();
  });

  it("answers a status poll from the database only", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      logRow({ commentId: "c1", status: "PENDING", dmDeliveryUnconfirmed: true, matchedKeyword: "(manuell)" }),
    ]);
    const response = await getRequest("?ids=c1,c2,bad:id");
    const { data } = await json(response);
    expect(graphCalls).toHaveLength(0);
    expect(Object.keys(data.statuses)).toEqual(["c1", "c2"]);
    expect(data.statuses.c1.delivery).toEqual({
      state: "sending",
      campaignId: "c_post",
      campaignName: "Guide (Reel 1)",
      manual: true,
    });
    expect(data.statuses.c2).toEqual({ delivery: null, logs: [] });
  });
});

describe("POST /api/instagram/comments/send", () => {
  const CAMPAIGN = {
    id: "c_post",
    dmMessage: "Hier ist dein Guide",
    instagramAccount: ACCOUNT,
  };

  function verifiableComment(overrides: Record<string, unknown> = {}) {
    commentById.c1 = {
      id: "c1",
      text: "kallt bitte",
      timestamp: iso(NOW - 2 * HOUR),
      from: { id: "person_c1", username: "anna" },
      media: { id: "media_1" },
      ...overrides,
    };
  }

  beforeEach(() => {
    mockPrisma.automation.findFirst.mockResolvedValue(CAMPAIGN);
    verifiableComment();
  });

  const send = (body: Record<string, unknown> = {}) =>
    postRequest({ commentId: "c1", automationId: "c_post", publicReply: false, ...body });

  it("needs a session, and an owner or admin", async () => {
    mockContext.mockResolvedValueOnce(null);
    expect((await send()).status).toBe(401);
    mockContext.mockResolvedValueOnce(context("MEMBER"));
    expect((await send()).status).toBe(403);
    expect(mockPrisma.automation.findFirst).not.toHaveBeenCalled();
    expect(graphCalls).toHaveLength(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("accepts exactly the three fields, with ids a job id can hold", async () => {
    for (const body of [
      { commentId: "c1", automationId: "c_post" },
      { commentId: "c1", automationId: "c_post", publicReply: "yes" },
      { commentId: "c1", automationId: "c_post", publicReply: true, extra: 1 },
      { commentId: "c:1", automationId: "c_post", publicReply: true },
      { commentId: "c1", automationId: "../x", publicReply: true },
    ]) {
      const response = await postRequest(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("finds the campaign only in the reader's workspace", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce(null);
    const response = await send({ automationId: "campaign_of_another_workspace" });
    expect(response.status).toBe(404);
    expect((await json(response)).reason).toBe("campaign_not_found");
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "campaign_of_another_workspace", workspaceId: WORKSPACE },
      })
    );
    expect(graphCalls).toHaveLength(0);
  });

  it("needs a campaign with a DM text, on an account connected through Meta", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce({ ...CAMPAIGN, dmMessage: " " });
    expect((await json(await send())).reason).toBe("not_comment_campaign");

    mockPrisma.automation.findFirst.mockResolvedValueOnce({
      ...CAMPAIGN,
      instagramAccount: { ...ACCOUNT, provider: "ZERNIO", zernioAccountId: "z1" },
    });
    expect((await json(await send())).reason).toBe("provider");
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("queues the worker's comment job for exactly this campaign", async () => {
    const response = await send({ publicReply: true });
    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      success: true,
      queued: true,
      previousUpdatedAt: null,
      queuedAt: new Date(NOW).toISOString(),
      // The first send of the account goes out right away.
      scheduledAt: new Date(NOW).toISOString(),
    });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, options] = mockQueueAdd.mock.calls[0];
    expect(name).toBe("process-comment");
    // What Instagram says about the comment, not what the page sent.
    expect(data).toEqual({
      instagramAccountId: "ig_owner",
      accountConnectionId: "account_1",
      commentId: "c1",
      commentText: "kallt bitte",
      commenterId: "person_c1",
      commenterName: "anna",
      mediaId: "media_1",
      source: "MANUAL",
      forceAutomationId: "c_post",
      publicReplyOverride: true,
    });
    expect(options).toEqual({
      jobId: "manual_ig_owner_c1_c_post_0",
      delay: 0,
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect(options.jobId).not.toContain(":");
    // The comment, and the posts to find its post among.
    expect(graphCalls.map((url) => url.pathname)).toEqual([
      "/v25.0/c1",
      "/v25.0/ig_owner/media",
    ]);
  });

  it("reuses the page's cached posts to check the comment's post", async () => {
    await getRequest();
    graphCalls = [];
    expect((await send()).status).toBe(202);
    expect(graphCalls.map((url) => url.pathname)).toEqual(["/v25.0/c1"]);
  });

  it("gives a double click one job, and a try after a refused DM a new one", async () => {
    await send();
    await send();
    expect(mockQueueAdd.mock.calls.map(([, , options]) => options.jobId)).toEqual([
      "manual_ig_owner_c1_c_post_0",
      "manual_ig_owner_c1_c_post_0",
    ]);

    // Instagram refused the first DM: the campaign's row counts one attempt.
    const failedAt = new Date(NOW - 30_000);
    mockPrisma.dmLog.findMany.mockResolvedValue([
      logRow({ status: "FAILED", attempts: 1, updatedAt: failedAt, errorMessage: "MetaApiError 10: refused" }),
    ]);
    const retry = await send();
    expect(retry.status).toBe(202);
    expect((await json(retry)).previousUpdatedAt).toBe(failedAt.toISOString());
    expect(mockQueueAdd.mock.calls[2][2].jobId).toBe("manual_ig_owner_c1_c_post_1");
  });

  it("refuses a comment whose DM went out, may have, or is on its way", async () => {
    for (const row of [
      logRow({ automationId: "c_any", status: "SENT", automation: { name: "Guide (alle Beiträge)" } }),
      logRow({ automationId: "c_any", status: "FAILED", dmDeliveryUnconfirmed: true }),
      logRow({ automationId: "c_post", status: "PENDING", dmDeliveryUnconfirmed: true }),
      logRow({ automationId: "c_any", status: "FAILED", errorMessage: "Meta error [code=1 sub=- type=OAuthException]" }),
    ]) {
      mockPrisma.dmLog.findMany.mockResolvedValueOnce([row]);
      const response = await send();
      expect(response.status).toBe(409);
      const payload = await json(response);
      expect(payload.reason).toBe("already_sent");
      expect(payload.status.delivery).not.toBeNull();
    }
    expect(mockPrisma.dmLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WORKSPACE, instagramAccountId: "account_1", commentId: "c1" },
      })
    );
    // Nothing asked of Instagram, nothing queued.
    expect(graphCalls).toHaveLength(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("refuses a campaign that used up its attempts for the comment", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValueOnce([
      logRow({ status: "FAILED", attempts: 3 }),
    ]);
    const response = await send();
    expect(response.status).toBe(409);
    expect((await json(response)).reason).toBe("attempts_used");
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("checks the comment with Instagram: its post, its age, its author", async () => {
    verifiableComment({ media: { id: "media_of_someone_else" } });
    let response = await send();
    expect(response.status).toBe(404);
    expect((await json(response)).reason).toBe("foreign_media");

    verifiableComment({ timestamp: iso(NOW - 7 * DAY - MINUTE) });
    response = await send();
    expect(response.status).toBe(409);
    expect((await json(response)).reason).toBe("too_old");

    verifiableComment({ from: { id: "ig_owner", username: "thomas.tergan" } });
    response = await send();
    expect(response.status).toBe(409);
    expect((await json(response)).reason).toBe("own_comment");

    // Instagram no longer has it, or it is not this account's to read.
    delete commentById.c1;
    response = await send();
    expect(response.status).toBe(404);
    expect((await json(response)).reason).toBe("comment_not_found");

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("asks Instagram nothing while the account is paused", async () => {
    const pausedUntil = NOW + 15 * MINUTE;
    await (redis.current as FakeRedis).set("meta:pause:ig_owner", String(pausedUntil), "PX", 15 * MINUTE);
    const response = await send();
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      reason: "paused",
      pausedUntil: new Date(pausedUntil).toISOString(),
    });
    expect(graphCalls).toHaveLength(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("asks Instagram nothing and queues nothing while the account's connection is lost", async () => {
    const lostAt = new Date(NOW - 2 * HOUR);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...CAMPAIGN,
      instagramAccount: { ...ACCOUNT, connectionLostAt: lostAt },
    });
    const response = await send();
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      success: false,
      reason: "connection_lost",
      connectionLostAt: lostAt.toISOString(),
    });
    expect(graphCalls).toHaveLength(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    // The campaign's account is read with its incident.
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          instagramAccount: {
            select: expect.objectContaining({ connectionLostAt: true }),
          },
        }),
      })
    );
  });

  it("reports a Meta limit on the check without pausing the account", async () => {
    graphErrors.c1 = { code: 4 };
    const response = await send();
    expect(response.status).toBe(503);
    expect((await json(response)).reason).toBe("instagram_limit");
    expect(await (redis.current as FakeRedis).get("meta:pause:ig_owner")).toBeNull();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("waits for a worker that knows manual sends", async () => {
    const heartbeat = (features?: string[]) =>
      (redis.current as FakeRedis).set(
        "health:worker:dm",
        JSON.stringify({
          status: "running",
          worker: "dm",
          pid: 1,
          checkedAt: new Date(NOW - 10_000).toISOString(),
          ...(features ? { features } : {}),
        }),
        "EX",
        120
      );

    // A worker from before: it would read the job as an ordinary comment.
    await heartbeat();
    const response = await send();
    expect(response.status).toBe(409);
    expect((await json(response)).reason).toBe("worker_outdated");
    expect(mockQueueAdd).not.toHaveBeenCalled();

    await heartbeat(["manual-send"]);
    expect((await send()).status).toBe(202);
  });

  it(`lets one person queue ${MANUAL_SEND_RATE_LIMIT} sends a minute`, async () => {
    // The person's sends of this minute so far (on other accounts too).
    await (redis.current as FakeRedis).set(
      "manual-send:rate:user_1",
      String(MANUAL_SEND_RATE_LIMIT - 1),
      "PX",
      60_000
    );
    expect((await send()).status).toBe(202);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect((await json(limited)).reason).toBe("rate_limited");
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    // Someone else is not limited by it, and the minute passes.
    mockContext.mockResolvedValueOnce(context("ADMIN", "user_2"));
    expect((await send()).status).toBe(202);
    vi.setSystemTime(NOW + 61_000);
    expect((await send()).status).toBe(202);
  });

  it(`sends an account's manual DMs ${MANUAL_SEND_SPACING_MS / 1000} seconds apart, and says when`, async () => {
    const scheduled: string[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await send();
      expect(response.status).toBe(202);
      scheduled.push((await json(response)).scheduledAt);
    }
    // One right away, then one every 20 seconds, whoever clicks.
    expect(mockQueueAdd.mock.calls.map(([, , options]) => options.delay)).toEqual([
      0,
      MANUAL_SEND_SPACING_MS,
      2 * MANUAL_SEND_SPACING_MS,
    ]);
    expect(scheduled).toEqual([
      new Date(NOW).toISOString(),
      new Date(NOW + MANUAL_SEND_SPACING_MS).toISOString(),
      new Date(NOW + 2 * MANUAL_SEND_SPACING_MS).toISOString(),
    ]);

    // Once the slots have passed, the next goes out right away again.
    vi.setSystemTime(NOW + 10 * MANUAL_SEND_SPACING_MS);
    await send();
    expect(mockQueueAdd.mock.calls.at(-1)?.[2].delay).toBe(0);
  });

  it(`queues at most ${MANUAL_SEND_ACCOUNT_LIMIT} manual DMs an hour for one account, whoever clicks`, async () => {
    for (let i = 0; i < MANUAL_SEND_ACCOUNT_LIMIT; i++) {
      mockContext.mockResolvedValueOnce(context("OWNER", `user_${i % 3}`));
      expect((await send()).status).toBe(202);
    }
    mockContext.mockResolvedValueOnce(context("ADMIN", "user_9"));
    const limited = await send();
    expect(limited.status).toBe(429);
    expect((await json(limited)).reason).toBe("account_limit");
    expect(mockQueueAdd).toHaveBeenCalledTimes(MANUAL_SEND_ACCOUNT_LIMIT);

    // The hour passes.
    vi.setSystemTime(NOW + 61 * MINUTE);
    expect((await send()).status).toBe(202);
  });

  it("refuses a send that would go out after the 7 days, behind others", async () => {
    // Three sends wait: the fourth would go out a minute after it is due.
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(202);
    verifiableComment({ timestamp: iso(NOW - 7 * DAY + 30_000) });
    const late = await send();
    expect(late.status).toBe(409);
    expect((await json(late)).reason).toBe("too_old");
    expect(mockQueueAdd).toHaveBeenCalledTimes(3);
  });
});
