/**
 * Offer starts against a real Postgres.
 *
 * Which offer a trigger starts, and that a repeat of the trigger starts none,
 * rests on two unique keys of ContactOffer, (contactId, offerId) and
 * (contactId, startKey), and on reading a P2002 from the pg driver adapter
 * correctly. No mock reproduces either, so the start runs here against the
 * real tables; only the queue is replaced. Skipped without TEST_DATABASE_URL;
 * each run builds its own throwaway schema from prisma/migrations and drops
 * it at the end.
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
const { mockQueueAdd } = vi.hoisted(() => ({ mockQueueAdd: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd, remove: vi.fn() }),
  OFFER_JOB_NAME: "process-offer",
}));

import { processOffer } from "../lib/offers/worker";
import type { ProcessOfferJob } from "../lib/queue/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `offers_start_${randomBytes(4).toString("hex")}`;
const workspaceId = "workspace";
let sql: Client;
let realDb: PrismaClient;

function createOffer(id: string, position: number, extra: { isActive?: boolean; archivedAt?: Date } = {}) {
  return realDb.offer.create({
    data: {
      id,
      workspaceId,
      name: id,
      position,
      offerMessages: ["Want the guide?"],
      offerDelaysSeconds: [5],
      offerButtonLabel: "Yes, please",
      cardTitle: "Guide",
      cardButtonLabel: "Download",
      destinationUrl: "https://example.test/guide",
      linkSlug: `slug_${id}`,
      tagOffered: `${id} offered`,
      tagInterested: `${id} interested`,
      tagSent: `${id} sent`,
      tagClicked: `${id} clicked`,
      ...extra,
    },
  });
}

/** The start job a delivered link queues, for one trigger. */
function startJob(
  automationId: string,
  igsid: string,
  trigger: string,
  timestamp = Date.now()
): Job<ProcessOfferJob> {
  return {
    name: "process-offer",
    id: `start_${trigger}`,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp,
    data: {
      phase: "start",
      workspaceId,
      accountConnectionId: "account",
      instagramAccountId: "ig_offers",
      automationId,
      userId: igsid,
      interactionAt: Date.now() - 60_000,
      startKey: `${automationId}:${trigger}`,
    },
  } as unknown as Job<ProcessOfferJob>;
}

/**
 * Offers a person was given, by offer id: two starts in a row can share a
 * millisecond, so their offeredAt does not order them.
 */
async function offered(igsid: string) {
  const rows = await realDb.contactOffer.findMany({
    where: { contact: { igsid } },
    orderBy: { offerId: "asc" },
    select: { startKey: true, offerId: true, automationId: true },
  });
  return rows.map((row) => [row.automationId, row.startKey, row.offerId]);
}

async function rowIdOf(igsid: string, offerId: string) {
  const row = await realDb.contactOffer.findFirstOrThrow({
    where: { contact: { igsid }, offerId },
    select: { id: true },
  });
  return row.id;
}

/** The first message each start queued, by ContactOffer row. */
function queuedFirstMessages() {
  return mockQueueAdd.mock.calls.map(([, data, options]) => [
    data.contactOfferId,
    options.jobId,
  ]);
}

/**
 * The real client, except that one contactOffer read returns what a run that
 * read a moment earlier would have seen. That is how a concurrent start
 * reaches the unique keys without a real race.
 */
function withStaleRead(method: "findMany" | "findUnique", staleResult: unknown) {
  let stale = true;
  const contactOffer = realDb.contactOffer;
  state.db = {
    automation: realDb.automation,
    contact: realDb.contact,
    contactTag: realDb.contactTag,
    offer: realDb.offer,
    operationalEvent: realDb.operationalEvent,
    contactOffer: {
      create: (args: Parameters<typeof contactOffer.create>[0]) => contactOffer.create(args),
      findMany: (args: Parameters<typeof contactOffer.findMany>[0]) => {
        if (method === "findMany" && stale) {
          stale = false;
          return Promise.resolve(staleResult);
        }
        return contactOffer.findMany(args);
      },
      findUnique: (args: Parameters<typeof contactOffer.findUnique>[0]) => {
        if (method === "findUnique" && stale) {
          stale = false;
          return Promise.resolve(staleResult);
        }
        return contactOffer.findUnique(args);
      },
    },
  } as unknown as PrismaClient;
}

describe.skipIf(!databaseUrl)("offer starts on a real Postgres", () => {
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

    await realDb.user.create({ data: { id: "owner", email: "offers-start@example.test" } });
    await realDb.workspace.create({ data: { id: workspaceId, name: "Offers", ownerId: "owner" } });
    await realDb.instagramAccount.create({
      data: {
        id: "account",
        workspaceId,
        instagramId: "ig_offers",
        username: "offers",
        accessToken: "local-test-only",
      },
    });
    for (const [id, offerIds] of [
      ["campaign", []],
      ["campaign_custom", ["offer_c", "offer_a"]],
    ] as const) {
      await realDb.automation.create({
        data: {
          id,
          workspaceId,
          instagramAccountId: "account",
          name: id,
          keywords: ["GUIDE"],
          dmMessage: "Your link",
          // A paused campaign still starts the offer its delivery earned.
          isActive: id === "campaign",
          offersEnabled: true,
          offerIds: [...offerIds],
        },
      });
    }
    await createOffer("offer_a", 0);
    await createOffer("offer_paused", 1, { isActive: false });
    await createOffer("offer_b", 2);
    await createOffer("offer_deleted", 3, { archivedAt: new Date("2026-11-01T00:00:00.000Z") });
    await createOffer("offer_c", 4);
  }, 60_000);

  beforeEach(() => {
    mockQueueAdd.mockReset().mockResolvedValue({});
    state.db = realDb;
  });

  afterAll(async () => {
    await realDb?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("starts the next offer for every new trigger of a campaign, once per trigger", async () => {
    const igsid = "igsid_triggers";
    const firstTap = startJob("campaign", igsid, "tap:mid_comment_1");

    await processOffer(firstTap);
    // A second comment, tapped again: the next offer.
    await processOffer(startJob("campaign", igsid, "tap:mid_comment_2"));
    expect(await offered(igsid)).toEqual([
      ["campaign", "campaign:tap:mid_comment_1", "offer_a"],
      ["campaign", "campaign:tap:mid_comment_2", "offer_b"],
    ]);

    // The first tap's webhook again, queued after its start finished.
    await processOffer(startJob("campaign", igsid, "tap:mid_comment_1", Date.now() + 1000));
    // The first start's job retried: it finds its own row and resumes.
    await processOffer({ ...firstTap, attemptsMade: 1 } as Job<ProcessOfferJob>);
    expect(await offered(igsid)).toHaveLength(2);

    // A DM that brings the link: the last offer left.
    await processOffer(startJob("campaign", igsid, "dm:mid_dm_3"));
    // Paused and deleted offers are never started: nothing is left.
    await processOffer(startJob("campaign", igsid, "tap:mid_comment_4"));

    expect(await offered(igsid)).toEqual([
      ["campaign", "campaign:tap:mid_comment_1", "offer_a"],
      ["campaign", "campaign:tap:mid_comment_2", "offer_b"],
      ["campaign", "campaign:dm:mid_dm_3", "offer_c"],
    ]);
    const [rowA, rowB, rowC] = await Promise.all(
      ["offer_a", "offer_b", "offer_c"].map((offerId) => rowIdOf(igsid, offerId))
    );
    expect(queuedFirstMessages()).toEqual([
      [rowA, `offer_${rowA}_offer_0`],
      [rowB, `offer_${rowB}_offer_0`],
      [rowA, `offer_${rowA}_offer_0`],
      [rowC, `offer_${rowC}_offer_0`],
    ]);
    const tags = await realDb.contactTag.findMany({
      where: { contact: { igsid } },
      orderBy: { tag: "asc" },
      select: { tag: true },
    });
    expect(tags.map((t) => t.tag)).toEqual([
      "offer_a offered",
      "offer_b offered",
      "offer_c offered",
    ]);
  });

  it("never gives one person the same offer twice, whichever campaign starts it", async () => {
    const igsid = "igsid_campaigns";

    await processOffer(startJob("campaign_custom", igsid, "tap:mid_1"));
    await processOffer(startJob("campaign", igsid, "tap:mid_2"));
    await processOffer(startJob("campaign_custom", igsid, "dm:mid_3"));

    // The custom order starts with offer_c, the default one with offer_a.
    // Then both are taken, and the custom order lists no others.
    expect(await offered(igsid)).toEqual([
      ["campaign", "campaign:tap:mid_2", "offer_a"],
      ["campaign_custom", "campaign_custom:tap:mid_1", "offer_c"],
    ]);
    expect(queuedFirstMessages()).toHaveLength(2);
  });

  it("moves on to the next offer when another start took one between its read and its write", async () => {
    const igsid = "igsid_race_offer";
    await processOffer(startJob("campaign", igsid, "tap:mid_1"));

    // This run did not see the row the first start just wrote.
    withStaleRead("findMany", []);
    await processOffer(startJob("campaign", igsid, "tap:mid_2"));

    expect(await offered(igsid)).toEqual([
      ["campaign", "campaign:tap:mid_1", "offer_a"],
      ["campaign", "campaign:tap:mid_2", "offer_b"],
    ]);
    expect(queuedFirstMessages()).toHaveLength(2);
  });

  it("leaves the offer to a concurrent run of the same start", async () => {
    const igsid = "igsid_race_trigger";
    await processOffer(startJob("campaign", igsid, "tap:mid_1"));

    // A second run of the same start missed the row the first one wrote.
    withStaleRead("findUnique", null);
    await processOffer(startJob("campaign", igsid, "tap:mid_1", Date.now() + 1000));

    expect(await offered(igsid)).toEqual([["campaign", "campaign:tap:mid_1", "offer_a"]]);
    expect(queuedFirstMessages()).toHaveLength(1);
  });

  // Deleting an offer archives it once it was ever offered, so the card
  // links in people's inboxes keep working. The rows cannot tell: they go
  // with their contacts when an account is disconnected. The mark stays.
  it("marks an offer as offered at its first start, once, and keeps the mark when its rows go", async () => {
    await createOffer("offer_marked", 9);
    await realDb.automation.create({
      data: {
        id: "campaign_marked",
        workspaceId,
        instagramAccountId: "account",
        name: "campaign_marked",
        keywords: ["GUIDE"],
        dmMessage: "Your link",
        offersEnabled: true,
        offerIds: ["offer_marked"],
      },
    });
    const markOf = async () =>
      (await realDb.offer.findUniqueOrThrow({ where: { id: "offer_marked" } }))
        .firstOfferedAt;
    expect(await markOf()).toBeNull();

    const before = Date.now();
    await processOffer(startJob("campaign_marked", "igsid_marked_1", "tap:mid_1"));
    const marked = await markOf();
    expect(marked).toBeInstanceOf(Date);
    expect(marked!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(queuedFirstMessages()).toHaveLength(1);

    // A later start for someone else keeps the first time.
    await processOffer(startJob("campaign_marked", "igsid_marked_2", "tap:mid_2"));
    expect(queuedFirstMessages()).toHaveLength(2);
    expect(await markOf()).toEqual(marked);

    // As when the account is disconnected: the contacts go, their offers too.
    await realDb.contact.deleteMany({
      where: { igsid: { in: ["igsid_marked_1", "igsid_marked_2"] } },
    });
    expect(await realDb.contactOffer.count({ where: { offerId: "offer_marked" } })).toBe(0);
    expect(await markOf()).toEqual(marked);
  });

  it("starts nothing and records why when the messaging window has closed", async () => {
    const igsid = "igsid_closed";
    const job = startJob("campaign", igsid, "tap:mid_old");
    job.data.interactionAt = Date.now() - 25 * 60 * 60_000;

    await processOffer(job);

    expect(await offered(igsid)).toEqual([]);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(
      await realDb.operationalEvent.count({
        where: { workspaceId, message: "Offer skipped: messaging window closed" },
      })
    ).toBe(1);
  });
});
