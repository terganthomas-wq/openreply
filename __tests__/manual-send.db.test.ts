/**
 * A manual send from the Kommentare page (M1) in the worker, against a real
 * Postgres: the job names its campaign (forceAutomationId), and every claim
 * of a comment's DM holds as for a webhook or a sweep job.
 *
 * What keeps a comment at one private reply lives in where clauses no mock
 * evaluates: the claim on the campaign's DmLog row, taken in one transaction
 * with the check of the other campaigns' rows, under a lock on the comment.
 * So the jobs run here on the real tables, several at once: a manual send,
 * the webhook's, the sweep's and the catch-up's jobs. Instagram, Redis (the
 * account pause), the queue, the usage counter and the hourly limiter are
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
const {
  mockQueueAdd,
  mockSendPrivateReply,
  mockSendPrivateReplyWithButton,
  mockSendCommentReply,
  mockGetUserFollowStatus,
  mockSendDirectMessage,
} = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockSendPrivateReply: vi.fn(),
  mockSendPrivateReplyWithButton: vi.fn(),
  mockSendCommentReply: vi.fn(),
  mockGetUserFollowStatus: vi.fn(),
  mockSendDirectMessage: vi.fn(),
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
    sendPrivateReplyWithButton: mockSendPrivateReplyWithButton,
    sendCommentReply: mockSendCommentReply,
    // The follow gate and the link a tap brings.
    getUserFollowStatus: mockGetUserFollowStatus,
    sendDirectMessage: mockSendDirectMessage,
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

// What the catch-up after a lost connection queues (connection-catch-up.ts).
function recoverJob(commentId: string, commentText: string) {
  return job(`recover_${ACCOUNT}_${commentId}`, {
    commentId,
    commentText,
    commenterId: `person_${commentId}`,
    source: "RECOVERY",
  });
}

/**
 * The copies a comment job queued to look again while another campaign's DM
 * was on its way (<job base>_dedup_<n>), run as BullMQ would run them, until
 * none is left. Returns how many ran.
 */
async function runRecheckCopies(run: (value: unknown) => Promise<void>): Promise<number> {
  let ran = 0;
  for (let round = 0; round < 10; round++) {
    const copies = mockQueueAdd.mock.calls.filter(([, , options]) =>
      String(options?.jobId).includes("_dedup_")
    );
    mockQueueAdd.mockClear();
    if (copies.length === 0) return ran;
    for (const [name, data, options] of copies) {
      await run({ name, id: options.jobId, attemptsMade: 0, opts: { attempts: 3 }, timestamp: Date.now(), data });
      ran += 1;
    }
  }
  throw new Error("the re-check copies never ended");
}

/** A send that waits until the test lets it go on. */
function heldSend() {
  let release!: (value: unknown) => void;
  let refuse!: (error: unknown) => void;
  const sent = new Promise((resolve, reject) => {
    release = resolve;
    refuse = reject;
  });
  return {
    impl: () => sent,
    release: () => release({ recipient_id: "p", message_id: "m" }),
    refuse: (error: unknown) => refuse(error),
  };
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
    mockSendPrivateReplyWithButton.mockReset().mockImplementation(slowSend);
    mockSendCommentReply.mockReset().mockResolvedValue({ id: "reply" });
    mockGetUserFollowStatus.mockReset().mockResolvedValue(false);
    mockSendDirectMessage.mockReset().mockResolvedValue({ recipient_id: "p", message_id: "m" });
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
      const sent = await row("c_guide", commentId);
      expect(sent).toMatchObject({ status: "SENT", attempts: 1 });
      // Its one public reply, by whichever job sent the DM: none when the
      // manual send won, whose owner switched it off.
      expect(mockSendCommentReply.mock.calls.length).toBe(
        sent?.matchedKeyword === "(manuell)" ? 0 : 1
      );
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
      // A campaign that found the other's DM on its way looks again shortly.
      await runRecheckCopies(run);

      // Exactly one DM: nobody stood back for good while the other was only
      // on its way.
      expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
      const rows = await state.db.dmLog.findMany({ where: { commentId } });
      expect(rows.filter((r) => r.status === "SENT")).toHaveLength(1);
      // None is left claimed, and the campaign that stood back used no attempt.
      expect(rows.filter((r) => r.dmDeliveryUnconfirmed)).toHaveLength(0);
      for (const r of rows.filter((r) => r.status !== "SENT")) {
        expect(r).toMatchObject({ status: "SKIPPED_DEDUP", attempts: 0 });
        expect(r.errorMessage).toContain("already sent the one private reply");
      }
    });
  }

  it("posts no public reply for the manual send while a catch-up job runs next to its DM (public reply off)", async () => {
    const send = heldSend();
    mockSendPrivateReply.mockImplementationOnce(send.impl);
    const manual = run(manualJob("po1", "c_guide", { commentText: "GUIDE" }));
    await vi.waitFor(() => expect(mockSendPrivateReply).toHaveBeenCalledTimes(1));

    // The catch-up's job for the same comment and campaign, while the
    // manual DM is on its way: the claim it finds already closed the public
    // reply, and a claim on its way is not a DM that went out.
    await run(recoverJob("po1", "GUIDE"));
    expect(mockSendCommentReply).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);

    send.release();
    await manual;
    expect(await row("c_guide", "po1")).toMatchObject({
      status: "SENT",
      matchedKeyword: "(manuell)",
      publicReplySentAt: null,
      publicReplyDeliveryUnconfirmed: true,
    });
    // Later jobs post nothing either.
    await run(webhookJob("po1", "GUIDE"));
    expect(mockSendCommentReply).not.toHaveBeenCalled();
  });

  it("leaves no public reply behind when that manual DM is then refused", async () => {
    const send = heldSend();
    mockSendPrivateReply.mockImplementationOnce(send.impl);
    const manual = run(manualJob("po2", "c_guide", { commentText: "GUIDE" }));
    await vi.waitFor(() => expect(mockSendPrivateReply).toHaveBeenCalledTimes(1));
    await run(recoverJob("po2", "GUIDE"));

    send.refuse(new MetaApiError(10, undefined, "trace", "(#10) refused"));
    await expect(manual).rejects.toThrow("refused");
    expect(await row("c_guide", "po2")).toMatchObject({
      status: "FAILED",
      dmDeliveryUnconfirmed: false,
      attempts: 1,
    });
    // No "Schau in deine DMs" under a comment that got no DM.
    expect(mockSendCommentReply).not.toHaveBeenCalled();

    // The owner tries again with the public reply on: it goes out now.
    await run(manualJob("po2", "c_guide", { commentText: "GUIDE", publicReplyOverride: true }));
    expect(await row("c_guide", "po2")).toMatchObject({
      status: "SENT",
      attempts: 2,
      publicReplySentAt: expect.any(Date),
    });
    expect(mockSendCommentReply).toHaveBeenCalledTimes(1);
  });

  it("sends one private reply when a catch-up job and a sweep job meet a comment two campaigns match", async () => {
    // Two active campaigns for the same word: one bound to the post, one for
    // any post (the worker answers with the bound one first).
    await state.db.automation.createMany({
      data: [
        {
          id: "c_two_bound",
          workspaceId: "workspace",
          instagramAccountId: "account",
          name: "Zwei (Reel)",
          postId: "media_1",
          keywords: ["ZWEI"],
          dmMessage: "Hier ist dein Reel-Guide",
          publicReplyEnabled: true,
          publicReplyMessages: ["Reel: schau in deine DMs"],
          createdAt: new Date(NOW - 500),
        },
        {
          id: "c_two_any",
          workspaceId: "workspace",
          instagramAccountId: "account",
          name: "Zwei (alle)",
          matchAnyPost: true,
          keywords: ["ZWEI"],
          dmMessage: "Hier ist dein Guide (alle)",
          publicReplyEnabled: true,
          publicReplyMessages: ["Alle: schau in deine DMs"],
          createdAt: new Date(NOW - 400),
        },
      ],
    });
    const send = heldSend();
    mockSendPrivateReply.mockImplementationOnce(send.impl);
    const recover = run(recoverJob("two1", "ZWEI"));
    await vi.waitFor(() => expect(mockSendPrivateReply).toHaveBeenCalledTimes(1));

    // The sweep's job while the catch-up's DM for the bound campaign is on
    // its way: no second private reply, and no public reply ahead of the DM.
    await run(sweepJob("two1", "ZWEI"));
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockSendCommentReply).not.toHaveBeenCalled();
    expect(await row("c_two_any", "two1")).toMatchObject({ status: "PENDING", attempts: 0 });

    send.release();
    await recover;
    await runRecheckCopies(run);

    expect(mockSendPrivateReply.mock.calls.map((call) => call[3])).toEqual([
      "Hier ist dein Reel-Guide",
    ]);
    expect(mockSendCommentReply.mock.calls.map((call) => call[2])).toEqual([
      "Reel: schau in deine DMs",
    ]);
    expect(await row("c_two_bound", "two1")).toMatchObject({ status: "SENT", attempts: 1 });
    expect(await row("c_two_any", "two1")).toMatchObject({
      status: "SKIPPED_DEDUP",
      attempts: 0,
      errorMessage: expect.stringContaining("Another campaign (Zwei (Reel)) already sent"),
    });
  });

  it("never lets a manual send and a catch-up job for two campaigns both stand back", async () => {
    // Both claim at the same moment: one gets the comment, the other waits.
    const outcomes = await Promise.allSettled([
      run(manualJob("both1", "c_link", { commentText: "GUIDE" })),
      run(recoverJob("both1", "GUIDE")),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
    await runRecheckCopies(run);

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    const rows = await state.db.dmLog.findMany({ where: { commentId: "both1" } });
    expect(rows.filter((r) => r.status === "SENT")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "SKIPPED_DEDUP")).toHaveLength(1);
    expect(rows.every((r) => !r.dmDeliveryUnconfirmed)).toBe(true);
  });

  it("sends with the other campaign once the DM it waited for was refused", async () => {
    // The catch-up's DM for c_guide is on its way and then refused; the
    // manual send with c_link waited for it and sends after all.
    const send = heldSend();
    mockSendPrivateReply.mockImplementationOnce(send.impl);
    const recover = run(recoverJob("both2", "GUIDE"));
    await vi.waitFor(() => expect(mockSendPrivateReply).toHaveBeenCalledTimes(1));
    await run(manualJob("both2", "c_link", { commentText: "GUIDE" }));
    expect(await row("c_link", "both2")).toMatchObject({
      status: "PENDING",
      attempts: 0,
      errorMessage: expect.stringContaining("Waiting: another campaign (Guide) is sending"),
    });

    send.refuse(new MetaApiError(10, undefined, "trace", "(#10) refused"));
    await expect(recover).rejects.toThrow("refused");
    await runRecheckCopies(run);

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(2);
    expect(mockSendPrivateReply.mock.calls[1][3]).toBe("Hier ist dein Link");
    expect(await row("c_link", "both2")).toMatchObject({
      status: "SENT",
      attempts: 1,
      matchedKeyword: "(manuell)",
    });
  });

  it("waits while another campaign's DM is on its way, and stands back once it went out", async () => {
    await seedRow("c_link", "m4", { status: "PENDING", dmDeliveryUnconfirmed: true, attempts: 1 });

    await run(manualJob("m4", "c_guide"));

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(await row("c_guide", "m4")).toMatchObject({
      status: "PENDING",
      attempts: 0,
      errorMessage: expect.stringContaining("Waiting: another campaign (Link) is sending"),
    });
    // That DM went out meanwhile: the copy stands back for good.
    await state.db.dmLog.update({
      where: { automationId_commentId: { automationId: "c_link", commentId: "m4" } },
      data: { status: "SENT", dmDeliveryUnconfirmed: false },
    });
    expect(await runRecheckCopies(run)).toBe(1);
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(await row("c_guide", "m4")).toMatchObject({
      status: "SKIPPED_DEDUP",
      attempts: 0,
      matchedKeyword: "(manuell)",
      errorMessage: expect.stringContaining("Another campaign (Link) already sent"),
    });
  });

  it("stands back for good for a claim older than a send takes", async () => {
    // A worker died with its claim twenty minutes ago: its DM may have gone out.
    vi.setSystemTime(NOW - 20 * 60_000);
    await seedRow("c_link", "m4b", { status: "PENDING", dmDeliveryUnconfirmed: true, attempts: 1 });
    vi.setSystemTime(NOW);

    await run(manualJob("m4b", "c_guide"));
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(await row("c_guide", "m4b")).toMatchObject({
      status: "SKIPPED_DEDUP",
      errorMessage: expect.stringContaining("Another campaign (Link) is sending, or may have sent"),
    });
  });

  it("lets an automatic job wait for a manual send on its way", async () => {
    await seedRow("c_guide", "m5", {
      status: "PENDING",
      dmDeliveryUnconfirmed: true,
      attempts: 1,
      matchedKeyword: "(manuell)",
    });

    await run(webhookJob("m5", "LINK"));

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    // Nothing claimed, no attempt used: the comment waits for the manual send.
    expect(await row("c_link", "m5")).toMatchObject({
      status: "PENDING",
      attempts: 0,
      dmDeliveryUnconfirmed: false,
      errorMessage: expect.stringContaining("Waiting: another campaign (Guide) is sending"),
    });
    // The manual send's own claim is untouched.
    expect(await row("c_guide", "m5")).toMatchObject({ status: "PENDING", dmDeliveryUnconfirmed: true });

    await state.db.dmLog.update({
      where: { automationId_commentId: { automationId: "c_guide", commentId: "m5" } },
      data: { status: "SENT", dmDeliveryUnconfirmed: false },
    });
    await runRecheckCopies(run);
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(await row("c_link", "m5")).toMatchObject({
      status: "SKIPPED_DEDUP",
      attempts: 0,
      errorMessage: expect.stringContaining("Another campaign (Guide) already sent"),
    });
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

  it("lets the tap on a paused follow-gate campaign sent by hand bring the link", async () => {
    await state.db.automation.create({
      data: {
        id: "c_gate",
        workspaceId: "workspace",
        instagramAccountId: "account",
        name: "Gate (pausiert)",
        isActive: false,
        matchAnyPost: true,
        keywords: ["GATE"],
        requireFollow: true,
        dmMessage: "Hier ist dein Gate-Link",
        followPromptMessage: "Folg mir kurz, dann kommt der Link",
        followPromptButtonLabel: "Ich folge",
        createdAt: new Date(NOW - 100),
      },
    });
    // Someone who does not follow yet: the private reply is the follow request.
    await run(manualJob("g1", "c_gate", { commentText: "gate bitte" }));
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      AUTH,
      ACCOUNT,
      "g1",
      "Folg mir kurz, dann kommt der Link",
      "Ich folge",
      "followcheck:c_gate"
    );
    expect(await row("c_gate", "g1")).toMatchObject({ status: "SENT", matchedKeyword: "(manuell)" });

    // They follow and tap: the paused campaign answers the tap.
    mockGetUserFollowStatus.mockResolvedValue(true);
    const tap = (userId: string, mid: string) =>
      run({
        name: "process-postback",
        id: `postback_${mid}`,
        attemptsMade: 0,
        opts: { attempts: 3 },
        timestamp: Date.now(),
        data: {
          instagramAccountId: ACCOUNT,
          accountConnectionId: "account",
          userId,
          payload: "followcheck:c_gate",
          mid,
        },
      });
    await tap("person_g1", "mid_g1");
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      AUTH,
      ACCOUNT,
      "person_g1",
      "Hier ist dein Gate-Link"
    );
    expect(await row("c_gate", "reveal:person_g1")).toMatchObject({ status: "SENT" });

    // Someone the paused campaign was never sent to by hand gets nothing.
    await tap("person_stranger", "mid_stranger");
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(await row("c_gate", "reveal:person_stranger")).toBeNull();
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
