/**
 * Button taps, DM replies and offer messages that Meta refuses for a request
 * limit, against a real Postgres (R1).
 *
 * What keeps them from going out twice lives where no mock evaluates it: the
 * claim each message takes before it is sent (PostbackDelivery's unique id),
 * given back by a refusal, and the DmLog rows that say what went out. So the
 * jobs run here on the real tables, through the worker's own dispatch.
 * Instagram, Redis (the account pause), the queue and the usage counter are
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
const { mockQueueAdd, mockSendDirectMessage, mockSendDirectMessageWithButton } =
  vi.hoisted(() => ({
    mockQueueAdd: vi.fn(),
    mockSendDirectMessage: vi.fn(),
    mockSendDirectMessageWithButton: vi.fn(),
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
}));
// Closed: a Meta function these paths start to use without a mock here fails
// the suite instead of calling Instagram.
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
    sendDirectMessage: mockSendDirectMessage,
    sendDirectMessageWithButton: mockSendDirectMessageWithButton,
    getUserUsername: async () => null,
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

import { RateLimitError } from "../lib/meta/client";
import { createDMWorker } from "../lib/queue/dm-worker";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `conversation_pause_${randomBytes(4).toString("hex")}`;
const NOW = new Date("2026-11-21T13:00:00.000Z").getTime();
const MINUTE = 60_000;
let sql: Client;

// Meta's answer to a send while the app is over its limit, as seen live.
const LIMIT = () =>
  new (RateLimitError as unknown as new (message: string, code: number) => Error)(
    "(#4) Application request limit reached (/v25.0/ig_conv/messages) [code=4 sub=- type=OAuthException trace=t]",
    4
  );
const SENT = { recipient_id: "person", message_id: "m" };

const ACCOUNT = { instagramAccountId: "ig_conv", accountConnectionId: "account" };

function tapJob(userId: string, mid: string, extra: Record<string, unknown> = {}, id?: string) {
  return {
    name: "process-postback",
    id: id ?? `postback_ig_conv_${userId}_${mid}`,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    data: { ...ACCOUNT, userId, payload: "reveal:automation", mid, ...extra },
  };
}

function messageJob(senderId: string, mid: string, id?: string) {
  return {
    name: "process-message",
    id: id ?? `message_ig_conv_${mid}`,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    data: { ...ACCOUNT, messageId: mid, messageText: "LINK please", senderId },
  };
}

function offerJob(contactOfferId: string, extra: Record<string, unknown> = {}, id?: string) {
  return {
    name: "process-offer",
    id: id ?? `offer_${contactOfferId}_offer_0`,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    data: {
      ...ACCOUNT,
      workspaceId: "workspace",
      phase: "offer",
      contactOfferId,
      step: 0,
      ...extra,
    },
  };
}

// The copies queued for the pause, as BullMQ would hold them, and the job it
// runs for one, at its time.
function pauseCopies() {
  return mockQueueAdd.mock.calls
    .filter(([, , opts]) => String(opts?.jobId).includes("_pause_"))
    .map(([name, data, opts]) => ({ name, data, opts }));
}

function asJob(copy: ReturnType<typeof pauseCopies>[number]) {
  return {
    name: copy.name,
    id: copy.opts.jobId,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: NOW,
    data: copy.data,
  };
}

function dmLogRow(commentId: string) {
  return state.db.dmLog.findUnique({
    where: { automationId_commentId: { automationId: "automation", commentId } },
  });
}

async function offerRow(igsid: string) {
  const contact = await state.db.contact.create({
    data: {
      workspaceId: "workspace",
      instagramAccountId: "account",
      igsid,
      username: igsid,
      recipientHash: `hash_${igsid}`,
      lastInteractionAt: new Date(NOW - 2 * MINUTE),
    },
  });
  const row = await state.db.contactOffer.create({
    data: {
      workspaceId: "workspace",
      contactId: contact.id,
      offerId: "offer",
      startKey: `automation:tap:${igsid}`,
    },
  });
  return row.id;
}

describe.skipIf(!databaseUrl)("taps, DM replies and offer messages and Meta's request limits on Postgres", () => {
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
    await state.db.user.create({ data: { id: "user", email: "conversation-pause@example.test" } });
    await state.db.workspace.create({
      data: { id: "workspace", name: "Pause", ownerId: "user" },
    });
    await state.db.instagramAccount.create({
      data: {
        id: "account",
        workspaceId: "workspace",
        instagramId: "ig_conv",
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
        keywords: ["LINK"],
        dmMessage: "Here is your guide",
        dmTriggerEnabled: true,
      },
    });
    await state.db.offer.create({
      data: {
        id: "offer",
        workspaceId: "workspace",
        name: "Guide",
        offerMessages: ["Soll ich ihn dir schicken?"],
        offerDelaysSeconds: [5],
        offerButtonLabel: "Ja, gerne!",
        confirmationMessages: ["Alles klar!"],
        confirmationDelaysSeconds: [3],
        cardTitle: "Prompting Guide",
        cardButtonLabel: "Jetzt holen",
        destinationUrl: "https://example.test/guide",
        linkSlug: "slug_conversation_pause",
        reminderEnabled: false,
        tagOffered: "Guide angeboten",
        tagInterested: "Guide Interesse",
        tagSent: "Guide gesendet",
        tagClicked: "Guide geklickt",
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
    // Each test counts the claims its own messages took.
    await state.db.postbackDelivery.deleteMany();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    state.redis = new FakeRedis();
    mockQueueAdd.mockReset().mockResolvedValue({});
    mockSendDirectMessage.mockReset().mockResolvedValue(SENT);
    mockSendDirectMessageWithButton.mockReset().mockResolvedValue(SENT);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const run = (job: unknown) => state.processor!(job);

  it("gives a refused tap its claim back and sends its link once, whichever job runs first", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(LIMIT());

    await expect(run(tapJob("person_tap", "mid_tap"))).resolves.toBeUndefined();

    // Nothing holds the tap's claim, and its row says when it is tried next.
    expect(await state.db.postbackDelivery.count()).toBe(0);
    expect(await dmLogRow("reveal:person_tap")).toMatchObject({
      status: "PENDING",
      errorMessage: expect.stringMatching(/^Instagram request limit; next try at 13:2\d UTC$/),
    });
    const [copy] = pauseCopies();
    expect(copy.opts.jobId).toMatch(/^postback_[0-9a-f]{64}_pause_1$/);
    expect(
      await state.db.operationalEvent.count({
        where: { level: "WARNING", message: { startsWith: "Instagram request limit reached" } },
      })
    ).toBe(1);

    // After the pause: the copy, the redelivered tap and a retry of the
    // first job all run.
    vi.setSystemTime(NOW + copy.opts.delay);
    const outcomes = await Promise.allSettled([
      run(asJob(copy)),
      run(tapJob("person_tap", "mid_tap", {}, "postback_redelivered")),
      run({ ...tapJob("person_tap", "mid_tap"), attemptsMade: 1 }),
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    // The refused try and one send.
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    expect(await state.db.postbackDelivery.count()).toBe(1);
    expect(await dmLogRow("reveal:person_tap")).toMatchObject({
      status: "SENT",
      errorMessage: null,
    });
  });

  it("sends no read fallback while a tap's link waits for the pause", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(LIMIT());
    await run(tapJob("person_waiting", "mid_waiting"));
    expect((await dmLogRow("reveal:person_waiting"))?.status).toBe("PENDING");

    // The pause is over, and the fallback runs before the tap's copy.
    vi.setSystemTime(NOW + 25 * MINUTE);
    await run(tapJob("person_waiting", "unused", { fallback: true, mid: undefined }, "read_fallback_1"));

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("gives a refused DM reply its claim back and answers the DM once", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(LIMIT());

    await expect(run(messageJob("person_dm", "mid_dm"))).resolves.toBeUndefined();

    expect(await state.db.postbackDelivery.count()).toBe(0);
    expect(await dmLogRow("dm:mid_dm")).toMatchObject({
      status: "PENDING",
      errorMessage: expect.stringMatching(/^Instagram request limit; next try at/),
    });
    const [copy] = pauseCopies();
    expect(copy.opts.jobId).toBe(
      `message_ig_conv_${Buffer.from("mid_dm").toString("base64url")}_pause_1`
    );

    vi.setSystemTime(NOW + copy.opts.delay);
    await Promise.all([
      run(asJob(copy)),
      run(messageJob("person_dm", "mid_dm", "message_redelivered")),
    ]);

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    expect(await dmLogRow("dm:mid_dm")).toMatchObject({ status: "SENT" });
  });

  it("gives a refused offer message its claim back and sends it once", async () => {
    const id = await offerRow("person_offer");
    mockSendDirectMessageWithButton.mockRejectedValueOnce(LIMIT());

    await expect(run(offerJob(id))).resolves.toBeUndefined();

    expect(await state.db.postbackDelivery.count()).toBe(0);
    const waiting = await state.db.contactOffer.findUniqueOrThrow({ where: { id } });
    expect(waiting).toMatchObject({ stoppedAt: null, stopReason: null, pitchSentAt: null });
    const [copy] = pauseCopies();
    expect(copy.opts.jobId).toBe(`offer_${id}_offer_0_pause_1`);

    // The copy and a retry of the same step race after the pause.
    vi.setSystemTime(NOW + copy.opts.delay);
    await Promise.all([run(asJob(copy)), run({ ...offerJob(id), attemptsMade: 1 })]);

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(2);
    expect(await state.db.postbackDelivery.count()).toBe(1);
    const sent = await state.db.contactOffer.findUniqueOrThrow({ where: { id } });
    expect(sent.pitchSentAt).not.toBeNull();
    expect(sent.stoppedAt).toBeNull();
  });

  it("stops an offer with RATE_LIMITED only after its twelfth wait", async () => {
    const id = await offerRow("person_capped");
    mockSendDirectMessageWithButton.mockRejectedValueOnce(LIMIT());

    await run(offerJob(id, { pauseRequeue: 12 }));

    expect(pauseCopies()).toHaveLength(0);
    expect(await state.db.contactOffer.findUniqueOrThrow({ where: { id } })).toMatchObject({
      stopReason: "RATE_LIMITED",
    });
    // Nothing was sent: its claim is free again.
    expect(await state.db.postbackDelivery.count()).toBe(0);
  });
});
