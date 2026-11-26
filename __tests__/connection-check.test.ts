/**
 * The connection check (A1): what counts as a lost connection, the two
 * strikes, the R1 pause, which accounts are read and how, and the end of an
 * incident with its start kept for the catch-up.
 *
 * Meta and Resend are fetch answered here, never called; Redis (the account
 * pause) is an in-memory stand-in, and so are the account rows, whose
 * conditional updates are evaluated (helpers/fake-connection-db.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeConnectionDb, fakeAccount } from "./helpers/fake-connection-db";
import { FakeRedis } from "./helpers/fake-redis";

const state = vi.hoisted(() => ({
  db: null as unknown as import("./helpers/fake-connection-db").FakeConnectionDb,
  redis: null as unknown,
}));
const queueAdd = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db.prisma;
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => state.redis,
  getDMQueue: () => ({ add: queueAdd }),
  CATCH_UP_JOB_NAME: "process-catch-up",
}));
vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (value: string) => {
    if (value === "undecryptable") throw new Error("Unsupported state or unable to authenticate data");
    return "local-test-token";
  },
}));

import {
  MetaApiError,
  PermissionError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";
import {
  checkInstagramConnections,
  classifyConnectionError,
  connectionStrikeGapMs,
  nextConnectionStep,
  type ConnectionCheckResult,
} from "../lib/instagram/connection-check";
import { resetConnectionAlertWarnings } from "../lib/ops/connection-alert";
import { resetMailWarnings } from "../lib/ops/mail";

const NOW = new Date("2026-11-25T17:00:00.000Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const INTERVAL = 30 * MINUTE;
const FACEBOOK = "https://graph.facebook.com/v25.0";
const INSTAGRAM = "https://graph.instagram.com/v25.0";

let fake: FakeRedis;
let metaCalls: URL[];
let metaAnswer: (url: URL) => Response | Promise<Response>;
let resendCalls: { body: Record<string, unknown>; headers: Record<string, string> }[];

function graphError(code: number, subcode?: number, status = 400) {
  return new Response(
    JSON.stringify({
      error: {
        code,
        error_subcode: subcode,
        type: "OAuthException",
        message: "Unsupported get request. Object with ID 'ig_1' does not exist, cannot be loaded due to missing permissions",
        fbtrace_id: "trace",
      },
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}
const ok = () => Response.json({ id: "ig_1", username: "thomas.tergan" });
const lost = () => graphError(100, 33);

async function check(at: number) {
  vi.setSystemTime(at);
  return checkInstagramConnections({ intervalMs: INTERVAL });
}

function events(kind?: string) {
  return state.db.events.filter((event) => !kind || event.payload?.kind === kind);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = new FakeRedis();
  state.redis = fake;
  state.db = new FakeConnectionDb();
  state.db.accounts.push(fakeAccount());
  state.db.users.push(
    { id: "u_owner", email: "owner@example.test" },
    { id: "u_admin", email: "admin@example.test" },
    { id: "u_member", email: "member@example.test" }
  );
  state.db.workspaces.push({ id: "workspace_1", ownerId: "u_owner" });
  state.db.members.push(
    { workspaceId: "workspace_1", userId: "u_owner", role: "OWNER", createdAt: new Date(NOW - 3 * HOUR) },
    { workspaceId: "workspace_1", userId: "u_admin", role: "ADMIN", createdAt: new Date(NOW - 2 * HOUR) },
    { workspaceId: "workspace_1", userId: "u_member", role: "MEMBER", createdAt: new Date(NOW - HOUR) }
  );
  metaCalls = [];
  resendCalls = [];
  metaAnswer = ok;
  queueAdd.mockReset().mockResolvedValue({ id: "job" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === "https://api.resend.com") {
        resendCalls.push({
          body: JSON.parse(String(init?.body)),
          headers: init?.headers as Record<string, string>,
        });
        return Response.json({ id: `email_${resendCalls.length}` });
      }
      metaCalls.push(url);
      return metaAnswer(url);
    })
  );
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
  vi.stubEnv("RESEND_API_KEY", "re_test_only");
  vi.stubEnv("EMAIL_FROM", "OpenReply <alerts@example.test>");
  vi.stubEnv("EMAIL_SERVER", "");
  vi.stubEnv("NEXTAUTH_URL", "https://dm.example.test");
  vi.stubEnv("DEFAULT_LOCALE", "de");
  resetMailWarnings();
  resetConnectionAlertWarnings();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("what an answer says about the connection", () => {
  it.each([
    ["a token error", new TokenExpiredError("Error validating access token", "t"), "token (Meta 190)"],
    ["a token error with a subcode", new TokenExpiredError("Password changed", "t", 460), "token (Meta 190/460)"],
    ["an API session error", new MetaApiError(102, undefined, "t", "Session key invalid"), "token (Meta 102)"],
    ["an expired token code", new MetaApiError(463, undefined, "t", "expired"), "token (Meta 463)"],
    ["an invalid token code", new MetaApiError(467, undefined, "t", "invalid"), "token (Meta 467)"],
    ["a missing permission", new PermissionError("(#10) no permission", "t", undefined, 10), "permission (Meta 10)"],
    ["a permissions error", new PermissionError("(#200) permissions", "t", undefined, 200), "permission (Meta 200)"],
    ["another 2xx permission code", new MetaApiError(230, undefined, "t", "permission"), "permission (Meta 230)"],
    ["the top of the permission range", new MetaApiError(299, undefined, "t", "permission"), "permission (Meta 299)"],
    ["the account no longer found", new PermissionError("Object does not exist", "t", 33, 100), "missing (Meta 100/33)"],
  ])("counts %s as lost", (_name, error, reason) => {
    expect(classifyConnectionError(error)).toEqual({
      outcome: "lost",
      kind: reason.split(" ")[0],
      reason,
    });
  });

  it.each([
    ["the application limit (4)", new RateLimitError("(#4) Application request limit reached", "t", undefined, 4)],
    ["the user limit (17)", new RateLimitError("limit", "t", undefined, 17)],
    ["the page limit (32)", new RateLimitError("limit", "t", undefined, 32)],
    ["an API's limit (613)", new RateLimitError("limit", "t", undefined, 613)],
    ["Instagram's business limit (80002)", new RateLimitError("limit", "t", undefined, 80002)],
    ["the messaging limit (80006)", new RateLimitError("limit", "t", undefined, 80006)],
    ["a temporary block (368)", new RateLimitError("blocked", "t", undefined, 368)],
    ["an unknown Meta error (1)", new MetaApiError(1, undefined, "t", "An unknown error occurred")],
    ["a temporary Meta error (2)", new MetaApiError(2, undefined, "t", "Service temporarily unavailable")],
    ["a 5xx without Meta's code", new MetaApiError(503, undefined, undefined, "Service Unavailable")],
    ["100 without subcode 33", new PermissionError("(#100) Tried accessing nonexisting field", "t", undefined, 100)],
    ["100 with another subcode", new PermissionError("invalid", "t", 2534025, 100)],
    ["a code just outside the permission range", new MetaApiError(300, undefined, "t", "other")],
    ["a network error", new TypeError("fetch failed")],
    ["a timeout", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
    ["an HTML error page", new SyntaxError("Unexpected token '<'")],
    ["something that is no error", "boom"],
  ])("does not count %s", (_name, error) => {
    expect(classifyConnectionError(error).outcome).toBe("inconclusive");
  });
});

describe("the two strikes", () => {
  const lostResult: ConnectionCheckResult = { outcome: "lost", kind: "missing", reason: "missing (Meta 100/33)" };
  const clean = { connectionCheckFailedAt: null, connectionLostAt: null };
  const gap = connectionStrikeGapMs(INTERVAL);

  it("waits one interval less a tenth of it, at most five minutes", () => {
    expect(connectionStrikeGapMs(30 * MINUTE)).toBe(27 * MINUTE);
    expect(connectionStrikeGapMs(5 * MINUTE)).toBe(4.5 * MINUTE);
    expect(connectionStrikeGapMs(2 * HOUR)).toBe(115 * MINUTE);
    // A broken COMMENT_POLL_INTERVAL_MS falls back to the 5-minute default.
    expect(connectionStrikeGapMs(Number.NaN)).toBe(4.5 * MINUTE);
    expect(connectionStrikeGapMs(0)).toBe(4.5 * MINUTE);
  });

  it("steps from nothing to a strike to an incident, and back", () => {
    const first = new Date(NOW);
    expect(nextConnectionStep(clean, lostResult, NOW, gap)).toEqual({ kind: "strike" });
    const struck = { ...clean, connectionCheckFailedAt: first };
    expect(nextConnectionStep(struck, lostResult, NOW + gap - 1, gap)).toEqual({ kind: "none" });
    expect(nextConnectionStep(struck, lostResult, NOW + gap, gap)).toEqual({ kind: "start", lostAt: first });
    expect(nextConnectionStep(struck, { outcome: "ok" }, NOW + gap, gap)).toEqual({ kind: "clear-strike" });
    expect(nextConnectionStep(struck, { outcome: "inconclusive", detail: "limit" }, NOW + gap, gap)).toEqual({ kind: "none" });
    const open = { connectionCheckFailedAt: first, connectionLostAt: first };
    expect(nextConnectionStep(open, lostResult, NOW + HOUR, gap)).toEqual({ kind: "still-lost" });
    expect(nextConnectionStep(open, { outcome: "ok" }, NOW + HOUR, gap)).toEqual({ kind: "recover", lostAt: first });
    expect(nextConnectionStep(open, { outcome: "inconclusive", detail: "net" }, NOW + HOUR, gap)).toEqual({ kind: "none" });
    expect(nextConnectionStep(clean, { outcome: "ok" }, NOW, gap)).toEqual({ kind: "none" });
  });

  it("remembers a first refusal and does nothing else", async () => {
    metaAnswer = lost;
    await check(NOW);

    expect(state.db.account()).toMatchObject({
      connectionCheckFailedAt: new Date(NOW),
      connectionLostAt: null,
      connectionLostReason: null,
    });
    expect(state.db.events).toHaveLength(0);
    expect(resendCalls).toHaveLength(0);
  });

  it("opens the incident with a second refusal one interval later, since the first", async () => {
    metaAnswer = lost;
    await check(NOW);
    await check(NOW + INTERVAL);

    expect(state.db.account()).toMatchObject({
      connectionCheckFailedAt: new Date(NOW),
      connectionLostAt: new Date(NOW),
      connectionLostReason: "missing (Meta 100/33)",
      connectionAlertCount: 1,
      connectionAlertSentAt: new Date(NOW + INTERVAL),
    });
    const [opened] = events("connection-lost");
    expect(opened).toMatchObject({
      workspaceId: "workspace_1",
      source: "WORKER",
      level: "WARNING",
      payload: {
        kind: "connection-lost",
        account: "thomas.tergan",
        lostAt: new Date(NOW).toISOString(),
        reason: "missing (Meta 100/33)",
      },
    });
    expect(opened.message).toContain("Instagram connection lost for @thomas.tergan");
    // The owner and the admin, one e-mail each.
    expect(resendCalls.map((call) => call.body.to)).toEqual([
      ["owner@example.test"],
      ["admin@example.test"],
    ]);
    expect(resendCalls[0].body.subject).toBe(
      "Instagram-Verbindung unterbrochen: OpenReply sendet gerade keine DMs"
    );
  });

  it("does not count a second refusal right after the first, as from the sweep after a restart", async () => {
    metaAnswer = lost;
    await check(NOW);
    await check(NOW + 10_000);
    await check(NOW + 27 * MINUTE - 1_000);
    expect(state.db.account().connectionLostAt).toBeNull();
    expect(state.db.account().connectionCheckFailedAt).toEqual(new Date(NOW));

    // A check that runs a little early still counts.
    await check(NOW + 27 * MINUTE);
    expect(state.db.account().connectionLostAt).toEqual(new Date(NOW));
  });

  it.each([
    ["the application limit", () => graphError(4)],
    ["a temporary block", () => graphError(368)],
    ["an unknown Meta error", () => graphError(1, undefined, 500)],
    ["a 502 page", () => new Response("<html>Bad gateway</html>", { status: 502 })],
    [
      "no answer",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("neither counts nor clears a strike on %s", async (_name, answer) => {
    metaAnswer = lost;
    await check(NOW);

    metaAnswer = answer;
    await check(NOW + INTERVAL);
    await check(NOW + 2 * INTERVAL);
    expect(state.db.account()).toMatchObject({
      connectionCheckFailedAt: new Date(NOW),
      connectionLostAt: null,
    });

    // The next refusal decides, and the incident runs from the first.
    metaAnswer = lost;
    await check(NOW + 3 * INTERVAL);
    expect(state.db.account().connectionLostAt).toEqual(new Date(NOW));
  });

  it("forgets a single refusal when the next check gets through", async () => {
    metaAnswer = lost;
    await check(NOW);
    metaAnswer = ok;
    await check(NOW + INTERVAL);
    expect(state.db.account().connectionCheckFailedAt).toBeNull();

    // A later refusal starts over.
    metaAnswer = lost;
    await check(NOW + 2 * INTERVAL);
    expect(state.db.account()).toMatchObject({
      connectionCheckFailedAt: new Date(NOW + 2 * INTERVAL),
      connectionLostAt: null,
    });
    expect(state.db.events).toHaveLength(0);
  });

  it("never writes anything while the connection works", async () => {
    await check(NOW);
    await check(NOW + INTERVAL);
    expect(state.db.updates).toHaveLength(0);
    expect(state.db.events).toHaveLength(0);
  });

  it("counts a token that cannot be decrypted as neither lost nor back", async () => {
    state.db.account().accessToken = "undecryptable";
    await check(NOW);
    await check(NOW + INTERVAL);
    expect(metaCalls).toHaveLength(0);
    expect(state.db.account().connectionCheckFailedAt).toBeNull();
  });
});

describe("the R1 pause", () => {
  it("asks Meta nothing while the account is paused, and opens no incident", async () => {
    metaAnswer = lost;
    await check(NOW);
    await fake.set("meta:pause:ig_1", String(NOW + 2 * HOUR), "PX", 2 * HOUR);

    await check(NOW + INTERVAL);
    await check(NOW + 2 * INTERVAL);
    expect(metaCalls).toHaveLength(1);
    expect(state.db.account().connectionLostAt).toBeNull();

    // After the pause the next refusal opens it.
    await check(NOW + 2 * HOUR + MINUTE);
    expect(metaCalls).toHaveLength(2);
    expect(state.db.account().connectionLostAt).toEqual(new Date(NOW));
  });

  it("does not open the incident when a pause begins during the check", async () => {
    metaAnswer = lost;
    await check(NOW);
    metaAnswer = async () => {
      await fake.set("meta:pause:ig_1", String(NOW + 2 * HOUR), "PX", 2 * HOUR);
      return lost();
    };

    await check(NOW + INTERVAL);
    expect(state.db.account()).toMatchObject({
      connectionCheckFailedAt: new Date(NOW),
      connectionLostAt: null,
    });
    expect(resendCalls).toHaveLength(0);
  });
});

describe("which accounts the check reads, and how", () => {
  beforeEach(() => {
    state.db.accounts.push(
      fakeAccount({
        id: "account_ig_login",
        instagramId: "ig_2",
        username: "second",
        metaLogin: "INSTAGRAM",
        connectedAt: new Date("2026-11-02T00:00:00.000Z"),
      }),
      fakeAccount({
        id: "account_zernio",
        instagramId: "ig_3",
        username: "zernio",
        provider: "ZERNIO",
        zernioAccountId: "z_1",
        accessToken: "",
      }),
      fakeAccount({ id: "account_no_token", instagramId: "ig_4", username: "empty", accessToken: "" })
    );
  });

  it("reads each account connected through Meta once, also one without a campaign", async () => {
    // No campaign exists at all: the check never asks for one.
    await check(NOW);

    expect(metaCalls.map((url) => `${url.origin}${url.pathname}`)).toEqual([
      `${FACEBOOK}/ig_1`,
      // An Instagram Login token reads its own account as `me`.
      `${INSTAGRAM}/me`,
    ]);
    for (const url of metaCalls) {
      expect(url.searchParams.get("fields")).toBe("id,username");
      expect(url.searchParams.get("access_token")).toBe("local-test-token");
    }
  });

  it("goes on with the other accounts when one cannot be checked", async () => {
    metaAnswer = (url) =>
      url.pathname.endsWith("/ig_1") ? lost() : Response.json({ id: "x" });
    // The database fails on the first account's write.
    const realUpdateMany = state.db.prisma.instagramAccount.updateMany;
    let first = true;
    state.db.prisma.instagramAccount.updateMany = async (args) => {
      if (first) {
        first = false;
        throw new Error("Connection terminated unexpectedly");
      }
      return realUpdateMany(args);
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await check(NOW);
    expect(summary.outcomes).toEqual({ error: 1, ok: 1 });
    expect(metaCalls).toHaveLength(2);
  });
});

describe("the end of an incident", () => {
  async function openIncident() {
    metaAnswer = lost;
    await check(NOW);
    await check(NOW + INTERVAL);
    expect(state.db.account().connectionLostAt).toEqual(new Date(NOW));
  }

  it("ends with a check that gets through, and keeps its start for the catch-up", async () => {
    await openIncident();
    metaAnswer = ok;
    await check(NOW + 4 * HOUR);

    expect(state.db.account()).toMatchObject({
      connectionCheckFailedAt: null,
      connectionLostAt: null,
      connectionLostReason: null,
      connectionAlertCount: 0,
      connectionRecoveredAt: new Date(NOW + 4 * HOUR),
      connectionCatchUpFrom: new Date(NOW),
      // The 24 hours count across incidents.
      connectionAlertSentAt: new Date(NOW + INTERVAL),
    });
    const [back] = events("connection-back");
    expect(back).toMatchObject({
      source: "WORKER",
      level: "INFO",
      workspaceId: "workspace_1",
      payload: {
        kind: "connection-back",
        account: "thomas.tergan",
        lostAt: new Date(NOW).toISOString(),
        catchUpFrom: new Date(NOW).toISOString(),
        via: "check",
      },
    });
    // The catch-up of the missed comments (lib/instagram/connection-catch-up.ts)
    // runs in the worker as its own job, under the id a reconnect uses too.
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      "process-catch-up",
      { accountConnectionId: "account_1", instagramAccountId: "ig_1" },
      expect.objectContaining({ jobId: `catchup_account_1_${NOW}`, delay: 0 })
    );
  });

  it("keeps an earlier start whose catch-up has not run yet", async () => {
    const earlier = new Date(NOW - 3 * 24 * HOUR);
    state.db.account().connectionCatchUpFrom = earlier;
    await openIncident();
    metaAnswer = ok;
    await check(NOW + 2 * HOUR);
    expect(state.db.account().connectionCatchUpFrom).toEqual(earlier);
    // One catch-up for both, from the earlier start.
    expect(queueAdd).toHaveBeenCalledWith(
      "process-catch-up",
      expect.anything(),
      expect.objectContaining({ jobId: `catchup_account_1_${earlier.getTime()}` })
    );
  });
});

describe("the e-mail along the incident", () => {
  it("e-mails when it opens, at most once per 24 hours, then one reminder", async () => {
    metaAnswer = lost;
    await check(NOW);
    await check(NOW + INTERVAL);
    expect(resendCalls).toHaveLength(2);

    // Every sweep for the next 24 hours: nothing more.
    for (let at = NOW + 2 * INTERVAL; at < NOW + INTERVAL + 24 * HOUR; at += INTERVAL) {
      await check(at);
    }
    expect(resendCalls).toHaveLength(2);

    await check(NOW + INTERVAL + 24 * HOUR);
    expect(resendCalls).toHaveLength(4);
    expect(resendCalls[2].body.subject).toBe(
      "Erinnerung: Instagram-Verbindung noch unterbrochen, OpenReply sendet weiter keine DMs"
    );
    expect(state.db.account().connectionAlertCount).toBe(2);

    // One reminder only.
    await check(NOW + INTERVAL + 49 * HOUR);
    await check(NOW + INTERVAL + 96 * HOUR);
    expect(resendCalls).toHaveLength(4);
  });

  it("e-mails a new incident within 24 hours of the last e-mail only when they are over", async () => {
    metaAnswer = lost;
    await check(NOW);
    await check(NOW + INTERVAL);
    metaAnswer = ok;
    await check(NOW + 2 * INTERVAL);
    metaAnswer = lost;
    await check(NOW + 3 * INTERVAL);
    await check(NOW + 4 * INTERVAL);
    expect(state.db.account().connectionLostAt).toEqual(new Date(NOW + 3 * INTERVAL));
    expect(resendCalls).toHaveLength(2);

    await check(NOW + INTERVAL + 24 * HOUR);
    expect(resendCalls).toHaveLength(4);
    // The new incident's first e-mail is its alert, not a reminder.
    expect(resendCalls[2].body.subject).toBe(
      "Instagram-Verbindung unterbrochen: OpenReply sendet gerade keine DMs"
    );
  });
});
