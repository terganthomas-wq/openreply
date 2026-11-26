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
const {
  mockQueueAdd,
  mockSendDirectMessage,
  mockSendDirectMessageWithButton,
  mockGetUserFollowStatus,
} = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockSendDirectMessageWithButton: vi.fn(),
  mockGetUserFollowStatus: vi.fn(),
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
    getUserFollowStatus: mockGetUserFollowStatus,
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
const HOUR = 60 * MINUTE;
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

function messageJob(senderId: string, mid: string, id?: string, text = "LINK please") {
  return {
    name: "process-message",
    id: id ?? `message_ig_conv_${mid}`,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    data: { ...ACCOUNT, messageId: mid, messageText: text, senderId },
  };
}

// The read fallback of a campaign for someone who read its opening DM.
function readFallback(userId: string, automationId: string) {
  return tapJob(
    userId,
    "unused",
    { payload: `reveal:${automationId}`, fallback: true, mid: undefined },
    `read_fallback_${userId}`
  );
}

// The account's pause, set or extended to `until` (epoch ms).
function pauseUntil(until: number) {
  return (state.redis as FakeRedis).set(
    "meta:pause:ig_conv",
    String(until),
    "PX",
    until - Date.now()
  );
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

function dmLogRow(commentId: string, automationId = "automation") {
  return state.db.dmLog.findUnique({
    where: { automationId_commentId: { automationId, commentId } },
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
    // A follow-gated campaign, one that is paused during a test, and one
    // that answers the DM keyword GUIDE. None answers "LINK please".
    await state.db.automation.createMany({
      data: [
        {
          id: "gated",
          workspaceId: "workspace",
          instagramAccountId: "account",
          name: "Gated",
          keywords: ["FOLLOW"],
          dmMessage: "Here is your gated guide",
          requireFollow: true,
        },
        {
          id: "tap_campaign",
          workspaceId: "workspace",
          instagramAccountId: "account",
          name: "Tap",
          keywords: ["TAP"],
          dmMessage: "Here is your tap guide",
        },
        {
          id: "dm_campaign",
          workspaceId: "workspace",
          instagramAccountId: "account",
          name: "DM",
          keywords: ["GUIDE"],
          dmMessage: "Here is your DM guide",
          dmTriggerEnabled: true,
        },
      ],
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
    mockGetUserFollowStatus.mockReset().mockResolvedValue(true);
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

  // A gated tap whose link was refused once waits as PENDING. Its copies keep
  // the follow check's payload, so a pause that goes on meets each of them
  // before the check. Wherever the wait ends, the waiting link ends with it:
  // a row left PENDING would hold the read fallback back for good.
  describe("a gated tap whose link waited", () => {
    const tap = (userId: string, mid: string) =>
      tapJob(userId, mid, { payload: "followcheck:gated" });

    it("moves the next try along, ends FAILED when its copies give up, and the read fallback then delivers", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(LIMIT());
      await run(tap("person_gated", "mid_gated"));
      let row = await dmLogRow("reveal:person_gated", "gated");
      expect(row?.status).toBe("PENDING");

      // An hour more each time a copy is due: every copy meets the pause
      // before its follow check.
      let clock = NOW;
      let copy = pauseCopies().at(-1)!;
      for (let wait = 1; wait < 12; wait++) {
        clock += copy.opts.delay;
        vi.setSystemTime(clock);
        await pauseUntil(clock + HOUR);
        const before = row?.errorMessage;
        await expect(run(asJob(copy))).resolves.toBeUndefined();
        row = await dmLogRow("reveal:person_gated", "gated");
        expect(row?.status).toBe("PENDING");
        expect(row?.errorMessage).toMatch(/^Instagram request limit; next try at \d\d:\d\d UTC$/);
        expect(row?.errorMessage).not.toBe(before);
        copy = pauseCopies().at(-1)!;
        expect(copy.data.pauseRequeue).toBe(wait + 1);
      }

      // The twelfth copy and both of BullMQ's retries still find the pause.
      clock += copy.opts.delay;
      vi.setSystemTime(clock);
      await pauseUntil(clock + HOUR);
      for (const attemptsMade of [0, 1, 2]) {
        await expect(run({ ...asJob(copy), attemptsMade })).rejects.toMatchObject({
          name: "AccountPausedError",
        });
      }
      expect(pauseCopies()).toHaveLength(12);
      expect(await dmLogRow("reveal:person_gated", "gated")).toMatchObject({
        status: "FAILED",
        errorMessage: expect.stringMatching(
          /^Instagram request limit: the account was still paused after 12 waits \(until \d\d:\d\d UTC\), so the DM was not sent$/
        ),
      });
      // Only the first run asked Instagram anything: one check, one refused link.
      expect(mockGetUserFollowStatus).toHaveBeenCalledTimes(1);
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      expect(await state.db.postbackDelivery.count()).toBe(0);

      // Once the pause is over the person reads the opening DM: the read
      // fallback checks the follow and delivers.
      vi.setSystemTime(clock + 2 * HOUR);
      await run(readFallback("person_gated", "gated"));

      expect(mockGetUserFollowStatus).toHaveBeenCalledTimes(2);
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
      expect(await dmLogRow("reveal:person_gated", "gated")).toMatchObject({
        status: "SENT",
        errorMessage: null,
      });
    });

    it("ends FAILED when the twelfth copy's follow check still meets the limit", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(LIMIT());
      await run(tap("person_check", "mid_check"));
      const [first] = pauseCopies();
      const twelfth = {
        ...asJob(first),
        id: first.opts.jobId.replace(/_pause_1$/, "_pause_12"),
        data: { ...first.data, pauseRequeue: 12 },
      };

      vi.setSystemTime(NOW + 5 * HOUR);
      mockGetUserFollowStatus.mockRejectedValueOnce(LIMIT());
      await expect(run(twelfth)).rejects.toMatchObject({ name: "RateLimitError" });

      expect(pauseCopies()).toHaveLength(1);
      expect(await dmLogRow("reveal:person_check", "gated")).toMatchObject({
        status: "FAILED",
        errorMessage: expect.stringMatching(
          /^Instagram request limit: the account was still paused after 12 waits \(until 18:20 UTC\), so the DM was not sent\. RateLimitError 4: \(#4\) Application request limit reached/
        ),
      });
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    });

    it("ends FAILED when the window closes during the pause", async () => {
      // The tap came 23 hours ago; its link was refused just now.
      mockSendDirectMessage.mockRejectedValueOnce(LIMIT());
      await run({ ...tap("person_late", "mid_late"), timestamp: NOW - 23 * HOUR });
      expect((await dmLogRow("reveal:person_late", "gated"))?.status).toBe("PENDING");

      const [copy] = pauseCopies();
      const clock = NOW + copy.opts.delay;
      vi.setSystemTime(clock);
      await pauseUntil(clock + HOUR);
      await expect(run(asJob(copy))).resolves.toBeUndefined();

      // Nothing more is queued: the window is closed by the time it would run.
      expect(pauseCopies()).toHaveLength(1);
      expect(await dmLogRow("reveal:person_late", "gated")).toMatchObject({
        status: "FAILED",
        errorMessage: expect.stringMatching(
          /^Instagram request limit: the messaging window closes before the account's pause ends \(\d\d:\d\d UTC\), so the DM was not sent$/
        ),
      });
    });

    it("ends FAILED when the copy's follow check finds no follow, and the person is asked to follow", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(LIMIT());
      await run(tapJob("person_unfollowed", "mid_open", { payload: "followcheck:gated:open" }));
      const [copy] = pauseCopies();

      vi.setSystemTime(NOW + copy.opts.delay);
      mockGetUserFollowStatus.mockResolvedValueOnce(false);
      await run(asJob(copy));

      expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
      expect(await dmLogRow("reveal:person_unfollowed", "gated")).toMatchObject({
        status: "FAILED",
        errorMessage: "Not sent: the follow check after the account's pause found no follow",
      });
    });
  });

  // A copy that no longer reaches its campaign settles what it held, so the
  // campaign's read fallback works again once the campaign is back on.
  it("ends a waiting link FAILED when its campaign was paused meanwhile, and the fallback delivers after", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(LIMIT());
    await run(tapJob("person_paused", "mid_paused", { payload: "reveal:tap_campaign" }));
    expect((await dmLogRow("reveal:person_paused", "tap_campaign"))?.status).toBe("PENDING");

    await state.db.automation.update({ where: { id: "tap_campaign" }, data: { isActive: false } });
    try {
      const [copy] = pauseCopies();
      vi.setSystemTime(NOW + copy.opts.delay);
      await expect(run(asJob(copy))).resolves.toBeUndefined();

      expect(pauseCopies()).toHaveLength(1);
      expect(await dmLogRow("reveal:person_paused", "tap_campaign")).toMatchObject({
        status: "FAILED",
        errorMessage: "Not sent: the campaign was paused or changed while the account was paused",
      });
    } finally {
      await state.db.automation.update({ where: { id: "tap_campaign" }, data: { isActive: true } });
    }

    vi.setSystemTime(NOW + HOUR);
    await run(readFallback("person_paused", "tap_campaign"));

    // The refused try and the fallback's link.
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    expect((await dmLogRow("reveal:person_paused", "tap_campaign"))?.status).toBe("SENT");
  });

  it("ends a waiting DM reply FAILED when its campaign was paused meanwhile, and the fallback delivers after", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(LIMIT());
    await run(messageJob("person_guide", "mid_guide", undefined, "GUIDE please"));
    expect((await dmLogRow("dm:mid_guide", "dm_campaign"))?.status).toBe("PENDING");

    await state.db.automation.update({ where: { id: "dm_campaign" }, data: { isActive: false } });
    try {
      const [copy] = pauseCopies();
      vi.setSystemTime(NOW + copy.opts.delay);
      await expect(run(asJob(copy))).resolves.toBeUndefined();

      expect(pauseCopies()).toHaveLength(1);
      expect(await dmLogRow("dm:mid_guide", "dm_campaign")).toMatchObject({
        status: "FAILED",
        errorMessage: "Not sent: the campaign was paused or changed while the account was paused",
      });
    } finally {
      await state.db.automation.update({ where: { id: "dm_campaign" }, data: { isActive: true } });
    }

    vi.setSystemTime(NOW + HOUR);
    await run(readFallback("person_guide", "dm_campaign"));

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    expect((await dmLogRow("reveal:person_guide", "dm_campaign"))?.status).toBe("SENT");
  });

  it("ends a waiting DM reply FAILED when the campaign's keywords changed meanwhile", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(LIMIT());
    // A job from before jobs were bound to a connection: the copy finds the
    // DM's rows by the account's Instagram id.
    const unbound = messageJob("person_keyword", "mid_keyword", undefined, "GUIDE please");
    const data: Record<string, unknown> = { ...unbound.data };
    delete data.accountConnectionId;
    await run({ ...unbound, data });
    expect((await dmLogRow("dm:mid_keyword", "dm_campaign"))?.status).toBe("PENDING");

    await state.db.automation.update({ where: { id: "dm_campaign" }, data: { keywords: ["OTHER"] } });
    try {
      const [copy] = pauseCopies();
      vi.setSystemTime(NOW + copy.opts.delay);
      await run(asJob(copy));

      expect(await dmLogRow("dm:mid_keyword", "dm_campaign")).toMatchObject({
        status: "FAILED",
        errorMessage: "Not sent: the campaign was paused or changed while the account was paused",
      });
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    } finally {
      await state.db.automation.update({ where: { id: "dm_campaign" }, data: { keywords: ["GUIDE"] } });
    }
  });
});
