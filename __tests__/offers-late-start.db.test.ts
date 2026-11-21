/**
 * Offers that start 22 hours after the link, against a real Postgres.
 *
 * The migration must give every existing campaign and offer row today's
 * behaviour (a start right after the link, with its reminder). A late start
 * must find the contact the delivery recorded without ever creating one, so
 * a contact deleted in the 22 hours stays deleted, and its row must say that
 * it started late, which leaves the reminder out. Both rest on the real
 * columns, their defaults and the contact's unique key, so they run here;
 * Instagram, the token, the usage counter and the queue are replaced. The
 * queue drops a second add of a job id while that job waits, as BullMQ does,
 * and ignores delays. Skipped without TEST_DATABASE_URL; each run builds its
 * own throwaway schema from prisma/migrations and drops it at the end.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Job } from "bullmq";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
}));
const {
  mockQueueAdd,
  mockSendDirectMessage,
  mockSendDirectMessageWithButton,
  mockSendDirectMessageWithLinkButton,
  mockSendDirectMessageWithCard,
} = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockSendDirectMessageWithButton: vi.fn(),
  mockSendDirectMessageWithLinkButton: vi.fn(),
  mockSendDirectMessageWithCard: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd, remove: vi.fn() }),
  // No account is paused for a Meta request limit.
  getRedisConnection: () => ({ get: async () => null }),
  OFFER_JOB_NAME: "process-offer",
  POSTBACK_JOB_NAME: "process-postback",
}));
// Closed: a Meta function the engine starts to use without a mock here fails
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
    constructor(message: string) {
      super(368, undefined, undefined, message);
      this.name = "RateLimitError";
    }
  }
  return {
    sendDirectMessage: mockSendDirectMessage,
    sendDirectMessageWithButton: mockSendDirectMessageWithButton,
    sendDirectMessageWithLinkButton: mockSendDirectMessageWithLinkButton,
    sendDirectMessageWithCard: mockSendDirectMessageWithCard,
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

import { processOffer } from "../lib/offers/worker";
import type { ProcessOfferJob } from "../lib/queue/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");
const LATE_START_MIGRATION = "20261121120000_offer_late_start";
const schema = `offers_late_${randomBytes(4).toString("hex")}`;
const workspaceId = "workspace";
const HOUR = 60 * 60_000;
let sql: Client;
let db: PrismaClient;

// The queue: waiting jobs by id, in the order they were added.
const waiting = new Map<string, ProcessOfferJob>();
// What reached the person, in order.
let sent: string[] = [];

function migrationSql(dir: string) {
  return readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
}

function offerJob(jobId: string, data: ProcessOfferJob, timestamp = Date.now()): Job<ProcessOfferJob> {
  return {
    name: "process-offer",
    id: jobId,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp,
    data,
  } as unknown as Job<ProcessOfferJob>;
}

/**
 * The start job a delivered link queued for a tap `hoursAgo` hours ago, as
 * it runs now. A late one was queued right after the delivery, by default
 * two seconds after that tap.
 */
function startJob(
  igsid: string,
  hoursAgo: number,
  lateStart: boolean,
  queuedAfterTapMs = 2000
): Job<ProcessOfferJob> {
  const tappedAt = Date.now() - hoursAgo * HOUR;
  return offerJob(
    `start_${igsid}`,
    {
      phase: "start",
      workspaceId,
      accountConnectionId: "account",
      instagramAccountId: "ig_late",
      automationId: "campaign",
      userId: igsid,
      interactionAt: tappedAt,
      startKey: `campaign:tap:mid_${igsid}`,
      ...(lateStart ? { lateStart: true } : {}),
    },
    tappedAt + queuedAfterTapMs
  );
}

/**
 * The contact as the delivery recorded it, at its tap, or `recordedAfterTapMs`
 * later: the first DM of someone new is recorded when the worker gets to it.
 */
function deliveredTo(igsid: string, hoursAgo: number, recordedAfterTapMs = 0) {
  const tappedAt = Date.now() - hoursAgo * HOUR;
  return db.contact.create({
    data: {
      workspaceId,
      instagramAccountId: "account",
      igsid,
      username: igsid,
      recipientHash: `hash_${igsid}`,
      lastInteractionAt: new Date(tappedAt),
      createdAt: new Date(tappedAt + recordedAfterTapMs),
    },
  });
}

/** Run the job that waits longest; it leaves the queue once it completed. */
async function runNext(): Promise<string> {
  const [jobId, data] = [...waiting][0];
  await processOffer(offerJob(jobId, data));
  waiting.delete(jobId);
  return jobId;
}

/** Run jobs until the offer's last message, the one with the button, is out. */
async function runUntilPitched(): Promise<void> {
  for (let run = 0; !sent.some((entry) => entry.startsWith("button: ")); run++) {
    if (run === 10 || waiting.size === 0) throw new Error(`No pitch: ${[...waiting.keys()]}`);
    await runNext();
  }
}

async function rowOf(igsid: string) {
  return db.contactOffer.findFirst({ where: { contact: { igsid } } });
}

describe.skipIf(!databaseUrl)("offers that start 22 hours later, on a real Postgres", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);

    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toContain(LATE_START_MIGRATION);
    for (const dir of dirs.filter((d) => d < LATE_START_MIGRATION)) {
      await sql.query(migrationSql(dir));
    }
    // Rows that exist in production before the migration runs: a campaign
    // with offers and an offer it started, both from before the setting.
    await sql.query(`
      INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('owner', 'offers-late@example.test', now());
      INSERT INTO "Workspace" ("id", "name", "ownerId", "updatedAt") VALUES ('${workspaceId}', 'Late offers', 'owner', now());
      INSERT INTO "InstagramAccount" ("id", "workspaceId", "instagramId", "username", "accessToken", "updatedAt")
        VALUES ('account', '${workspaceId}', 'ig_late', 'late', 'local-test-only', now());
      INSERT INTO "Automation" ("id", "workspaceId", "instagramAccountId", "name", "keywords", "dmMessage",
          "openingDmEnabled", "openingDmMessage", "openingDmButtonLabel", "offersEnabled", "updatedAt")
        VALUES ('campaign', '${workspaceId}', 'account', 'Guide', '{GUIDE}', 'Your link',
          true, 'Want the guide?', 'Yes please', true, now());
      INSERT INTO "Offer" ("id", "workspaceId", "name", "offerMessages", "offerDelaysSeconds", "offerButtonLabel",
          "cardTitle", "cardButtonLabel", "destinationUrl", "linkSlug", "reminderMessage",
          "tagOffered", "tagInterested", "tagSent", "tagClicked", "updatedAt")
        VALUES ('offer', '${workspaceId}', 'Guide', '{"Ich hab noch einen Guide.","Soll ich ihn dir schicken?"}', '{5,3}',
          'Ja, gerne!', 'Guide', 'Jetzt holen', 'https://example.test/guide', 'slug_late', 'Hey, nur kurz 👇',
          'Guide angeboten', 'Guide Interesse', 'Guide gesendet', 'Guide geklickt', now());
      INSERT INTO "Contact" ("id", "workspaceId", "instagramAccountId", "igsid", "recipientHash", "lastInteractionAt", "updatedAt")
        VALUES ('contact_legacy', '${workspaceId}', 'account', 'igsid_legacy', 'hash_legacy', now(), now());
      INSERT INTO "ContactOffer" ("id", "workspaceId", "contactId", "offerId", "automationId", "startKey")
        VALUES ('co_legacy', '${workspaceId}', 'contact_legacy', 'offer', 'campaign', 'campaign:tap:mid_legacy');
    `);
    for (const dir of dirs.filter((d) => d >= LATE_START_MIGRATION)) {
      await sql.query(migrationSql(dir));
    }

    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
    });
    state.db = db;
  }, 60_000);

  beforeEach(() => {
    state.db = db;
    waiting.clear();
    sent = [];
    // BullMQ keeps a job's id while it waits: a second add is dropped.
    mockQueueAdd
      .mockReset()
      .mockImplementation(async (_name: string, data: ProcessOfferJob, options: { jobId: string }) => {
        if (!waiting.has(options.jobId)) waiting.set(options.jobId, data);
      });
    const delivered = (entry: string) => {
      sent.push(entry);
      return { recipient_id: "person", message_id: `m_${sent.length}` };
    };
    mockSendDirectMessage
      .mockReset()
      .mockImplementation(async (_auth, _ig, _user, text: string) => delivered(`text: ${text}`));
    mockSendDirectMessageWithButton
      .mockReset()
      .mockImplementation(async (_auth, _ig, _user, text: string) => delivered(`button: ${text}`));
    mockSendDirectMessageWithLinkButton
      .mockReset()
      .mockImplementation(async (_auth, _ig, _user, text: string) => delivered(`link: ${text}`));
    mockSendDirectMessageWithCard.mockReset();
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("gives existing campaigns and offer rows the start right after the link", async () => {
    expect(await db.automation.findUniqueOrThrow({ where: { id: "campaign" } })).toMatchObject({
      offersEnabled: true,
      offerDelayHours: 0,
    });
    expect(await db.contactOffer.findUniqueOrThrow({ where: { id: "co_legacy" } })).toMatchObject({
      lateStart: false,
    });

    // Rows written without the columns, as the previous app and worker do.
    await sql.query(`
      INSERT INTO "Automation" ("id", "workspaceId", "instagramAccountId", "name", "keywords", "dmMessage", "updatedAt")
        VALUES ('campaign_old_app', '${workspaceId}', 'account', 'Old app', '{GUIDE}', 'Your link', now());
      INSERT INTO "Contact" ("id", "workspaceId", "instagramAccountId", "igsid", "recipientHash", "updatedAt")
        VALUES ('contact_old_worker', '${workspaceId}', 'account', 'igsid_old_worker', 'hash_old', now());
      INSERT INTO "ContactOffer" ("id", "workspaceId", "contactId", "offerId", "automationId", "startKey")
        VALUES ('co_old_worker', '${workspaceId}', 'contact_old_worker', 'offer', 'campaign', 'campaign:tap:mid_old');
    `);
    expect(
      (await db.automation.findUniqueOrThrow({ where: { id: "campaign_old_app" } })).offerDelayHours
    ).toBe(0);
    expect(
      (await db.contactOffer.findUniqueOrThrow({ where: { id: "co_old_worker" } })).lateStart
    ).toBe(false);

    // Both columns are NOT NULL with their default.
    const { rows } = await sql.query(
      `SELECT table_name, column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND column_name IN ('offerDelayHours', 'lateStart')
        ORDER BY table_name`,
      [schema]
    );
    expect(rows).toEqual([
      { table_name: "Automation", column_name: "offerDelayHours", is_nullable: "NO", column_default: "0" },
      { table_name: "ContactOffer", column_name: "lateStart", is_nullable: "NO", column_default: "false" },
    ]);
  });

  it("starts a late offer for the contact the delivery recorded, without a reminder", async () => {
    const igsid = "igsid_late";
    await deliveredTo(igsid, 22);

    // 22 hours after the tap the start job runs and finds the contact.
    await processOffer(startJob(igsid, 22, true));
    const row = await rowOf(igsid);
    expect(row).toMatchObject({ lateStart: true, automationId: "campaign", pitchSentAt: null });
    expect([...waiting.keys()]).toEqual([`offer_${row!.id}_offer_0`]);

    await runUntilPitched();

    expect(sent).toEqual([
      "text: Ich hab noch einen Guide.",
      "button: Soll ich ihn dir schicken?",
    ]);
    expect((await rowOf(igsid))!.pitchSentAt).not.toBeNull();
    // Whoever does not tap gets nothing more: no reminder is waiting.
    expect(waiting.size).toBe(0);
    expect(await db.contact.count({ where: { igsid } })).toBe(1);
    expect(
      (await db.contactTag.findMany({ where: { contact: { igsid } } })).map((t) => t.tag)
    ).toEqual(["Guide angeboten"]);
  });

  it("queues the reminder as before for an offer that starts right after the link", async () => {
    const igsid = "igsid_right_away";

    await processOffer(startJob(igsid, 0, false));
    await runUntilPitched();

    const row = await rowOf(igsid);
    expect(row).toMatchObject({ lateStart: false });
    expect([...waiting.keys()]).toEqual([`offer_${row!.id}_reminder`]);
  });

  it("brings no contact back that was deleted in the meantime", async () => {
    const igsid = "igsid_deleted";
    const contact = await deliveredTo(igsid, 22);
    // Deleted on request (GDPR) while the start waited.
    await db.contact.delete({ where: { id: contact.id } });

    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await processOffer(startJob(igsid, 22, true));
    } finally {
      consoleLog.mockRestore();
    }

    expect(await db.contact.count({ where: { igsid } })).toBe(0);
    expect(await rowOf(igsid)).toBeNull();
    expect(waiting.size).toBe(0);
    expect(sent).toEqual([]);
  });

  it("brings no offer to the person's new contact after such a deletion", async () => {
    const igsid = "igsid_came_back";
    const contact = await deliveredTo(igsid, 22);
    await db.contact.delete({ where: { id: contact.id } });
    // An hour ago the person wrote again: a new contact, recorded then. Its
    // window is open, but the old trigger is not its own.
    const comeback = await db.contact.create({
      data: {
        workspaceId,
        instagramAccountId: "account",
        igsid,
        recipientHash: `hash_${igsid}`,
        lastInteractionAt: new Date(Date.now() - HOUR),
      },
    });

    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await processOffer(startJob(igsid, 22, true));
      expect(consoleLog).toHaveBeenCalledWith(
        "[Offers] Late start skipped: the contact no longer exists",
        { automationId: "campaign" }
      );
    } finally {
      consoleLog.mockRestore();
    }

    expect(await rowOf(igsid)).toBeNull();
    expect(waiting.size).toBe(0);
    expect(sent).toEqual([]);
    // Untouched: no tag, the same last interaction, still the only row.
    expect(await db.contactTag.count({ where: { contactId: comeback.id } })).toBe(0);
    expect(await db.contact.findMany({ where: { igsid } })).toEqual([comeback]);
  });

  it("starts for someone new whose first DM the worker got to late", async () => {
    const igsid = "igsid_busy_queue";
    // Recorded ten minutes after the DM, the link and the start right after.
    await deliveredTo(igsid, 22, 10 * 60_000);

    await processOffer(startJob(igsid, 22, true, 10 * 60_000 + 3000));

    expect(await rowOf(igsid)).toMatchObject({ lateStart: true });
  });

  it("keeps the late start of a campaign switched back to right after the link", async () => {
    const igsid = "igsid_switched_back";
    await deliveredTo(igsid, 22);
    await db.automation.update({ where: { id: "campaign" }, data: { offerDelayHours: 0 } });

    await processOffer(startJob(igsid, 22, true));

    expect(await rowOf(igsid)).toMatchObject({ lateStart: true });
  });

  it("skips a late start whose window has closed, and says so", async () => {
    const igsid = "igsid_closed";
    await deliveredTo(igsid, 25);

    await processOffer(startJob(igsid, 25, true));

    expect(await rowOf(igsid)).toBeNull();
    expect(waiting.size).toBe(0);
    expect(
      await db.operationalEvent.count({
        where: { workspaceId, message: "Offer skipped: messaging window closed" },
      })
    ).toBe(1);
  });
});
