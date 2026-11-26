/**
 * A manual send from the Kommentare page (M1) in the worker, against a real
 * Postgres: the job names its campaign (forceAutomationId), and every claim
 * of a comment's DM holds as for a webhook or a sweep job.
 *
 * What keeps a comment at one private reply lives in where clauses no mock
 * evaluates: the claim on the campaign's DmLog row, and the check of the other
 * campaigns' rows before and after it. So the jobs run here on the real
 * tables, several at once. Instagram, Redis (the account pause), the queue,
 * the usage counter and the hourly limiter are replaced. Skipped without
 * TEST_DATABASE_URL; each run builds its own throwaway schema from
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

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `manual_send_${randomBytes(4).toString("hex")}`;
const NOW = new Date("2026-11-25T18:00:00.000Z").getTime();
let sql: Client;

const ACCOUNT = "ig_manual";
const AUTH = expect.objectContaining({ accessToken: "local-test-only", instagramId: ACCOUNT });

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

// What POST /api/instagram/comments/send queues.
function manualJob(
  commentId: string,
  automationId: string,
  extra: Record<string, unknown> = {}
) {
  return job(`manual_${ACCOUNT}_${commentId}_${automationId}_0`, {
    commentId,
    commentText: "kallt",
    commenterId: `person_${commentId}`,
    source: "MANUAL",
    forceAutomationId: automationId,
    publicReplyOverride: false,
    ...extra,
  });
}

function webhookJob(commentId: string, commentText: string) {
  return job(`comment_${ACCOUNT}_${commentId}`, {
    commentId,
    commentText,
    commenterId: `person_${commentId}`,
    source: "WEBHOOK",
  });
}

function sweepJob(commentId: string, commentText: string) {
  return job(`sweep_${commentId}_${randomBytes(3).toString("hex")}`, {
    commentId,
    commentText,
    commenterId: `person_${commentId}`,
    source: "POLLING",
  });
}

function row(automationId: string, commentId: string) {
  return state.db.dmLog.findUnique({
    where: { automationId_commentId: { automationId, commentId } },
  });
}

async function seedRow(automationId: string, commentId: string, data: Record<string, unknown>) {
  await state.db.dmLog.create({
    data: {
      workspaceId: "workspace",
      instagramAccountId: "account",
      automationId,
      commenterId: `person_${commentId}`,
      commentId,
      commentText: "kallt",
      ...data,
    },
  });
}

// A send that takes a moment, as Instagram's does: the other jobs run while
// it is on its way.
function slowSend() {
  return new Promise((resolve) =>
    setTimeout(() => resolve({ recipient_id: "p", message_id: "m" }), 5)
  );
}

describe.skipIf(!databaseUrl)("manual sends from the Kommentare page on Postgres", () => {
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
    await state.db.user.create({ data: { id: "user", email: "manual@example.test" } });
    await state.db.workspace.create({
      data: { id: "workspace", name: "Manual", ownerId: "user" },
    });
    await state.db.instagramAccount.create({
      data: {
        id: "account",
        workspaceId: "workspace",
        instagramId: ACCOUNT,
        username: "studio",
        accessToken: "local-test-only",
      },
    });
    // Oldest first, as the worker loads them.
    await state.db.automation.create({
      data: {
        id: "c_guide",
        workspaceId: "workspace",
        instagramAccountId: "account",
        name: "Guide",
        postId: "media_1",
        keywords: ["GUIDE"],
        ignoreQuestionComments: true,
        dmMessage: "Hier ist dein Guide",
        publicReplyEnabled: true,
        publicReplyMessages: ["Schau in deine DMs"],
        createdAt: new Date(NOW - 3_000),
      },
    });
    await state.db.automation.create({
      data: {
        id: "c_link",
        workspaceId: "workspace",
        instagramAccountId: "account",
        name: "Link",
        matchAnyPost: true,
        keywords: ["LINK"],
        dmMessage: "Hier ist dein Link",
        createdAt: new Date(NOW - 2_000),
      },
    });
    // Paused, bound to another post, with a keyword nobody writes: only a
    // manual send ever uses it.
    await state.db.automation.create({
      data: {
        id: "c_paused",
        workspaceId: "workspace",
        instagramAccountId: "account",
        name: "Alter Guide",
        isActive: false,
        postId: "media_9",
        keywords: ["XYZ"],
        dmMessage: "Hier ist der alte Guide",
        publicReplyEnabled: false,
        publicReplyMessages: ["Schau in deine Nachrichten"],
        deliveryTag: "Alter Guide erhalten",
        createdAt: new Date(NOW - 1_000),
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
    mockSendPrivateReply.mockReset().mockImplementation(slowSend);
    mockSendCommentReply.mockReset().mockResolvedValue({ id: "reply" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const run = (value: unknown) => state.processor!(value);

  it("sends the chosen campaign for a comment no keyword matches, marked (manuell)", async () => {
    await run(manualJob("m1", "c_guide"));

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockSendPrivateReply).toHaveBeenCalledWith(AUTH, ACCOUNT, "m1", "Hier ist dein Guide");
    expect(await row("c_guide", "m1")).toMatchObject({
      status: "SENT",
      attempts: 1,
      dmDeliveryUnconfirmed: false,
      matchedKeyword: "(manuell)",
      commentText: "kallt",
    });
    // The owner switched the public reply off, although the campaign has one,
    // and it stays off: a later webhook job for the comment posts nothing.
    expect(mockSendCommentReply).not.toHaveBeenCalled();
    expect(await row("c_guide", "m1")).toMatchObject({
      publicReplySentAt: null,
      publicReplyError: "Not posted: the public reply was switched off for this manual send",
    });
    await run(webhookJob("m1", "GUIDE"));
    expect(mockSendCommentReply).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("uses a paused campaign of another post for a question, with the public reply switched on", async () => {
    await run(
      manualJob("m2", "c_paused", {
        commentText: "Bekomm ich den Guide?",
        publicReplyOverride: true,
      })
    );

    expect(mockSendPrivateReply).toHaveBeenCalledWith(AUTH, ACCOUNT, "m2", "Hier ist der alte Guide");
    // The campaign's own setting says no public reply; the owner said yes.
    expect(mockSendCommentReply).toHaveBeenCalledTimes(1);
    expect(mockSendCommentReply).toHaveBeenCalledWith(AUTH, "m2", "Schau in deine Nachrichten");
    expect(await row("c_paused", "m2")).toMatchObject({
      status: "SENT",
      matchedKeyword: "(manuell)",
      publicReplySentAt: expect.any(Date),
    });
    // What follows the link runs as for any comment: the contact and its tag.
    const contact = await state.db.contact.findUniqueOrThrow({
      where: { instagramAccountId_igsid: { instagramAccountId: "account", igsid: "person_m2" } },
      include: { tags: true },
    });
    expect(contact.tags.map((tag) => tag.tag)).toEqual(["Alter Guide erhalten"]);
  });

  it("answers a question the campaign leaves to a human, with the campaign's public reply when the job does not say", async () => {
    // c_guide skips questions on its own; sent by hand, it answers.
    await run(
      manualJob("m3", "c_guide", {
        commentText: "Wo bekomme ich den Guide?",
        publicReplyOverride: undefined,
      })
    );
    expect(mockSendPrivateReply).toHaveBeenCalledWith(AUTH, ACCOUNT, "m3", "Hier ist dein Guide");
    expect(mockSendCommentReply).toHaveBeenCalledWith(AUTH, "m3", "Schau in deine DMs");
  });

  // The same comment through every path at once, in each order: one DM.
  for (const order of [
    ["manual", "webhook", "sweep"],
    ["webhook", "manual", "sweep"],
    ["sweep", "webhook", "manual"],
  ] as const) {
    it(`sends one DM when the webhook and the sweep process the comment too (${order.join(", ")})`, async () => {
      const commentId = `race_same_${order[0]}`;
      const jobs = {
        manual: () => run(manualJob(commentId, "c_guide", { commentText: "GUIDE" })),
        webhook: () => run(webhookJob(commentId, "GUIDE")),
        sweep: () => run(sweepJob(commentId, "GUIDE")),
      };
      const outcomes = await Promise.allSettled(order.map((name) => jobs[name]()));

      expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
      expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
      expect(await row("c_guide", commentId)).toMatchObject({ status: "SENT", attempts: 1 });
      // Its one public reply, by whichever job sent the DM.
      expect(mockSendCommentReply.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it(`sends one DM when the webhook and the sweep answer with another campaign (${order.join(", ")})`, async () => {
      // "LINK" makes the webhook and the sweep answer with c_link, while the
      // owner sends c_guide by hand: two campaigns, one comment.
      const commentId = `race_other_${order[0]}`;
      const jobs = {
        manual: () => run(manualJob(commentId, "c_guide", { commentText: "LINK" })),
        webhook: () => run(webhookJob(commentId, "LINK")),
        sweep: () => run(sweepJob(commentId, "LINK")),
      };
      const outcomes = await Promise.allSettled(order.map((name) => jobs[name]()));

      expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
      expect(mockSendPrivateReply.mock.calls.length).toBeLessThanOrEqual(1);
      const rows = await state.db.dmLog.findMany({ where: { commentId } });
      // At most one row says the DM went out or may have; none is left claimed.
      expect(rows.filter((r) => r.status === "SENT")).toHaveLength(
        mockSendPrivateReply.mock.calls.length
      );
      expect(rows.filter((r) => r.dmDeliveryUnconfirmed)).toHaveLength(0);
      // A campaign that stood back gave its attempt back.
      for (const r of rows.filter((r) => r.status !== "SENT")) {
        expect(r).toMatchObject({ status: "SKIPPED_DEDUP", attempts: 0 });
      }
    });
  }

  it("stands back while another campaign's DM is on its way", async () => {
    await seedRow("c_link", "m4", { status: "PENDING", dmDeliveryUnconfirmed: true, attempts: 1 });

    await run(manualJob("m4", "c_guide"));

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(await row("c_guide", "m4")).toMatchObject({
      status: "SKIPPED_DEDUP",
      attempts: 0,
      matchedKeyword: "(manuell)",
      errorMessage: expect.stringContaining("Another campaign (Link) is sending, or may have sent"),
    });
  });

  it("lets an automatic job stand back for a manual send on its way", async () => {
    await seedRow("c_guide", "m5", {
      status: "PENDING",
      dmDeliveryUnconfirmed: true,
      attempts: 1,
      matchedKeyword: "(manuell)",
    });

    await run(webhookJob("m5", "LINK"));

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    // The claim it took is given back with its attempt, and the comment is
    // left to the manual send for good.
    expect(await row("c_link", "m5")).toMatchObject({
      status: "SKIPPED_DEDUP",
      attempts: 0,
      dmDeliveryUnconfirmed: false,
      errorMessage: expect.stringContaining("sent by hand with another campaign (Guide)"),
    });
    // The manual send's own claim is untouched.
    expect(await row("c_guide", "m5")).toMatchObject({ status: "PENDING", dmDeliveryUnconfirmed: true });
  });

  it("never sends next to a DM that went out or may have", async () => {
    await seedRow("c_link", "m6", { status: "SENT", attempts: 1 });
    await run(manualJob("m6", "c_guide"));
    expect(await row("c_guide", "m6")).toMatchObject({
      status: "SKIPPED_DEDUP",
      errorMessage: expect.stringContaining("Another campaign (Link) already sent"),
    });

    await seedRow("c_guide", "m7", { status: "FAILED", dmDeliveryUnconfirmed: true, attempts: 1 });
    await run(manualJob("m7", "c_guide"));
    await run(manualJob("m7", "c_link"));
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(await row("c_link", "m7")).toMatchObject({ status: "SKIPPED_DEDUP" });
  });

  it("tries again after a refused DM, counting the attempts across jobs", async () => {
    await seedRow("c_guide", "m8", { status: "FAILED", attempts: 1, errorMessage: "MetaApiError 10: refused" });

    await run(manualJob("m8", "c_guide"));
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(await row("c_guide", "m8")).toMatchObject({ status: "SENT", attempts: 2, errorMessage: null });

    // No attempt left: nothing is sent.
    await seedRow("c_link", "m9", { status: "FAILED", attempts: 3 });
    await run(manualJob("m9", "c_link"));
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("waits for the account's pause under a copy of its own", async () => {
    await (state.redis as FakeRedis).set(`meta:pause:${ACCOUNT}`, String(NOW + 20 * 60_000), "PX", 20 * 60_000);

    await run(manualJob("m10", "c_guide", { publicReplyOverride: true }));

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(await row("c_guide", "m10")).toMatchObject({
      status: "PENDING",
      attempts: 0,
      errorMessage: expect.stringMatching(/^Instagram request limit; next try at/),
    });
    const copies = mockQueueAdd.mock.calls.filter(([, , opts]) =>
      String(opts?.jobId).includes("_pause_")
    );
    expect(copies).toHaveLength(1);
    // Never the automatic job's copy id, which BullMQ would take for the same.
    expect(copies[0][2].jobId).toBe(`manual_${ACCOUNT}_m10_c_guide_pause_1`);
    expect(copies[0][1]).toMatchObject({
      forceAutomationId: "c_guide",
      publicReplyOverride: true,
      source: "MANUAL",
      pauseRequeue: 1,
    });
  });

  it("sends nothing for a campaign that was deleted meanwhile, and says so", async () => {
    await run(manualJob("m11", "c_gone"));
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(
      await state.db.operationalEvent.count({
        where: { level: "WARNING", message: { startsWith: "Manual send for comment m11 not sent" } },
      })
    ).toBe(1);
  });
});
