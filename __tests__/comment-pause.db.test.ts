/**
 * A comment whose DM Meta refuses for a request limit, against a real
 * Postgres (R1).
 *
 * What makes this safe lives in where clauses no mock evaluates: the claim
 * that a send takes on the DmLog row, giving it back with its attempt, and
 * the cap of three attempts across every job of a comment. So the comment
 * jobs run here on the real tables. Instagram, Redis (the account pause), the
 * queue, the usage counter and the hourly limiter are replaced. Skipped
 * without TEST_DATABASE_URL; each run builds its own throwaway schema from
 * prisma/migrations and drops it at the end.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";
import { FakeRedis } from "./helpers/fake-redis";

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  redis: null as unknown,
  processor: null as null | ((job: unknown) => Promise<void>),
}));
const { mockQueueAdd, mockSendPrivateReply } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockSendPrivateReply: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd, remove: vi.fn() }),
  getRedisConnection: () => state.redis,
  COMMENT_JOB_NAME: "process-comment",
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
  DM_SENDER_JOB_NAME: "process-dm-sender",
  OFFER_JOB_NAME: "process-offer",
  CATCH_UP_JOB_NAME: "process-catch-up",
  LOST_TAP_SEARCH_JOB_NAME: "process-lost-taps",
}));
// Closed: a Meta function the comment path starts to use without a mock here
// fails the suite instead of calling Instagram.
vi.mock("@/lib/meta/client", () => {
  class MetaApiError extends Error {
    code: number;
    constructor(
      code: number,
      _subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.name = "MetaApiError";
    }
  }
  class TokenExpiredError extends MetaApiError {
    constructor(message: string) {
      super(190, undefined, undefined, message);
      this.name = "TokenExpiredError";
    }
  }
  class RateLimitError extends MetaApiError {
    constructor(message: string, code = 368) {
      super(code, undefined, undefined, message);
      this.name = "RateLimitError";
    }
  }
  return {
    sendPrivateReply: mockSendPrivateReply,
    sendCommentReply: vi.fn(),
    MetaApiError,
    TokenExpiredError,
    RateLimitError,
  };
});
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "local-test-only" }));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: async () => ({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: new Date("2026-11-01T00:00:00.000Z"),
  }),
  releaseWorkspaceDMReservation: async () => ({ count: 1 }),
}));
vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: async () => ({
    allowed: true,
    currentCount: 1,
    remainingDMs: 749,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  }),
  releaseDMSlot: async () => 0,
}));
vi.mock("@/lib/ops/worker-health", () => ({ recordWorkerAlert: vi.fn() }));
vi.mock("bullmq", () => ({
  Worker: function MockWorker(_name: string, processor: (job: unknown) => Promise<void>) {
    state.processor = processor;
    return { on: vi.fn(), close: vi.fn() };
  },
  UnrecoverableError: class UnrecoverableError extends Error {
    name = "UnrecoverableError";
  },
}));

import { MetaApiError, RateLimitError } from "../lib/meta/client";
import {
  claimCommentDelivery,
  releaseCommentClaim,
} from "../lib/queue/comment-delivery";
import { createDMWorker } from "../lib/queue/dm-worker";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `comment_pause_${randomBytes(4).toString("hex")}`;
const NOW = new Date("2026-11-21T13:00:00.000Z").getTime();
const MINUTE = 60_000;
let sql: Client;

// Meta's answer to a send while the app is over its limit, as seen live.
const LIMIT = () =>
  new (RateLimitError as unknown as new (message: string, code: number) => Error)(
    "(#4) Application request limit reached (/v25.0/ig_pause/messages) [code=4 sub=- type=OAuthException trace=t]",
    4
  );

function commentJob(commentId: string, extra: Record<string, unknown> = {}, id?: string) {
  return {
    name: "process-comment",
    id: id ?? `comment_ig_pause_${commentId}`,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    data: {
      instagramAccountId: "ig_pause",
      accountConnectionId: "account",
      commentId,
      commentText: "LINK please",
      commenterId: `person_${commentId}`,
      commenterName: "reader",
      mediaId: "media_1",
      source: "WEBHOOK",
      ...extra,
    },
  };
}

function row(commentId: string) {
  return state.db.dmLog.findUniqueOrThrow({
    where: { automationId_commentId: { automationId: "automation", commentId } },
  });
}

// The copies queued for the pause, as BullMQ would hold them.
function pauseCopies() {
  return mockQueueAdd.mock.calls
    .filter(([, , opts]) => String(opts?.jobId).includes("_pause_"))
    .map(([name, data, opts]) => ({ name, data, opts }));
}

describe.skipIf(!databaseUrl)("comment DMs and Meta's request limits on Postgres", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const entry of readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      await sql.query(readFileSync(path.join(root, entry.name, "migration.sql"), "utf8"));
    }
    // One connection: the local test server runs every connection in one
    // backend session, where two statements at once garble each other. The
    // jobs below still interleave at every await, as they do in the worker.
    state.db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl, max: 1 }, { schema }),
    });
    await state.db.user.create({ data: { id: "user", email: "pause@example.test" } });
    await state.db.workspace.create({
      data: { id: "workspace", name: "Pause", ownerId: "user" },
    });
    await state.db.instagramAccount.create({
      data: {
        id: "account",
        workspaceId: "workspace",
        instagramId: "ig_pause",
        username: "studio",
        accessToken: "local-test-only",
      },
    });
    await state.db.automation.create({
      data: {
        id: "automation",
        workspaceId: "workspace",
        instagramAccountId: "account",
        name: "Guide",
        postId: "media_1",
        keywords: ["LINK"],
        dmMessage: "Here is your guide",
      },
    });
    createDMWorker();
  }, 60_000);

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    state.redis = new FakeRedis();
    mockQueueAdd.mockReset().mockResolvedValue({});
    mockSendPrivateReply.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const run = (job: unknown) => state.processor!(job);

  it("costs the comment no attempt, and its copy sends the DM once after the pause", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(LIMIT());

    await expect(run(commentJob("c1"))).resolves.toBeUndefined();

    expect(await row("c1")).toMatchObject({
      status: "PENDING",
      attempts: 0,
      dmDeliveryUnconfirmed: false,
      errorMessage: expect.stringMatching(/^Instagram request limit; next try at 13:2\d UTC$/),
    });
    const [copy] = pauseCopies();
    expect(copy.opts.jobId).toBe("comment_ig_pause_c1_pause_1");
    expect(
      await state.db.operationalEvent.count({
        where: { level: "WARNING", message: { startsWith: "Instagram request limit reached" } },
      })
    ).toBe(1);

    // After the pause, the copy runs and sends.
    vi.setSystemTime(NOW + copy.opts.delay);
    mockSendPrivateReply.mockResolvedValueOnce({ recipient_id: "p", message_id: "m" });
    await run({ ...commentJob("c1", copy.data, copy.opts.jobId) });

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(2);
    expect(await row("c1")).toMatchObject({
      status: "SENT",
      attempts: 1,
      dmDeliveryUnconfirmed: false,
      errorMessage: null,
    });
  });

  it("holds a comment during the pause without touching its attempts or its claim", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(LIMIT());
    await run(commentJob("c2"));
    // A second comment while the account is paused: Meta is not called.
    await run(commentJob("c3"));

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(await row("c3")).toMatchObject({
      status: "PENDING",
      attempts: 0,
      dmDeliveryUnconfirmed: false,
      errorMessage: expect.stringMatching(/^Instagram request limit; next try at/),
    });
    expect(pauseCopies().map((c) => c.opts.jobId)).toEqual([
      "comment_ig_pause_c2_pause_1",
      "comment_ig_pause_c3_pause_1",
    ]);
  });

  it("lets limits cost no attempts, while real refusals still stop at three", async () => {
    // Five limits in a row, each after the last pause ended.
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(NOW + i * 61 * MINUTE);
      mockSendPrivateReply.mockRejectedValueOnce(LIMIT());
      await run(commentJob("c4", { pauseRequeue: i }, `copy_${i}`));
      expect((await row("c4")).attempts).toBe(0);
    }

    // Three refusals that are no limit count as before.
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(NOW + (6 + i) * 61 * MINUTE);
      mockSendPrivateReply.mockRejectedValueOnce(
        new MetaApiError(100, undefined, undefined, "Invalid parameter")
      );
      await expect(run(commentJob("c4", {}, `refused_${i}`))).rejects.toThrow(
        "Invalid parameter"
      );
    }
    expect(await row("c4")).toMatchObject({ status: "FAILED", attempts: 3 });

    // The fourth job finds the attempts used up and sends nothing.
    vi.setSystemTime(NOW + 10 * 61 * MINUTE);
    await run(commentJob("c4", {}, "after"));
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(8);
  });

  it("never sends twice when the copy and a retry of the comment race", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(LIMIT());
    await run(commentJob("c5"));
    const [copy] = pauseCopies();

    vi.setSystemTime(NOW + copy.opts.delay);
    mockSendPrivateReply.mockResolvedValue({ recipient_id: "p", message_id: "m" });
    const outcomes = await Promise.allSettled([
      run(commentJob("c5", copy.data, copy.opts.jobId)),
      run(commentJob("c5", {}, "sweep_job")),
      run(commentJob("c5", {}, "comment_ig_pause_c5")),
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    // The limited try and one send: the claim lets only one job through.
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(2);
    expect(await row("c5")).toMatchObject({ status: "SENT", attempts: 1 });
  });

  it("fails the comment after the twelfth wait, counting that try once", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(LIMIT());

    await expect(run(commentJob("c6", { pauseRequeue: 12 }))).rejects.toMatchObject({
      name: "RateLimitError",
    });

    expect(pauseCopies()).toHaveLength(0);
    expect(await row("c6")).toMatchObject({
      status: "FAILED",
      attempts: 1,
      dmDeliveryUnconfirmed: false,
      errorMessage: expect.stringMatching(
        /^Instagram request limit: the account was still paused after 12 waits \(until 13:20 UTC\), so the DM was not sent\./
      ),
    });
  });

  describe("giving a claim back", () => {
    async function seed(commentId: string, data: Record<string, unknown> = {}) {
      await state.db.dmLog.create({
        data: {
          workspaceId: "workspace",
          instagramAccountId: "account",
          automationId: "automation",
          commenterId: "person",
          commentId,
          commentText: "LINK",
          ...data,
        },
      });
    }

    it("restores the attempts and frees the row for the next claim", async () => {
      await seed("r1", { attempts: 2 });
      expect(await claimCommentDelivery("automation", "r1", "dm")).toBe(true);
      expect(await row("r1")).toMatchObject({ attempts: 3, dmDeliveryUnconfirmed: true });

      expect(await releaseCommentClaim("automation", "r1", "Instagram request limit; next try at 13:20 UTC")).toBe(true);
      expect(await row("r1")).toMatchObject({
        attempts: 2,
        dmDeliveryUnconfirmed: false,
        status: "PENDING",
        errorMessage: "Instagram request limit; next try at 13:20 UTC",
      });
      // Exactly one of several jobs gets the freed row.
      const claims = [];
      for (let i = 0; i < 4; i++) {
        claims.push(await claimCommentDelivery("automation", "r1", "dm"));
      }
      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it("gives back nothing that is not claimed, nor a DM recorded as sent", async () => {
      await seed("r2", { attempts: 1 });
      expect(await releaseCommentClaim("automation", "r2", "x")).toBe(false);
      expect(await row("r2")).toMatchObject({ attempts: 1, status: "PENDING", errorMessage: null });

      await seed("r3", { attempts: 1, status: "SENT", dmDeliveryUnconfirmed: true });
      expect(await releaseCommentClaim("automation", "r3", "x")).toBe(false);
      expect(await row("r3")).toMatchObject({ attempts: 1, status: "SENT", dmDeliveryUnconfirmed: true });
    });
  });
});
