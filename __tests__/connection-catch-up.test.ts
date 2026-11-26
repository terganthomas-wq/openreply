/**
 * The catch-up after a lost Instagram connection (A1): which comments of the
 * meantime get their DM queued (the window, the filters, the sweep's
 * matching), how (one job per comment, recover_<ig>_<comment>, one every 20
 * seconds), what the caps and Meta's limits do, that it runs once per
 * incident, also across restarts, and that it ends with the all-clear e-mail.
 *
 * Meta and Resend are fetch answered here, never called; Redis (the account
 * pause) is an in-memory stand-in, the queue takes each job id once as BullMQ
 * does, and the account rows evaluate their conditional updates
 * (helpers/fake-connection-db.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeConnectionDb,
  fakeAccount,
  fakeCampaign,
} from "./helpers/fake-connection-db";
import { FakeRedis } from "./helpers/fake-redis";

const state = vi.hoisted(() => ({
  db: null as unknown as import("./helpers/fake-connection-db").FakeConnectionDb,
  redis: null as unknown,
}));
const queue = vi.hoisted(() => ({
  adds: [] as { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }[],
  ids: new Set<string>(),
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db.prisma;
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => state.redis,
  getDMQueue: () => ({
    // BullMQ takes a job id once while it holds the job.
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
      queue.adds.push({ name, data, opts });
      const id = opts.jobId as string | undefined;
      if (id && queue.ids.has(id)) return { id, duplicate: true };
      if (id) queue.ids.add(id);
      return { id };
    },
  }),
  CATCH_UP_JOB_NAME: "process-catch-up",
  COMMENT_JOB_NAME: "process-comment",
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "local-test-token" }));

import {
  CATCH_UP_BRAKE_WAIT_MS,
  CATCH_UP_LEASE_MS,
  CATCH_UP_RETRY_MS,
  recoverJobId,
  resetConnectionCatchUps,
  resumeConnectionCatchUps,
  runConnectionCatchUp,
  stopConnectionCatchUps,
} from "../lib/instagram/connection-catch-up";
import {
  catchUpHoldsSweep,
  catchUpJobId,
  readCatchUpProgress,
  readCatchUpResult,
} from "../lib/instagram/catch-up-state";
import { clearConnectionIncident } from "../lib/instagram/connection-state";
import { resetLatestMetaUsage } from "../lib/meta/usage";
import { resetAllClearWarnings } from "../lib/ops/connection-all-clear";
import { resetMailWarnings } from "../lib/ops/mail";
import { pausedRunAt } from "../lib/queue/account-pause";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 17:45 Berlin, as on 2026-11-25, and back at 21:50.
const LOST_AT = new Date("2026-11-25T16:45:00.000Z");
const RECOVERED = new Date("2026-11-25T20:50:00.000Z");
const NOW = RECOVERED.getTime() + MINUTE;
const FACEBOOK = "https://graph.facebook.com/v25.0";
const BASE_JOB = `catchup_account_1_${LOST_AT.getTime()}`;

interface FakeComment {
  id: string;
  text: string;
  timestamp: string;
  from?: { id: string; username?: string };
  replies?: { data: { id: string; from?: { id: string; username?: string } }[] };
}
interface FakePost {
  id: string;
  permalink: string;
  timestamp: string;
  comments_count?: number;
  /** Newest first, as Meta answers with order=reverse_chronological. */
  comments: FakeComment[];
}

let posts: FakePost[];
let metaCalls: URL[];
// Answers a Meta request first when it returns a Response.
let metaHook: (url: URL) => Response | null | Promise<Response | null>;
// Headers every Meta answer carries.
let metaHeaders: (url: URL) => Record<string, string>;
let resendTo: string[];

const at = (offsetMs: number) => new Date(LOST_AT.getTime() + offsetMs).toISOString();

function comment(id: string, text: string, offsetMs: number, extra: Partial<FakeComment> = {}): FakeComment {
  return {
    id,
    text,
    timestamp: at(offsetMs),
    from: { id: `person_${id}`, username: `person_${id}` },
    ...extra,
  };
}

function post(id: string, comments: FakeComment[], extra: Partial<FakePost> = {}): FakePost {
  return {
    id,
    permalink: `https://www.instagram.com/p/${id}/`,
    timestamp: at(-DAY),
    comments_count: comments.length,
    comments,
    ...extra,
  };
}

function graphError(code: number, subcode?: number) {
  return new Response(
    JSON.stringify({
      error: {
        code,
        error_subcode: subcode,
        type: "OAuthException",
        message: code === 4 ? "Application request limit reached" : "Object does not exist",
        fbtrace_id: "trace",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

function answerMeta(url: URL): Response {
  const parts = url.pathname.split("/").filter(Boolean); // [v25.0, node, edge]
  const [, node, edge] = parts;
  const headers = { "Content-Type": "application/json", ...metaHeaders(url) };
  const after = Number(url.searchParams.get("after") ?? 0);
  if (edge === "media") {
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const page = posts.slice(after, after + limit);
    const next =
      after + limit < posts.length
        ? `${FACEBOOK}/${node}/media?after=${after + limit}&limit=${limit}&access_token=local-test-token`
        : undefined;
    return new Response(
      JSON.stringify({
        data: page.map(({ id, permalink, timestamp, comments_count }) => ({
          id,
          permalink,
          timestamp,
          ...(comments_count === undefined ? {} : { comments_count }),
        })),
        ...(next ? { paging: { next } } : {}),
      }),
      { headers }
    );
  }
  if (edge === "comments") {
    const found = posts.find((item) => item.id === node);
    const all = found?.comments ?? [];
    const page = all.slice(after, after + 50);
    const next =
      after + 50 < all.length
        ? `${FACEBOOK}/${node}/comments?after=${after + 50}&access_token=local-test-token`
        : undefined;
    return new Response(
      JSON.stringify({ data: page, ...(next ? { paging: { next } } : {}) }),
      { headers }
    );
  }
  throw new Error(`unexpected Meta request ${url.pathname}`);
}

function commentReads(mediaId?: string) {
  return metaCalls.filter(
    (url) => url.pathname.endsWith("/comments") && (!mediaId || url.pathname.includes(`/${mediaId}/`))
  );
}
function mediaReads() {
  return metaCalls.filter((url) => url.pathname.endsWith("/media"));
}
/** The comment jobs, in the order they were queued. */
function commentJobs() {
  return queue.adds.filter((add) => add.name === "process-comment");
}
function catchUpJobs() {
  return queue.adds.filter((add) => add.name === "process-catch-up");
}
function account() {
  return state.db.account();
}
function result() {
  return readCatchUpResult(account().connectionCatchUpResult);
}
function progress() {
  return readCatchUpProgress(account().connectionCatchUpProgress);
}
const noWait = async () => {};
function run(at: number = Date.now()) {
  vi.setSystemTime(at);
  return runConnectionCatchUp("account_1", { sleep: noWait });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.redis = new FakeRedis();
  state.db = new FakeConnectionDb();
  // As the end of the incident leaves the row (clearConnectionIncident).
  state.db.accounts.push(
    fakeAccount({ connectionRecoveredAt: RECOVERED, connectionCatchUpFrom: LOST_AT })
  );
  state.db.campaigns.push(fakeCampaign({ id: "c_any", name: "Guide", keywords: ["guide"] }));
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
  posts = [];
  metaCalls = [];
  metaHook = () => null;
  metaHeaders = () => ({});
  resendTo = [];
  queue.adds = [];
  queue.ids = new Set();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === "https://api.resend.com") {
        resendTo.push(...(JSON.parse(String(init?.body)).to as string[]));
        return Response.json({ id: `email_${resendTo.length}` });
      }
      expect(url.origin).toBe("https://graph.facebook.com");
      expect(url.searchParams.get("access_token")).toBe("local-test-token");
      metaCalls.push(url);
      return (await metaHook(url)) ?? answerMeta(url);
    })
  );
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
  vi.stubEnv("RESEND_API_KEY", "re_test_only");
  vi.stubEnv("EMAIL_FROM", "OpenReply <alerts@example.test>");
  vi.stubEnv("EMAIL_SERVER", "");
  vi.stubEnv("NEXTAUTH_URL", "https://dm.example.test");
  vi.stubEnv("DEFAULT_LOCALE", "de");
  vi.stubEnv("META_THROTTLE_PAUSE_MINUTES", "");
  resetMailWarnings();
  resetAllClearWarnings();
  resetLatestMetaUsage();
  resetConnectionCatchUps();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("which comments are caught up", () => {
  it("queues the keyword comments made since the incident's start minus 45 minutes, none before", async () => {
    posts = [
      post("p1", [
        comment("c_during", "Guide bitte", 2 * HOUR),
        comment("c_margin", "guide", -40 * MINUTE),
        comment("c_before", "guide", -50 * MINUTE),
      ]),
    ];

    expect(await run()).toBe("done");

    expect(commentJobs().map((job) => job.opts.jobId)).toEqual([
      "recover_ig_1_c_margin",
      "recover_ig_1_c_during",
    ]);
    // The first page already reached back before the window: no second read.
    expect(commentReads()).toHaveLength(1);
    expect(account()).toMatchObject({
      connectionCatchUpFrom: null,
      connectionCatchUpClaimedAt: null,
      connectionCatchUpProgress: null,
    });
    expect(result()).toMatchObject({
      lostAt: LOST_AT.toISOString(),
      recoveredAt: RECOVERED.toISOString(),
      since: new Date(LOST_AT.getTime() - 45 * MINUTE).toISOString(),
      queued: 2,
      complete: true,
    });
  });

  it("hands the worker an ordinary comment job, marked as the catch-up's", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)])];
    await run();
    expect(commentJobs()).toEqual([
      {
        name: "process-comment",
        data: {
          instagramAccountId: "ig_1",
          accountConnectionId: "account_1",
          commentId: "c1",
          commentText: "guide",
          commenterId: "person_c1",
          commenterName: "person_c1",
          mediaId: "p1",
          source: "RECOVERY",
        },
        opts: {
          jobId: "recover_ig_1_c1",
          delay: 0,
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    ]);
    expect(recoverJobId("ig_1", "c1")).toBe("recover_ig_1_c1");
  });

  it("never queues the account's own comments, by id or by name", async () => {
    posts = [
      post("p1", [
        comment("c_own_id", "guide", HOUR, { from: { id: "ig_1", username: "thomas.tergan" } }),
        comment("c_own_name", "guide", HOUR, { from: { id: "17841400000", username: "Thomas.Tergan" } }),
        comment("c_other", "guide", HOUR),
      ]),
    ];
    await run();
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c_other"]);
  });

  it("matches as the sweep does: whole words, the question filter, active campaigns, the post's campaign first", async () => {
    state.db.campaigns = [
      fakeCampaign({ id: "c_bound", postId: "p1", matchAnyPost: false, keywords: ["guide"], createdAt: new Date("2026-11-02") }),
      fakeCampaign({ id: "c_info", keywords: ["info"], ignoreQuestionComments: true, createdAt: new Date("2026-11-01") }),
      fakeCampaign({ id: "c_off", keywords: ["kallt"], isActive: false }),
    ];
    posts = [
      post("p1", [
        comment("p1_guide", "Guide please", HOUR),
        comment("p1_word", "guidebook", HOUR),
        comment("p1_question", "info?", HOUR),
        comment("p1_info", "info", HOUR),
        comment("p1_paused", "kallt", HOUR),
      ]),
      post("p2", [comment("p2_guide", "guide", HOUR), comment("p2_info", "info bitte", HOUR)]),
    ];
    await run();
    expect(commentJobs().map((job) => [job.data.commentId, job.data.mediaId])).toEqual([
      ["p1_guide", "p1"],
      ["p1_info", "p1"],
      ["p2_info", "p2"],
    ]);
  });

  it("reads a campaign's own post when it is older than the newest posts, and the ads made from it", async () => {
    state.db.campaigns = [
      fakeCampaign({ id: "c_bound", postId: "p_old", matchAnyPost: false, keywords: ["guide"] }),
    ];
    state.db.ads = { p_old: ["ad_1"] };
    posts = [
      post("p_new", [comment("new_guide", "guide", HOUR)]),
      // Not in the media list Meta returns, but readable by its id.
    ];
    const old = post("p_old", [comment("old_guide", "guide", HOUR)]);
    const ad = post("ad_1", [comment("ad_guide", "guide", 2 * HOUR)]);
    metaHook = (url) => {
      if (url.pathname.includes("/p_old/") || url.pathname.includes("/ad_1/")) {
        const saved = posts;
        posts = [old, ad];
        try {
          return answerMeta(url);
        } finally {
          posts = saved;
        }
      }
      return null;
    };

    await run();
    // An any-post comment on the new post matches no campaign of its own.
    expect(commentJobs().map((job) => [job.data.commentId, job.data.mediaId, job.data.originalMediaId])).toEqual([
      ["old_guide", "p_old", undefined],
      ["ad_guide", "ad_1", "p_old"],
    ]);
    expect(commentReads("p_new")).toHaveLength(0);
  });

  it("leaves a comment alone that has a DmLog row, whatever it says", async () => {
    state.db.dmLogs.push(
      { instagramAccountId: "account_1", automationId: "c_any", commentId: "c_failed", status: "FAILED" },
      { instagramAccountId: "account_1", automationId: "c_any", commentId: "c_pending", status: "PENDING" }
    );
    posts = [
      post("p1", [
        comment("c_failed", "guide", HOUR),
        comment("c_pending", "guide", HOUR),
        comment("c_new", "guide", HOUR),
      ]),
    ];
    await run();
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c_new"]);
  });

  it("skips comments outside Instagram's 7 days for a private reply, even inside the incident", async () => {
    // An incident that began 8 days ago.
    const longAgo = new Date(NOW - 8 * DAY);
    Object.assign(account(), { connectionCatchUpFrom: longAgo, connectionRecoveredAt: new Date(NOW - MINUTE) });
    const ago = (ms: number) => new Date(NOW - ms).toISOString();
    posts = [
      post("p1", [
        { ...comment("c_6_days", "guide", 0), timestamp: ago(6 * DAY) },
        { ...comment("c_7_5_days", "guide", 0), timestamp: ago(7.5 * DAY) },
        {
          ...comment("c_answered_old", "guide", 0),
          timestamp: ago(7.6 * DAY),
          replies: { data: [{ id: "r", from: { id: "ig_1", username: "thomas.tergan" } }] },
        },
      ]),
    ];
    await run();
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c_6_days"]);
    expect(result()?.skipped.tooOld).toBe(1);
    // "DM senden" could not send it any more either.
    expect(result()?.ownerAnswered).toEqual([]);
  });

  it("does not queue a comment the owner answered by hand, and lists it with author, text, time and the post", async () => {
    posts = [
      post("p1", [
        comment("c_answered", "Guide bitte!", HOUR, {
          replies: { data: [{ id: "r1", from: { id: "ig_1", username: "thomas.tergan" } }] },
        }),
        comment("c_answered_by_name", "guide", 2 * HOUR, {
          replies: { data: [{ id: "r2", from: { id: "1784", username: "thomas.tergan" } }] },
        }),
        comment("c_someone_replied", "guide", 3 * HOUR, {
          replies: { data: [{ id: "r3", from: { id: "friend", username: "friend" } }] },
        }),
      ]),
    ];
    await run();
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c_someone_replied"]);
    expect(result()?.ownerAnswered).toEqual([
      {
        commentId: "c_answered",
        username: "person_c_answered",
        text: "Guide bitte!",
        timestamp: at(HOUR),
        permalink: "https://www.instagram.com/p/p1/",
      },
      {
        commentId: "c_answered_by_name",
        username: "person_c_answered_by_name",
        text: "guide",
        timestamp: at(2 * HOUR),
        permalink: "https://www.instagram.com/p/p1/",
      },
    ]);
    expect(result()?.ownerAnsweredTotal).toBe(2);
  });

  it("reads nothing at Meta without an active campaign, and still ends with the all-clear", async () => {
    state.db.campaigns = [fakeCampaign({ isActive: false })];
    posts = [post("p1", [comment("c1", "guide", HOUR)])];
    expect(await run()).toBe("done");
    expect(metaCalls).toHaveLength(0);
    expect(result()).toMatchObject({ queued: 0, complete: true });
    expect(resendTo).toHaveLength(2);
  });

  it("clears what an account not read through Meta could never catch up", async () => {
    Object.assign(account(), { provider: "ZERNIO", zernioAccountId: "z_1" });
    expect(await run()).toBe("none");
    expect(metaCalls).toHaveLength(0);
    expect(account().connectionCatchUpFrom).toBeNull();
  });

  it("reads no post without comments, and none without a campaign that covers it", async () => {
    state.db.campaigns = [
      fakeCampaign({ id: "c_bound", postId: "p2", matchAnyPost: false, keywords: ["guide"] }),
    ];
    posts = [
      post("p1", [comment("p1_c", "guide", HOUR)]),
      post("p2", [comment("p2_c", "guide", HOUR)]),
      post("p3", [], { comments_count: 0 }),
    ];
    await run();
    expect(commentReads().map((url) => url.pathname.split("/")[2])).toEqual(["p2"]);

    // With an any-post campaign every post with comments is read.
    state.db.campaigns.push(fakeCampaign({ id: "c_any" }));
    Object.assign(account(), { connectionCatchUpFrom: LOST_AT });
    metaCalls = [];
    await run();
    expect(commentReads().map((url) => url.pathname.split("/")[2])).toEqual(["p1", "p2"]);
  });
});

describe("the jobs", () => {
  it("are one per comment, the first right away, then one every 20 seconds across posts", async () => {
    posts = [
      post("p1", [comment("p1_late", "guide", 3 * HOUR), comment("p1_early", "guide", HOUR)]),
      post("p2", [comment("p2", "guide", 2 * HOUR)]),
    ];
    await run();
    expect(commentJobs().map((job) => [job.opts.jobId, job.opts.delay])).toEqual([
      ["recover_ig_1_p1_early", 0],
      ["recover_ig_1_p1_late", 20_000],
      ["recover_ig_1_p2", 40_000],
    ]);
    expect(result()).toMatchObject({
      firstJobAt: new Date(NOW).toISOString(),
      lastJobAt: new Date(NOW + 40_000).toISOString(),
    });
  });

  it("get the same id when a later catch-up finds the comment again, so the queue keeps one", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)])];
    await run();
    // One more incident ends while that job still waits (its DmLog row comes
    // when it runs), and its catch-up reads the comment again.
    // Its window (from 45 minutes before its start) still holds the comment.
    Object.assign(account(), {
      connectionCatchUpFrom: new Date(LOST_AT.getTime() + 90 * MINUTE),
      connectionRecoveredAt: new Date(NOW + 10 * MINUTE),
    });
    await run(NOW + 11 * MINUTE);
    const ids = commentJobs().map((job) => job.opts.jobId);
    expect(ids).toEqual(["recover_ig_1_c1", "recover_ig_1_c1"]);
    expect(queue.ids.has("recover_ig_1_c1")).toBe(true);
    expect([...queue.ids].filter((id) => id.startsWith("recover_"))).toHaveLength(1);
  });
});

describe("the caps", () => {
  it("reads the newest 300 posts and says that older ones were not read", async () => {
    posts = Array.from({ length: 350 }, (_, index) =>
      post(`p${index}`, [comment(`c${index}`, index === 299 || index === 300 ? "guide" : "hello", HOUR)])
    );
    await run();
    expect(mediaReads()).toHaveLength(3);
    expect(commentReads()).toHaveLength(300);
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c299"]);
    expect(result()?.skipped.olderPosts).toBe(true);
    expect(result()?.complete).toBe(false);
    const [event] = state.db.events.filter((item) => item.payload?.kind === "connection-catch-up");
    expect(event).toMatchObject({ level: "WARNING" });
    expect(event.message).toContain("posts older than the newest 300");
  });

  it("reads at most 500 pages of comments and says which posts it left out", async () => {
    // A post with 600 pages of comments inside the window, then two more.
    const busy = Array.from({ length: 600 * 50 }, (_, index) =>
      comment(`b${index}`, "hello", 3 * HOUR - index)
    );
    posts = [
      post("p_busy", busy),
      post("p2", [comment("p2_guide", "guide", HOUR)]),
      post("p3", [comment("p3_guide", "guide", HOUR)]),
    ];
    await run();
    expect(commentReads()).toHaveLength(500);
    expect(commentReads("p2")).toHaveLength(0);
    expect(result()?.skipped).toMatchObject({ postsPartial: 1, postsNotRead: 2 });
    const [event] = state.db.events.filter((item) => item.payload?.kind === "connection-catch-up");
    expect(event.message).toContain("2 posts not read (limit of 500 comment pages)");
    expect(event.message).toContain("1 posts read in part");
  });

  it("queues at most 1,000 comments and counts the rest", async () => {
    posts = [
      post(
        "p1",
        Array.from({ length: 1_050 }, (_, index) => comment(`c${index}`, "guide", 3 * HOUR - index * 1000))
      ),
    ];
    await run();
    expect(commentJobs()).toHaveLength(1_000);
    expect(result()).toMatchObject({ queued: 1_000, complete: false });
    expect(result()?.skipped.notQueued).toBe(50);
  });
});

describe("the R1 pause and Meta's limits", () => {
  it("asks Meta nothing while the account is paused, and goes on after the pause", async () => {
    const resumeAt = NOW + 20 * MINUTE;
    await (state.redis as FakeRedis).set("meta:pause:ig_1", String(resumeAt), "PX", 20 * MINUTE);
    posts = [post("p1", [comment("c1", "guide", HOUR)])];

    expect(await run()).toBe("paused");
    expect(metaCalls).toHaveLength(0);
    const runAt = pausedRunAt(resumeAt, BASE_JOB);
    expect(catchUpJobs()).toEqual([
      {
        name: "process-catch-up",
        data: { accountConnectionId: "account_1", instagramAccountId: "ig_1" },
        opts: {
          jobId: catchUpJobId("account_1", LOST_AT, runAt),
          delay: runAt - NOW,
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    ]);
    expect(account()).toMatchObject({ connectionCatchUpFrom: LOST_AT, connectionCatchUpClaimedAt: null });
    expect(progress()?.resumeAt).toBe(new Date(runAt).toISOString());

    // Asked again in the meantime (the sweep, a restart): it waits.
    expect(await run(NOW + 5 * MINUTE)).toBe("waiting");
    expect(metaCalls).toHaveLength(0);

    expect(await run(runAt)).toBe("done");
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c1"]);
  });

  it("stops at a pause that begins while it reads, and later reads only what is left", async () => {
    posts = [
      post("p1", [comment("c1", "guide", HOUR)]),
      post("p2", [comment("c2", "guide", HOUR)]),
      post("p3", [comment("c3", "guide", HOUR)]),
    ];
    const resumeAt = NOW + 20 * MINUTE;
    metaHook = async (url) => {
      // A DM of the catch-up runs into Meta's limit while p1 is read.
      if (url.pathname.includes("/p1/")) {
        await (state.redis as FakeRedis).set("meta:pause:ig_1", String(resumeAt), "PX", 20 * MINUTE);
      }
      return null;
    };

    expect(await run()).toBe("paused");
    expect(commentReads().map((url) => url.pathname.split("/")[2])).toEqual(["p1"]);
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c1"]);
    expect(progress()).toMatchObject({ next: 1, queuedIds: ["c1"] });

    metaHook = () => null;
    metaCalls = [];
    const runAt = pausedRunAt(resumeAt, BASE_JOB);
    expect(await run(runAt)).toBe("done");
    // The posts list and p1 are not read again.
    expect(mediaReads()).toHaveLength(0);
    expect(commentReads().map((url) => url.pathname.split("/")[2])).toEqual(["p2", "p3"]);
    expect(commentJobs().map((job) => [job.data.commentId, job.opts.delay])).toEqual([
      ["c1", 0],
      ["c2", 0],
      ["c3", 20_000],
    ]);
    expect(result()?.queued).toBe(3);
  });

  it("stops at a request limit on a read, without pausing the account's DMs, and goes on later", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)]), post("p2", [comment("c2", "guide", HOUR)])];
    metaHook = (url) => (url.pathname.includes("/p2/") ? graphError(4) : null);

    expect(await run()).toBe("stopped");
    expect((state.redis as FakeRedis).strings.has("meta:pause:ig_1")).toBe(false);
    const [continuation] = catchUpJobs();
    expect(continuation.opts.delay).toBe(20 * MINUTE);
    expect(progress()).toMatchObject({ next: 1, queuedIds: ["c1"] });

    metaHook = () => null;
    expect(await run(NOW + 20 * MINUTE)).toBe("done");
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c1", "c2"]);
  });

  it("stops early when Meta reports 60 % of a limit, and goes on 15 minutes later", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)]), post("p2", [comment("c2", "guide", HOUR)])];
    metaHeaders = (url): Record<string, string> =>
      url.pathname.includes("/p1/")
        ? { "x-app-usage": JSON.stringify({ call_count: 65, total_cputime: 10, total_time: 12 }) }
        : {};

    expect(await run()).toBe("stopped");
    expect(commentReads().map((url) => url.pathname.split("/")[2])).toEqual(["p1"]);
    expect(catchUpJobs()[0].opts.delay).toBe(CATCH_UP_BRAKE_WAIT_MS);

    metaHeaders = () => ({ "x-app-usage": JSON.stringify({ call_count: 20 }) });
    expect(await run(NOW + CATCH_UP_BRAKE_WAIT_MS)).toBe("done");
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c1", "c2"]);
  });

  it("stops as for a lost connection when Meta refuses three posts in a row, and reads them again later", async () => {
    posts = [
      post("p1", [comment("c1", "guide", HOUR)]),
      post("p2", [comment("c2", "guide", HOUR)]),
      post("p3", [comment("c3", "guide", HOUR)]),
      post("p4", [comment("c4", "guide", HOUR)]),
    ];
    metaHook = (url) => (url.pathname.endsWith("/comments") ? graphError(100, 33) : null);

    expect(await run()).toBe("stopped");
    expect(commentJobs()).toHaveLength(0);
    expect(progress()).toMatchObject({ next: 0 });
    expect(catchUpJobs()[0].opts.delay).toBe(CATCH_UP_RETRY_MS);

    metaHook = () => null;
    expect(await run(NOW + CATCH_UP_RETRY_MS)).toBe("done");
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(result()).toMatchObject({ complete: true });
  });

  it("counts a campaign's post that is gone as not read, never as a lost account", async () => {
    state.db.campaigns = ["gone_1", "gone_2", "gone_3"].map((postId, index) =>
      fakeCampaign({ id: `c_${postId}`, postId, matchAnyPost: false, createdAt: new Date(2026, 10, index + 1) })
    );
    metaHook = (url) => (url.pathname.includes("/gone_") ? graphError(100, 33) : null);
    expect(await run()).toBe("done");
    expect(commentReads()).toHaveLength(3);
    expect(result()?.skipped.postsFailed).toBe(3);
  });

  it("stops at once when Meta no longer accepts the token, and reads that post again later", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)]), post("p2", [comment("c2", "guide", HOUR)])];
    metaHook = (url) => (url.pathname.includes("/p2/") ? graphError(190) : null);
    expect(await run()).toBe("stopped");
    expect(progress()).toMatchObject({ next: 1, queuedIds: ["c1"] });
    expect(catchUpJobs()[0].opts.delay).toBe(CATCH_UP_RETRY_MS);
  });

  it("counts one post Meta refuses as not read, and reads the others", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)]), post("p2", [comment("c2", "guide", HOUR)])];
    metaHook = (url) => (url.pathname.includes("/p1/") ? graphError(100, 33) : null);
    expect(await run()).toBe("done");
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c2"]);
    expect(result()?.skipped.postsFailed).toBe(1);
    expect(result()?.complete).toBe(false);
  });

  it("stops before its next read when the worker shuts down, and goes on a minute later", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)])];
    stopConnectionCatchUps();
    expect(await run()).toBe("stopped");
    expect(metaCalls).toHaveLength(0);
    expect(catchUpJobs()[0].opts.delay).toBe(MINUTE);
    expect(account().connectionCatchUpClaimedAt).toBeNull();
  });
});

describe("once per incident", () => {
  it("does nothing more once it has run", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)])];
    expect(await run()).toBe("done");
    const reads = metaCalls.length;
    expect(await run(NOW + MINUTE)).toBe("none");
    expect(metaCalls).toHaveLength(reads);
    expect(commentJobs()).toHaveLength(1);
    // One all-clear per owner and admin.
    expect(resendTo.sort()).toEqual(["admin@example.test", "owner@example.test"]);
  });

  it("stands back while another run holds the lease, and takes over once a died run's lease is 10 minutes old", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)])];
    const heldSince = new Date(NOW - MINUTE);
    account().connectionCatchUpClaimedAt = heldSince;

    expect(await run()).toBe("busy");
    expect(metaCalls).toHaveLength(0);
    // Tries again right after that lease would run out.
    expect(catchUpJobs()[0].opts.delay).toBe(heldSince.getTime() + CATCH_UP_LEASE_MS + 1_000 - NOW);

    expect(await run(heldSince.getTime() + CATCH_UP_LEASE_MS + 1_000)).toBe("done");
    expect(commentJobs()).toHaveLength(1);
  });

  it("waits while a new incident is open; its end asks again", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)])];
    account().connectionLostAt = new Date(NOW - 5 * MINUTE);
    expect(await run()).toBe("lost");
    expect(metaCalls).toHaveLength(0);
    expect(account().connectionCatchUpFrom).toEqual(LOST_AT);
  });

  it("queues one catch-up when a reconnect and a check end the incident at the same moment", async () => {
    Object.assign(account(), {
      connectionLostAt: LOST_AT,
      connectionCheckFailedAt: LOST_AT,
      connectionLostReason: "missing (Meta 100/33)",
      connectionCatchUpFrom: null,
      connectionRecoveredAt: null,
    });
    const ended = await Promise.all([
      clearConnectionIncident("account_1", { via: "reconnect", now: NOW }),
      clearConnectionIncident("account_1", { via: "check", now: NOW }),
    ]);
    expect(ended.filter(Boolean)).toHaveLength(1);
    expect(catchUpJobs().map((job) => job.opts.jobId)).toEqual([BASE_JOB]);
  });

  it("runs again, without queueing anything twice, when one more incident ended while it read", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)]), post("p2", [comment("c2", "guide", HOUR)])];
    const laterEnd = new Date(NOW + 2 * MINUTE);
    metaHook = (url) => {
      // The connection dropped and came back again (merged: the start stays).
      if (url.pathname.includes("/p2/")) account().connectionRecoveredAt = laterEnd;
      return null;
    };
    expect(await run()).toBe("superseded");
    expect(account().connectionCatchUpFrom).toEqual(LOST_AT);
    expect(resendTo).toHaveLength(0);
    const [again] = catchUpJobs();
    expect(again.opts.delay).toBe(1_000);

    metaHook = () => null;
    metaCalls = [];
    expect(await run(NOW + 3 * MINUTE)).toBe("done");
    // Everything is read again for the new end, but nothing is queued twice.
    expect(commentReads()).toHaveLength(2);
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c1", "c2"]);
    expect(result()).toMatchObject({ recoveredAt: laterEnd.toISOString(), queued: 2 });
    expect(resendTo).toHaveLength(2);
  });

  it("ends with what it has after 24 hours of trying", async () => {
    posts = [post("p1", [comment("c1", "guide", HOUR)])];
    account().connectionCatchUpProgress = {
      v: 1,
      from: LOST_AT.toISOString(),
      recoveredAt: RECOVERED.toISOString(),
      startedAt: new Date(NOW - 25 * HOUR).toISOString(),
      posts: [{ id: "p1", permalink: null }, { id: "p2", permalink: null }, { id: "p3", permalink: null }],
      next: 1,
      pages: 1,
      queuedIds: ["c0"],
      firstJobAt: null,
      lastJobAt: null,
      answeredIds: [],
      answered: [],
      seen: 1,
      handled: 0,
      skipped: {},
      stops: 9,
      resumeAt: null,
    };
    expect(await run()).toBe("done");
    expect(metaCalls).toHaveLength(0);
    expect(result()).toMatchObject({ queued: 1, complete: false });
    expect(result()?.skipped).toMatchObject({ gaveUp: true, postsNotRead: 2 });
  });
});

describe("the worker's sweep", () => {
  it("asks again for a catch-up that is owed and neither running nor queued for later", async () => {
    expect(await resumeConnectionCatchUps()).toEqual({ requested: 1, mailed: 0 });
    expect(catchUpJobs().map((job) => [job.opts.jobId, job.opts.delay])).toEqual([[BASE_JOB, 0]]);
  });

  it("leaves one alone that runs, waits for later, or waits for an open incident", async () => {
    account().connectionCatchUpClaimedAt = new Date(NOW - MINUTE);
    expect((await resumeConnectionCatchUps()).requested).toBe(0);

    account().connectionCatchUpClaimedAt = null;
    account().connectionCatchUpProgress = {
      v: 1,
      from: LOST_AT.toISOString(),
      recoveredAt: RECOVERED.toISOString(),
      startedAt: new Date(NOW).toISOString(),
      posts: null,
      resumeAt: new Date(NOW + 10 * MINUTE).toISOString(),
    };
    expect((await resumeConnectionCatchUps()).requested).toBe(0);
    // Its job was lost: once it is overdue, the sweep asks again.
    vi.setSystemTime(NOW + 16 * MINUTE);
    expect((await resumeConnectionCatchUps()).requested).toBe(1);

    queue.adds = [];
    account().connectionLostAt = new Date(NOW);
    expect((await resumeConnectionCatchUps()).requested).toBe(0);
  });

  it("stands the comment sweep back while the catch-up runs and its jobs wait", async () => {
    posts = [
      post("p1", [comment("c1", "guide", HOUR), comment("c2", "guide", 2 * HOUR), comment("c3", "guide", 3 * HOUR)]),
    ];
    expect(catchUpHoldsSweep(account(), NOW)).toBe(true);
    await run();
    // Its last job runs 40 seconds from now.
    expect(catchUpHoldsSweep(account(), NOW + 30_000)).toBe(true);
    expect(catchUpHoldsSweep(account(), NOW + 41_000)).toBe(false);
    // Never longer than 30 hours after the incident ended.
    account().connectionCatchUpFrom = LOST_AT;
    expect(catchUpHoldsSweep(account(), RECOVERED.getTime() + 31 * HOUR)).toBe(false);
    expect(catchUpHoldsSweep({ connectionRecoveredAt: null }, NOW)).toBe(false);
  });
});
