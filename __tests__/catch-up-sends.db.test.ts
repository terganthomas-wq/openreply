/**
 * The catch-up's DMs after a lost connection (A1) in the worker, against a
 * real Postgres: how its comment jobs (recover_<ig>_<comment>, source
 * RECOVERY) behave when they meet an R1 pause, a new incident, or Meta's
 * usage close to a limit.
 *
 * - A pause holds them, and their copies line up behind the catch-up's other
 *   jobs, one every CATCH_UP_SPACING_MS (the catch-up's pace in Redis),
 *   instead of all running in the minute after the pause: the burst that ran
 *   into Meta's limit on 2026-11-21.
 * - While the account's connection is lost nothing is sent and no attempt is
 *   used; a refusal of the account during the check's first strike gives its
 *   claim back without counting it.
 * - While Meta reports 60 % of a limit their DMs wait, without a claim.
 *
 * Instagram, Redis, the queue, the usage counter and the hourly limiter are
 * replaced. Skipped without TEST_DATABASE_URL; each run builds its own
 * throwaway schema from prisma/migrations and drops it at the end.
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
const { mockQueueAdd, mockSendPrivateReply, mockSendCommentReply } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockSendPrivateReply: vi.fn(),
  mockSendCommentReply: vi.fn(),
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
  OFFER_JOB_NAME: "process-offer",
  CATCH_UP_JOB_NAME: "process-catch-up",
  LOST_TAP_SEARCH_JOB_NAME: "process-lost-taps",
}));
// Closed: a Meta function the comment path starts to use without a mock here
// fails the suite instead of calling Instagram.
vi.mock("@/lib/meta/client", () => {
  class MetaApiError extends Error {
    code: number;
    subcode: number | undefined;
    constructor(
      code: number,
      subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.subcode = subcode;
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
    sendCommentReply: mockSendCommentReply,
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

import { createDMWorker } from "../lib/queue/dm-worker";
import { MetaApiError } from "../lib/meta/client";
import { CATCH_UP_SPACING_MS } from "../lib/instagram/catch-up-state";
import { CATCH_UP_BRAKE_WAIT_MS } from "../lib/instagram/connection-catch-up";
import { noteMetaUsage, resetLatestMetaUsage } from "../lib/meta/usage";
import { PAUSE_JITTER_MS } from "../lib/queue/account-pause";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `catch_up_sends_${randomBytes(4).toString("hex")}`;
const NOW = new Date("2026-11-25T21:00:00.000Z").getTime();
const MINUTE = 60_000;
const ACCOUNT = "ig_catch";
const PAUSE_KEY = `meta:pause:${ACCOUNT}`;
const PACE_KEY = `pace:recovery:${ACCOUNT}`;
let sql: Client;

function job(id: string, data: Record<string, unknown>) {
  return {
    name: "process-comment",
    id,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    data: {
      instagramAccountId: ACCOUNT,
      accountConnectionId: "account",
      commenterName: "anna",
      mediaId: "media_1",
      ...data,
    },
  };
}

function recoverJob(commentId: string, extra: Record<string, unknown> = {}) {
  return job(`recover_${ACCOUNT}_${commentId}`, {
    commentId,
    commentText: "GUIDE",
    commenterId: `person_${commentId}`,
    source: "RECOVERY",
    ...extra,
  });
}

function webhookJob(commentId: string) {
  return job(`comment_${ACCOUNT}_${commentId}`, {
    commentId,
    commentText: "GUIDE",
    commenterId: `person_${commentId}`,
    source: "WEBHOOK",
  });
}

function row(commentId: string) {
  return state.db.dmLog.findUnique({
    where: { automationId_commentId: { automationId: "c_guide", commentId } },
  });
}

/** Queued copies whose id contains `marker`, with when they run (epoch ms). */
function copies(marker: string, queuedAt: (index: number) => number = () => Date.now()) {
  return mockQueueAdd.mock.calls
    .filter(([, , options]) => String(options?.jobId).includes(marker))
    .map(([, data, options], index) => ({
      jobId: String(options.jobId),
      data: data as Record<string, unknown>,
      runAt: queuedAt(index) + Number(options.delay ?? 0),
    }));
}

function setAccount(data: Record<string, unknown>) {
  return state.db.instagramAccount.update({ where: { id: "account" }, data });
}

describe.skipIf(!databaseUrl)("the catch-up's DMs on Postgres", () => {
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
    // backend session, where two statements at once garble each other.
    state.db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl, max: 1 }, { schema }),
    });
    await state.db.user.create({ data: { id: "user", email: "catch@example.test" } });
    await state.db.workspace.create({ data: { id: "workspace", name: "Catch", ownerId: "user" } });
    await state.db.instagramAccount.create({
      data: {
        id: "account",
        workspaceId: "workspace",
        instagramId: ACCOUNT,
        username: "studio",
        accessToken: "local-test-only",
      },
    });
    await state.db.automation.create({
      data: {
        id: "c_guide",
        workspaceId: "workspace",
        instagramAccountId: "account",
        name: "Guide",
        matchAnyPost: true,
        keywords: ["GUIDE"],
        dmMessage: "Hier ist dein Guide",
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

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    state.redis = new FakeRedis();
    resetLatestMetaUsage();
    await setAccount({ connectionLostAt: null, connectionCheckFailedAt: null });
    mockQueueAdd.mockReset().mockResolvedValue({});
    mockSendPrivateReply.mockReset().mockResolvedValue({ recipient_id: "p", message_id: "m" });
    mockSendCommentReply.mockReset().mockResolvedValue({ id: "reply" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const run = (value: unknown) => state.processor!(value);

  describe("an R1 pause in the middle of the catch-up", () => {
    it("lines the held jobs up behind the catch-up's own, one every 2.5 minutes, not in a burst", async () => {
      // A 20-minute pause; the catch-up planned 12 jobs, one every 150 s
      // from now: the last at NOW + 11 * 150 s.
      const resumeAt = NOW + 20 * MINUTE;
      const redis = state.redis as FakeRedis;
      await redis.set(PAUSE_KEY, String(resumeAt), "PX", 20 * MINUTE);
      await redis.set(PACE_KEY, String(NOW + 11 * CATCH_UP_SPACING_MS), "PX", 60 * MINUTE);

      // The first eight run while the pause lasts, each at its planned time.
      const queuedAt: number[] = [];
      for (let i = 0; i < 8; i++) {
        vi.setSystemTime(NOW + i * CATCH_UP_SPACING_MS);
        queuedAt.push(Date.now());
        await run(recoverJob(`p${i}`));
      }
      expect(mockSendPrivateReply).not.toHaveBeenCalled();

      const held = copies("_pause_", (index) => queuedAt[index]);
      expect(held.map((copy) => copy.jobId)).toEqual(
        Array.from({ length: 8 }, (_, i) => `comment_${ACCOUNT}_p${i}_pause_1`)
      );
      // After the pause and after the planned jobs, one slot each.
      const times = held.map((copy) => copy.runAt);
      expect(Math.min(...times)).toBeGreaterThan(NOW + 11 * CATCH_UP_SPACING_MS);
      for (let i = 1; i < times.length; i++) {
        expect(times[i] - times[i - 1]).toBe(CATCH_UP_SPACING_MS);
      }
      // The pace holds the last one, which the sweep waits for.
      expect(Number(await redis.get(PACE_KEY))).toBe(times.at(-1));
      // Each row waits with its next try, no attempt used.
      for (let i = 0; i < 8; i++) {
        expect(await row(`p${i}`)).toMatchObject({
          status: "PENDING",
          attempts: 0,
          errorMessage: expect.stringMatching(/^Instagram request limit; next try at/),
        });
      }
    });

    it("leaves a webhook job's copy in the minute after the pause, not behind the catch-up", async () => {
      const resumeAt = NOW + 20 * MINUTE;
      const redis = state.redis as FakeRedis;
      await redis.set(PAUSE_KEY, String(resumeAt), "PX", 20 * MINUTE);
      await redis.set(PACE_KEY, String(NOW + 5 * 60 * MINUTE), "PX", 6 * 60 * MINUTE);

      await run(webhookJob("w1"));
      const [copy] = copies("_pause_");
      expect(copy.runAt).toBeGreaterThanOrEqual(resumeAt);
      expect(copy.runAt).toBeLessThan(resumeAt + PAUSE_JITTER_MS);
    });
  });

  describe("a new incident while its jobs wait", () => {
    it("sends nothing while the connection is lost, and uses no attempt, through every retry", async () => {
      await setAccount({ connectionLostAt: new Date(NOW - 60 * MINUTE) });
      for (let attempt = 0; attempt < 3; attempt++) {
        await run({ ...recoverJob("lost1"), attemptsMade: attempt });
      }
      expect(mockSendPrivateReply).not.toHaveBeenCalled();
      expect(mockSendCommentReply).not.toHaveBeenCalled();
      expect(await row("lost1")).toMatchObject({
        status: "PENDING",
        attempts: 0,
        dmDeliveryUnconfirmed: false,
        errorMessage: expect.stringContaining("the Instagram connection is lost"),
      });

      // Reconnected: the next job for the comment sends it.
      await setAccount({ connectionLostAt: null });
      await run(recoverJob("lost1"));
      expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
      expect(await row("lost1")).toMatchObject({ status: "SENT", attempts: 1 });
    });

    it("gives the claim back without counting it when Meta refuses the account during the first strike", async () => {
      await setAccount({ connectionCheckFailedAt: new Date(NOW - 10 * MINUTE) });
      mockSendPrivateReply.mockRejectedValue(
        new MetaApiError(100, 33, "trace", "Object with ID 'ig_catch' does not exist, cannot be loaded due to missing permissions")
      );
      await run(recoverJob("strike1"));
      await run(recoverJob("strike1"));
      expect(mockSendPrivateReply).toHaveBeenCalledTimes(2);
      expect(await row("strike1")).toMatchObject({
        status: "PENDING",
        attempts: 0,
        dmDeliveryUnconfirmed: false,
        errorMessage: expect.stringContaining("Instagram refused the account (missing (Meta 100/33))"),
      });
    });

    it("still counts a refusal of the comment, and one without a strike", async () => {
      // Not the account's: "invalid for a private reply" (100 without 33).
      await setAccount({ connectionCheckFailedAt: new Date(NOW - 10 * MINUTE) });
      mockSendPrivateReply.mockRejectedValueOnce(
        new MetaApiError(100, 2534022, "trace", "The comment is invalid for a private reply")
      );
      await expect(run(recoverJob("strike2"))).rejects.toThrow("invalid for a private reply");
      expect(await row("strike2")).toMatchObject({ status: "FAILED", attempts: 1 });

      // The account's, but the check never saw it refused.
      await setAccount({ connectionCheckFailedAt: null });
      mockSendPrivateReply.mockRejectedValueOnce(
        new MetaApiError(100, 33, "trace", "Object does not exist")
      );
      await expect(run(recoverJob("strike3"))).rejects.toThrow("Object does not exist");
      expect(await row("strike3")).toMatchObject({ status: "FAILED", attempts: 1 });
    });

    it("never gives back a claim whose DM may have gone out, strike or not", async () => {
      await setAccount({ connectionCheckFailedAt: new Date(NOW - 10 * MINUTE) });
      // Meta's code 1 after a send that may have reached the inbox.
      mockSendPrivateReply.mockRejectedValueOnce(
        new MetaApiError(1, undefined, "trace", "An unknown error occurred")
      );
      await expect(run(recoverJob("maybe1"))).rejects.toThrow();
      expect(await row("maybe1")).toMatchObject({
        status: "FAILED",
        attempts: 1,
        dmDeliveryUnconfirmed: true,
      });
      await run(recoverJob("maybe1"));
      expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    });
  });

  describe("Meta's usage close to a limit", () => {
    const report = (percent: number) =>
      noteMetaUsage(
        { get: (name: string) => (name === "x-app-usage" ? JSON.stringify({ call_count: percent }) : null) },
        ACCOUNT
      );

    it("lets a catch-up DM wait, unclaimed, behind the catch-up's pace", async () => {
      report(72);
      await run(recoverJob("u1"));

      expect(mockSendPrivateReply).not.toHaveBeenCalled();
      const [wait] = copies("_wait_");
      expect(wait.jobId).toBe(`recover_${ACCOUNT}_u1_wait_1`);
      expect(wait.data).toMatchObject({ source: "RECOVERY", usageWait: 1 });
      expect(wait.runAt).toBeGreaterThanOrEqual(NOW + CATCH_UP_BRAKE_WAIT_MS);
      expect(await row("u1")).toMatchObject({
        status: "PENDING",
        attempts: 0,
        dmDeliveryUnconfirmed: false,
        errorMessage: expect.stringContaining("Meta reports 72 % of a request limit"),
      });

      // A comment of the webhook at the same moment is not the catch-up's:
      // it goes out.
      await run(webhookJob("u2"));
      expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    });

    it("sends once the report is old, and after four waits whatever it says", async () => {
      report(90);
      vi.setSystemTime(NOW + 6 * MINUTE);
      await run(recoverJob("u3"));
      expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);

      report(90);
      await run(recoverJob("u4", { usageWait: 4 }));
      expect(mockSendPrivateReply).toHaveBeenCalledTimes(2);
      expect(copies("_wait_")).toHaveLength(0);
    });
  });
});
