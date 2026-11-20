/**
 * An offer's messages after its start, against a real Postgres.
 *
 * Whether a tap still gets the confirmations and the card rests on what the
 * row says was sent (sentAt, sentVia), read by where clauses that no mock
 * evaluates, and on the message claims (PostbackDelivery). So the jobs run
 * here on the real tables. Instagram, the token, the usage counter and the
 * queue are replaced; the queue drops a second add of a job id while that job
 * waits, as BullMQ does. Skipped without TEST_DATABASE_URL; each run builds
 * its own throwaway schema from prisma/migrations and drops it at the end.
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
  OFFER_JOB_NAME: "process-offer",
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

import { MetaApiError } from "../lib/meta/client";
import { processOffer, processOfferTap } from "../lib/offers/worker";
import type { ProcessOfferJob, ProcessPostbackJob } from "../lib/queue/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `offers_sequence_${randomBytes(4).toString("hex")}`;
const workspaceId = "workspace";
const HOUR = 60 * 60_000;
let sql: Client;
let realDb: PrismaClient;

// The queue: waiting jobs by id, in the order they were added.
const waiting = new Map<string, ProcessOfferJob>();
// What reached the person, in order.
let sent: string[] = [];

function offerJob(jobId: string, data: ProcessOfferJob): Job<ProcessOfferJob> {
  return {
    name: "process-offer",
    id: jobId,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    data,
  } as unknown as Job<ProcessOfferJob>;
}

function tapJob(
  igsid: string,
  contactOfferId: string,
  mid: string,
  attemptsMade = 0
): Job<ProcessPostbackJob> {
  return {
    name: "process-postback",
    id: `postback_ig_sequence_${igsid}_${mid}`,
    attemptsMade,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    data: {
      instagramAccountId: "ig_sequence",
      accountConnectionId: "account",
      userId: igsid,
      payload: `offer:${contactOfferId}`,
      mid,
    },
  } as unknown as Job<ProcessPostbackJob>;
}

/** Run the job that waits longest; it leaves the queue once it completed. */
async function runNext(): Promise<void> {
  const [jobId, data] = [...waiting][0];
  await processOffer(offerJob(jobId, data));
  waiting.delete(jobId);
}

async function drain(): Promise<void> {
  for (let run = 0; waiting.size > 0; run++) {
    if (run === 20) throw new Error(`The queue does not drain: ${[...waiting.keys()]}`);
    await runNext();
  }
}

/**
 * A person who got the offer's messages a day ago and then its reminder,
 * which went out through the real reminder job. Returns the row's id.
 */
async function remindedPerson(igsid: string): Promise<string> {
  const contact = await realDb.contact.create({
    data: {
      workspaceId,
      instagramAccountId: "account",
      igsid,
      username: igsid,
      recipientHash: `hash_${igsid}`,
      lastInteractionAt: new Date(Date.now() - 23 * HOUR),
    },
  });
  const { id } = await realDb.contactOffer.create({
    data: {
      workspaceId,
      contactId: contact.id,
      offerId: "offer",
      startKey: `campaign:tap:${igsid}`,
      offeredAt: new Date(Date.now() - 23 * HOUR),
      pitchSentAt: new Date(Date.now() - 23 * HOUR),
    },
  });
  await processOffer(
    offerJob(`offer_${id}_reminder`, {
      workspaceId,
      accountConnectionId: "account",
      instagramAccountId: "ig_sequence",
      phase: "reminder",
      contactOfferId: id,
    })
  );
  return id;
}

function row(id: string) {
  return realDb.contactOffer.findUniqueOrThrow({ where: { id } });
}

// Sorted here: the database's collation would decide upper case first or not.
async function tagsOf(igsid: string) {
  const tags = await realDb.contactTag.findMany({
    where: { contact: { igsid } },
    select: { tag: true },
  });
  return tags.map((t) => t.tag).sort();
}

describe.skipIf(!databaseUrl)("offer messages on a real Postgres", () => {
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
    realDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
    });
    state.db = realDb;

    await realDb.user.create({ data: { id: "owner", email: "offers-sequence@example.test" } });
    await realDb.workspace.create({ data: { id: workspaceId, name: "Offers", ownerId: "owner" } });
    await realDb.instagramAccount.create({
      data: {
        id: "account",
        workspaceId,
        instagramId: "ig_sequence",
        username: "sequence",
        accessToken: "local-test-only",
      },
    });
    await realDb.offer.create({
      data: {
        id: "offer",
        workspaceId,
        name: "Guide",
        offerMessages: ["Soll ich ihn dir schicken?"],
        offerDelaysSeconds: [5],
        offerButtonLabel: "Ja, gerne! 🙌",
        confirmationMessages: ["Alles klar!", "Hier geht's zum Guide 👇"],
        confirmationDelaysSeconds: [3, 3],
        cardTitle: "Prompting Guide",
        cardButtonLabel: "Jetzt holen",
        destinationUrl: "https://example.test/guide",
        linkSlug: "slug_sequence",
        reminderEnabled: true,
        reminderDelayHours: 23,
        reminderMessage: "Hey, nur kurz zur Info 👇",
        tagOffered: "Guide angeboten",
        tagInterested: "Guide Interesse",
        tagSent: "Guide gesendet",
        tagClicked: "Guide geklickt",
      },
    });
  }, 60_000);

  beforeEach(() => {
    state.db = realDb;
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
    mockSendDirectMessageWithCard
      .mockReset()
      .mockImplementation(async (_auth, _ig, _user, card: { title: string }) =>
        delivered(`card: ${card.title}`)
      );
  });

  afterAll(async () => {
    await realDb?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("answers a tap after the reminder with the confirmations, then the card, each once", async () => {
    const igsid = "igsid_tap_after_reminder";
    const id = await remindedPerson(igsid);
    const reminded = await row(id);
    expect(reminded).toMatchObject({ sentVia: "REMINDER", interestedAt: null });
    expect(reminded.sentAt).not.toBeNull();

    // The tap records the interest, then Redis refuses its job. The retry
    // must still queue the confirmations.
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis connection lost"));
    await expect(processOfferTap(tapJob(igsid, id, "mid_yes"))).rejects.toThrow(
      "Redis connection lost"
    );
    await processOfferTap(tapJob(igsid, id, "mid_yes", 1));
    expect([...waiting.keys()]).toEqual([`offer_${id}_confirm_0`]);

    // "Alles klar!" goes out, and a quick second tap queues the confirmations
    // once more, which their claims answer without sending anything again.
    await runNext();
    await processOfferTap(tapJob(igsid, id, "mid_second"));
    expect(sent).toHaveLength(2);
    await drain();

    // The first tap's webhook again: its card is out.
    await processOfferTap(tapJob(igsid, id, "mid_yes"));
    expect(waiting.size).toBe(0);
    // A later tap gets the card once more.
    await processOfferTap(tapJob(igsid, id, "mid_later"));

    expect(sent).toEqual([
      "link: Hey, nur kurz zur Info 👇",
      "text: Alles klar!",
      "text: Hier geht's zum Guide 👇",
      "card: Prompting Guide",
      "card: Prompting Guide",
    ]);
    const done = await row(id);
    expect(done).toMatchObject({
      interestedMid: "mid_yes",
      sentVia: "CARD",
      stoppedAt: null,
      reminderSentAt: reminded.reminderSentAt,
    });
    // Counted as sent since the reminder.
    expect(done.sentAt).toEqual(reminded.sentAt);
    expect(await tagsOf(igsid)).toEqual(["Guide Interesse", "Guide gesendet"]);
  });

  it("does not mark an offer the reminder delivered stopped when its card is refused, and a later tap gets the card", async () => {
    const igsid = "igsid_stopped_after_reminder";
    const id = await remindedPerson(igsid);

    await processOfferTap(tapJob(igsid, id, "mid_yes"));
    // Instagram refuses the card. The reminder brought the link already, so
    // the offer did not stop early: the funnel's "stopped" leaves it out.
    mockSendDirectMessageWithCard.mockRejectedValueOnce(
      new MetaApiError(551, undefined, undefined, "This person isn't available right now.")
    );
    await drain();
    expect(await row(id)).toMatchObject({
      stoppedAt: null,
      stopReason: null,
      sentVia: "REMINDER",
    });
    expect(
      await realDb.operationalEvent.count({
        where: { workspaceId, message: "Offer message not sent: Instagram refused a message" },
      })
    ).toBe(1);

    // The next tap opens a new window and queues the rest again; the
    // confirmations went out before and are not sent again.
    await processOfferTap(tapJob(igsid, id, "mid_again"));
    await drain();

    expect(sent).toEqual([
      "link: Hey, nur kurz zur Info 👇",
      "text: Alles klar!",
      "text: Hier geht's zum Guide 👇",
      "card: Prompting Guide",
    ]);
    expect(await row(id)).toMatchObject({ stoppedAt: null, stopReason: null, sentVia: "CARD" });
  });
});
