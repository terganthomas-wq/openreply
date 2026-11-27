/**
 * The Inbox's API under its read budget (Meta submission plan, part B,
 * S1b): GET /api/instagram/conversations and GET .../[id] share 40 requests
 * to Meta an hour per account and answer 429 inbox_budget beyond them and
 * while the worker has paused the account for a Meta limit, a timer read
 * (`?silent=1`) makes exactly one request, every further request of a full
 * read takes one more, and sending by hand (POST) is never capped.
 *
 * The database and the session are mocks, Redis the in-memory stand-in, and
 * Meta is fetch answered here: every Graph call is counted, none leaves the
 * test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockWorkspaceId, state } = vi.hoisted(() => ({
  mockPrisma: { instagramAccount: { findFirst: vi.fn() } },
  mockWorkspaceId: vi.fn(),
  state: { redis: null as unknown },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: mockWorkspaceId }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => state.redis }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "local-test-token" }));

import { GET as listConversations, POST as sendReply } from "../app/api/instagram/conversations/route";
import { GET as readThread } from "../app/api/instagram/conversations/[id]/route";
import { inboxReadKey } from "../lib/inbox/read-budget";
import { accountPauseKey } from "../lib/queue/account-pause";
import { FakeRedis } from "./helpers/fake-redis";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");
const ACCOUNT = {
  id: "account_1",
  workspaceId: "workspace_1",
  instagramId: "ig_owner",
  username: "studio",
  provider: "META",
  metaLogin: "UNIFIED",
  zernioAccountId: null,
  accessToken: "encrypted",
};

let redis: FakeRedis;
let graphCalls: { method: string; path: string; params: URLSearchParams }[];
// The list as Meta pages it: TOTAL conversations, PAGE_CAP per page.
const TOTAL = 13;
const PAGE_CAP = 5;
// Conversations whose expanded fields make Meta refuse the whole page with
// code 1 (upstream #60), by their index in the list.
let broken: number[];
// A Meta error code every read gets instead of an answer (a request limit, a
// dead token), or null.
let refusal: number | null;

function graph() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe("graph.facebook.com");
    const method = init?.method ?? "GET";
    graphCalls.push({ method, path: url.pathname, params: url.searchParams });
    if (method === "POST" && url.pathname.endsWith("/ig_owner/messages")) {
      return Response.json({ recipient_id: "ig_person", message_id: "mid_sent" });
    }
    if (refusal !== null) {
      return Response.json(
        { error: { code: refusal, type: "OAuthException", message: "Refused here", fbtrace_id: "trace" } },
        { status: 400 }
      );
    }
    if (url.pathname.endsWith("/ig_owner/conversations")) {
      const start = Number(url.searchParams.get("after")?.replace("cursor-", "") ?? 0);
      const end = Math.min(TOTAL, start + Math.min(PAGE_CAP, Number(url.searchParams.get("limit"))));
      const expanded = url.searchParams.get("fields") !== "id,updated_time";
      if (expanded && broken.some((index) => index >= start && index < end)) {
        return Response.json(
          { error: { code: 1, type: "OAuthException", message: "An unknown error has occurred.", fbtrace_id: "trace" } },
          { status: 400 }
        );
      }
      const data = Array.from({ length: end - start }, (_, offset) => ({
        id: `conversation-${start + offset}`,
        updated_time: "2026-11-27T09:00:00+0000",
        participants: { data: [{ id: "ig_owner" }, { id: `ig_person_${start + offset}`, username: "follower" }] },
        messages: { data: [{ id: `m-${start + offset}`, message: "Hallo", from: { id: "ig_owner" } }] },
      }));
      return Response.json({
        data,
        ...(end < TOTAL
          ? { paging: { next: "https://untrusted.example/next", cursors: { after: `cursor-${end}` } } }
          : {}),
      });
    }
    if (url.pathname.endsWith("/conversation-0")) {
      return Response.json({
        messages: { data: [{ id: "m-1", message: "Hallo", from: { id: "ig_person_0" }, created_time: "2026-11-27T09:00:00+0000" }] },
      });
    }
    throw new Error(`unexpected Graph call ${method} ${url.pathname}`);
  });
}

const list = (query = "") =>
  listConversations(
    new NextRequest(`https://dm.example.test/api/instagram/conversations?instagramAccountId=account_1${query}`)
  );
const thread = () =>
  readThread(
    new NextRequest("https://dm.example.test/api/instagram/conversations/conversation-0?instagramAccountId=account_1"),
    { params: Promise.resolve({ id: "conversation-0" }) }
  );
const send = () =>
  sendReply(
    new NextRequest("https://dm.example.test/api/instagram/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramAccountId: "account_1", recipientId: "ig_person_0", text: "Gern!" }),
    })
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  redis = new FakeRedis();
  state.redis = redis;
  graphCalls = [];
  broken = [];
  refusal = null;
  vi.stubGlobal("fetch", graph());
  mockWorkspaceId.mockResolvedValue("workspace_1");
  mockPrisma.instagramAccount.findFirst.mockResolvedValue(ACCOUNT);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("GET /api/instagram/conversations", () => {
  it("reads the whole list on an ordinary read", async () => {
    const response = await list();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.conversations).toHaveLength(TOTAL);
    expect(graphCalls).toHaveLength(3);
    // Complete: nothing for the page to pause for.
    expect(body.partial).toBeUndefined();
    expect(response.headers.get("Retry-After")).toBeNull();
  });

  it("reads one page for a timer read (silent=1)", async () => {
    const response = await list("&silent=1");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.conversations.map((c: { id: string }) => c.id)).toEqual(
      Array.from({ length: PAGE_CAP }, (_, i) => `conversation-${i}`)
    );
    expect(graphCalls).toHaveLength(1);
  });

  it("answers 429 inbox_budget after 40 reads an hour, without asking Meta", async () => {
    for (let i = 0; i < 40; i++) expect((await list("&silent=1")).status).toBe(200);
    expect(graphCalls).toHaveLength(40);

    vi.setSystemTime(NOW + 20 * 60_000);
    const refused = await list("&silent=1");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe(String(40 * 60));
    expect(await refused.json()).toMatchObject({
      success: false,
      code: "inbox_budget",
      retryAt: new Date(NOW + 60 * 60_000).toISOString(),
    });
    expect(graphCalls).toHaveLength(40);
  });

  it("answers 401 and 400 before the budget is touched", async () => {
    mockWorkspaceId.mockResolvedValueOnce(null);
    expect((await list()).status).toBe(401);
    mockPrisma.instagramAccount.findFirst.mockResolvedValueOnce(null);
    expect((await list()).status).toBe(400);
    expect(redis.commands).toEqual([]);
    expect(graphCalls).toEqual([]);
  });

  it("counts every request to Meta: a list of three pages takes three reads", async () => {
    expect((await list()).status).toBe(200);
    expect(graphCalls).toHaveLength(3);
    expect(redis.strings.get(inboxReadKey("account_1"))?.value).toBe("3");
  });

  it("stops a full read where the budget ends and answers with what it read", async () => {
    for (let i = 0; i < 38; i++) await list("&silent=1");
    graphCalls = [];

    const response = await list();
    expect(response.status).toBe(200);
    const body = await response.json();
    // Two of the three pages fit into the hour's 40.
    expect(body.data.conversations).toHaveLength(2 * PAGE_CAP);
    expect(graphCalls).toHaveLength(2);
    // Marked as cut short, with the window's end, so the page keeps what it
    // shows and pauses until then.
    expect(body.partial).toEqual({ retryAt: new Date(NOW + 60 * 60_000).toISOString() });
    expect(response.headers.get("Retry-After")).toBe(String(60 * 60));

    expect((await list("&silent=1")).status).toBe(429);
    expect(graphCalls).toHaveLength(2);
  });

  describe("with a conversation Meta cannot expand (upstream #60)", () => {
    beforeEach(() => {
      // The newest one: every page that holds it is refused with code 1.
      broken = [0];
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("makes exactly one request for a timer read, which then fails", async () => {
      const response = await list("&silent=1");
      expect(response.status).toBe(500);
      expect(graphCalls).toHaveLength(1);
      expect(redis.strings.get(inboxReadKey("account_1"))?.value).toBe("1");
    });

    it("narrows it down on a full read, taking one read per request", async () => {
      const response = await list();
      expect(response.status).toBe(200);
      const { conversations } = (await response.json()).data;
      expect(conversations).toHaveLength(TOTAL);
      expect(conversations[0]).toMatchObject({ id: "conversation-0", detailsUnavailable: true });
      expect(graphCalls.length).toBeGreaterThan(3);
      expect(redis.strings.get(inboxReadKey("account_1"))?.value).toBe(String(graphCalls.length));
    });

    it("never asks Meta more than 40 times an hour, whatever the mix of reads", async () => {
      let refused = false;
      for (let i = 0; i < 100 && !refused; i++) {
        refused = (await list(i % 3 === 0 ? "" : "&silent=1")).status === 429;
      }
      expect(refused).toBe(true);
      expect(graphCalls).toHaveLength(40);

      expect((await list()).status).toBe(429);
      expect((await list("&silent=1")).status).toBe(429);
      expect((await thread()).status).toBe(429);
      expect(graphCalls).toHaveLength(40);
    });

    it("answers 429 when the budget ends before a single conversation was read", async () => {
      for (let i = 0; i < 39; i++) await list("&silent=1");
      graphCalls = [];

      const response = await list();
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({
        code: "inbox_budget",
        retryAt: new Date(NOW + 60 * 60_000).toISOString(),
      });
      // The 40th read is the first page, which Meta refuses; narrowing it
      // down would take a 41st.
      expect(graphCalls).toHaveLength(1);
    });
  });
});

describe("while the worker has paused the account for a Meta request limit", () => {
  const RESUME = NOW + 20 * 60_000;

  beforeEach(async () => {
    await redis.set(accountPauseKey("ig_owner"), String(RESUME), "PX", String(20 * 60_000));
  });

  it("reads neither the list nor a thread, and says until when", async () => {
    for (const response of [await list(), await list("&silent=1"), await thread()]) {
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe(String(20 * 60));
      expect(await response.json()).toMatchObject({
        success: false,
        code: "inbox_budget",
        retryAt: new Date(RESUME).toISOString(),
      });
    }
    expect(graphCalls).toEqual([]);
    // The hour's budget is left alone.
    expect(redis.strings.has(inboxReadKey("account_1"))).toBe(false);
  });

  it("still sends by hand", async () => {
    expect((await send()).status).toBe(200);
    expect(graphCalls.map((call) => call.method)).toEqual(["POST"]);
  });

  it("reads again once the pause is over", async () => {
    vi.setSystemTime(RESUME + 1);
    expect((await list("&silent=1")).status).toBe(200);
    expect(graphCalls).toHaveLength(1);
  });
});

describe("while the account's connection is lost (A1)", () => {
  const LOST_AT = new Date(NOW - 60 * 60_000);

  beforeEach(() => {
    // The connection check found Meta refusing the account's token.
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ ...ACCOUNT, connectionLostAt: LOST_AT });
    refusal = 190;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads neither the list nor a thread: no Meta call and none of the hour's reads", async () => {
    for (const response of [await list(), await list("&silent=1"), await thread()]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        success: false,
        code: "connection_lost",
        connectionLostAt: LOST_AT.toISOString(),
        error: "The connection to Instagram is lost. Reconnect first.",
      });
    }
    expect(graphCalls).toEqual([]);
    expect(redis.commands).toEqual([]);
  });

  it("reads again after a reconnect", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(ACCOUNT);
    refusal = null;
    expect((await list("&silent=1")).status).toBe(200);
    expect(graphCalls).toHaveLength(1);
  });
});

describe("when Meta refuses the Inbox's own read for a request limit", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pauses the reads for the worker's throttle pause instead of failing", async () => {
    refusal = 4;
    for (const response of [await list("&silent=1"), await list(), await thread()]) {
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe(String(20 * 60));
      expect(await response.json()).toMatchObject({
        success: false,
        code: "inbox_budget",
        retryAt: new Date(NOW + 20 * 60_000).toISOString(),
      });
    }
    // One request each; the worker's pause is the worker's to set.
    expect(graphCalls).toHaveLength(3);
    expect(redis.strings.has(accountPauseKey("ig_owner"))).toBe(false);
  });

  it("pauses an hour for a block (368)", async () => {
    refusal = 368;
    const response = await list();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(60 * 60));
  });

  it("still answers any other Meta error with a 500", async () => {
    refusal = 190;
    expect((await list("&silent=1")).status).toBe(500);
    expect((await thread()).status).toBe(500);
  });
});

describe("GET /api/instagram/conversations/[id]", () => {
  it("reads the thread with one Meta call", async () => {
    const response = await thread();
    expect(response.status).toBe(200);
    expect((await response.json()).data.messages).toHaveLength(1);
    expect(graphCalls.map((call) => call.path.split("/").at(-1))).toEqual(["conversation-0"]);
  });

  it("shares the account's budget with the list and is refused beyond it", async () => {
    for (let i = 0; i < 39; i++) await list("&silent=1");
    expect((await thread()).status).toBe(200);
    expect(redis.strings.get(inboxReadKey("account_1"))?.value).toBe("40");

    const refused = await thread();
    expect(refused.status).toBe(429);
    expect((await refused.json()).code).toBe("inbox_budget");
    expect((await list()).status).toBe(429);
    // 39 list pages and the one thread read; nothing after the budget.
    expect(graphCalls).toHaveLength(40);
  });
});

describe("POST /api/instagram/conversations", () => {
  it("sends by hand with the read budget used up, and does not count against it", async () => {
    for (let i = 0; i < 41; i++) await list("&silent=1");
    const counted = redis.strings.get(inboxReadKey("account_1"))?.value;

    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { recipient_id: "ig_person", message_id: "mid_sent" },
    });
    expect(graphCalls.at(-1)).toMatchObject({ method: "POST", path: expect.stringMatching(/\/ig_owner\/messages$/) });
    expect(redis.strings.get(inboxReadKey("account_1"))?.value).toBe(counted);
  });
});
