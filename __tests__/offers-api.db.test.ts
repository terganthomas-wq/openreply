/**
 * The Offers API and the offer redirect against a real Postgres.
 *
 * Deleting an offer takes its id out of campaign orders with raw SQL
 * (array_remove), the funnel counts set columns in one groupBy, and a click
 * finds the person's offer through a filter on the contact. The mocked suites
 * (offers-api, offer-redirect) prove which statements the routes send; only a
 * database shows that Postgres runs them as meant, so the routes run here on
 * real tables. Skipped without TEST_DATABASE_URL; each run builds its own
 * throwaway schema from prisma/migrations and drops it at the end.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "../app/generated/prisma/client";

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  context: null as { workspaceId: string; role: "OWNER" | "ADMIN" | "MEMBER" } | null,
  afterCallbacks: [] as (() => unknown)[],
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUserId: async () => null,
  getCurrentWorkspaceId: async () => state.context?.workspaceId ?? null,
}));
vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => {
    state.afterCallbacks.push(callback);
  },
}));

import { DELETE, GET, PATCH, POST, PUT } from "../app/api/offers/route";
import { GET as openOfferLink } from "../app/o/[slug]/route";
import { hashRecipientId } from "../lib/tracking/server";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `offers_api_${randomBytes(4).toString("hex")}`;
const WORKSPACE = "workspace";
const OTHER_WORKSPACE = "workspace_other";
const BROWSER =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101";
let sql: Client;
let db: PrismaClient;

function offerBody(name: string) {
  return {
    name,
    offerMessages: ["Ich hab noch einen Guide.", "Soll ich ihn dir schicken?"],
    offerDelaysSeconds: [5, 2],
    offerButtonLabel: "Ja, gerne! 🙌",
    confirmationMessages: ["Alles klar!"],
    confirmationDelaysSeconds: [3],
    cardTitle: name,
    cardButtonLabel: "Jetzt holen",
    destinationUrl: `https://example.test/${name}`,
    reminderMessage: "Hol ihn dir noch 👇",
    tagOffered: `${name} angeboten`,
    tagInterested: `${name} Interesse`,
    tagSent: `${name} gesendet`,
    tagClicked: `${name} geklickt`,
  };
}

function apiRequest(method: string, query = "", body?: unknown) {
  return new NextRequest(`https://app.example.test/api/offers${query}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function createOffer(name: string): Promise<{ id: string; linkSlug: string }> {
  const response = await POST(apiRequest("POST", "", offerBody(name)));
  expect(response.status).toBe(201);
  return (await response.json()).data;
}

async function listOffers(query = "") {
  const response = await GET(apiRequest("GET", query));
  expect(response.status).toBe(200);
  return (await response.json()).data as {
    id: string;
    name: string;
    funnel: Record<string, number>;
  }[];
}

async function offerIdsOf(automationId: string) {
  const campaign = await db.automation.findUniqueOrThrow({
    where: { id: automationId },
    select: { offerIds: true },
  });
  return campaign.offerIds;
}

async function click(linkSlug: string, igsid: string) {
  const response = await openOfferLink(
    new NextRequest(
      `https://app.example.test/o/${linkSlug}?r=${hashRecipientId(igsid)}`,
      { headers: { "user-agent": BROWSER } }
    ),
    { params: Promise.resolve({ slug: linkSlug }) }
  );
  for (const callback of state.afterCallbacks.splice(0)) await callback();
  return response;
}

describe.skipIf(!databaseUrl)("offers API on a real Postgres", () => {
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
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
    });
    state.db = db;

    await db.user.create({ data: { id: "owner", email: "offers-api@example.test" } });
    for (const [workspaceId, account] of [
      [WORKSPACE, "account"],
      [OTHER_WORKSPACE, "account_other"],
    ]) {
      await db.workspace.create({ data: { id: workspaceId, name: workspaceId, ownerId: "owner" } });
      await db.instagramAccount.create({
        data: {
          id: account,
          workspaceId,
          instagramId: `ig_${account}`,
          username: account,
          accessToken: "local-test-only",
        },
      });
      await db.automation.create({
        data: {
          id: `campaign_${workspaceId}`,
          workspaceId,
          instagramAccountId: account,
          name: "Campaign",
          keywords: ["GUIDE"],
          dmMessage: "Your link",
        },
      });
    }
    for (const igsid of ["igsid_1", "igsid_2", "igsid_3"]) {
      await db.contact.create({
        data: {
          id: `contact_${igsid}`,
          workspaceId: WORKSPACE,
          instagramAccountId: "account",
          igsid,
          recipientHash: hashRecipientId(igsid),
        },
      });
    }
  }, 60_000);

  beforeEach(async () => {
    state.context = { workspaceId: WORKSPACE, role: "OWNER" };
    state.afterCallbacks.length = 0;
    // Each test starts without offers; their ContactOffer rows cascade.
    await db.offer.deleteMany({});
    await db.contactTag.deleteMany({});
    await db.automation.updateMany({ data: { offerIds: [] } });
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("appends new offers, lists them in order and counts each funnel stage", async () => {
    const a = await createOffer("A");
    const b = await createOffer("B");
    const c = await createOffer("C");
    expect(
      (await db.offer.findMany({ orderBy: { position: "asc" } })).map((o) => [o.id, o.position])
    ).toEqual([
      [a.id, 0],
      [b.id, 1],
      [c.id, 2],
    ]);
    expect(new Set([a.linkSlug, b.linkSlug, c.linkSlug]).size).toBe(3);

    const at = new Date("2026-11-20T10:00:00.000Z");
    await db.contactOffer.createMany({
      data: [
        // Tapped, got the card, clicked.
        { workspaceId: WORKSPACE, contactId: "contact_igsid_1", offerId: a.id, interestedAt: at, sentAt: at, clickedAt: at },
        // Never tapped; the window closed before the reminder.
        { workspaceId: WORKSPACE, contactId: "contact_igsid_2", offerId: a.id, stoppedAt: at, stopReason: "WINDOW_CLOSED" },
        // Never tapped; got the reminder.
        { workspaceId: WORKSPACE, contactId: "contact_igsid_3", offerId: a.id, sentAt: at, sentVia: "REMINDER" },
        { workspaceId: WORKSPACE, contactId: "contact_igsid_1", offerId: c.id },
      ],
    });

    const offers = await listOffers();
    expect(offers.map((offer) => offer.name)).toEqual(["A", "B", "C"]);
    expect(offers.map((offer) => offer.funnel)).toEqual([
      { offered: 3, interested: 1, sent: 2, clicked: 1, stopped: 1 },
      { offered: 0, interested: 0, sent: 0, clicked: 0, stopped: 0 },
      { offered: 1, interested: 0, sent: 0, clicked: 0, stopped: 0 },
    ]);
  });

  it("rewrites the default order in one go and refuses a partial one", async () => {
    const a = await createOffer("A");
    const b = await createOffer("B");
    const c = await createOffer("C");

    const response = await PUT(apiRequest("PUT", "", { order: [c.id, a.id, b.id] }));
    expect(response.status).toBe(200);
    expect((await listOffers()).map((offer) => offer.name)).toEqual(["C", "A", "B"]);

    const partial = await PUT(apiRequest("PUT", "", { order: [b.id, a.id] }));
    expect(partial.status).toBe(400);
    expect((await listOffers()).map((offer) => offer.name)).toEqual(["C", "A", "B"]);
  });

  it("archives an offer someone got, deletes one nobody got, and takes both out of this workspace's campaign orders only", async () => {
    const a = await createOffer("A");
    const b = await createOffer("B");
    const c = await createOffer("C");
    await db.contactOffer.create({
      data: { workspaceId: WORKSPACE, contactId: "contact_igsid_1", offerId: a.id, sentAt: new Date() },
    });
    await db.automation.update({
      where: { id: `campaign_${WORKSPACE}` },
      data: { offerIds: [c.id, a.id, b.id] },
    });
    // Another workspace's campaign that names the same id (it cannot be one
    // of its offers): the cleanup must leave it alone.
    await db.automation.update({
      where: { id: `campaign_${OTHER_WORKSPACE}` },
      data: { offerIds: [a.id] },
    });

    const archived = await DELETE(apiRequest("DELETE", `?id=${a.id}`));
    expect(await archived.json()).toEqual({
      success: true,
      data: { deleted: true, archived: true, campaignsWithoutOffers: [] },
    });
    const archivedRow = await db.offer.findUniqueOrThrow({ where: { id: a.id } });
    expect(archivedRow.archivedAt).toBeInstanceOf(Date);
    expect(archivedRow.isActive).toBe(false);
    // Its history stays.
    expect(await db.contactOffer.count({ where: { offerId: a.id } })).toBe(1);
    expect(await offerIdsOf(`campaign_${WORKSPACE}`)).toEqual([c.id, b.id]);
    expect(await offerIdsOf(`campaign_${OTHER_WORKSPACE}`)).toEqual([a.id]);

    const deleted = await DELETE(apiRequest("DELETE", `?id=${b.id}`));
    expect(await deleted.json()).toEqual({
      success: true,
      data: { deleted: true, archived: false, campaignsWithoutOffers: [] },
    });
    expect(await db.offer.findUnique({ where: { id: b.id } })).toBeNull();
    expect(await offerIdsOf(`campaign_${WORKSPACE}`)).toEqual([c.id]);

    expect((await listOffers()).map((offer) => offer.name)).toEqual(["C"]);
    expect((await listOffers("?archived=1")).map((offer) => offer.name)).toEqual(["A", "C"]);
    // An archived offer is history: not edited, not deleted again.
    expect((await DELETE(apiRequest("DELETE", `?id=${a.id}`))).status).toBe(404);
    expect(
      (await PATCH(apiRequest("PATCH", `?id=${a.id}`, { isActive: true }))).status
    ).toBe(404);
    // A sent card still leads somewhere.
    const response = await click(a.linkSlug, "igsid_1");
    expect(response.headers.get("location")).toBe("https://example.test/A");
  });

  // Disconnecting an account deletes its row, and with it its contacts and
  // their ContactOffer rows. The cards are still in those people's inboxes.
  it("archives an offer whose rows went with a disconnected account, so its sent links keep working", async () => {
    const offer = await createOffer("Guide");
    await db.instagramAccount.create({
      data: {
        id: "account_disconnected",
        workspaceId: WORKSPACE,
        instagramId: "ig_account_disconnected",
        username: "disconnected",
        accessToken: "local-test-only",
      },
    });
    await db.contact.create({
      data: {
        id: "contact_disconnected",
        workspaceId: WORKSPACE,
        instagramAccountId: "account_disconnected",
        igsid: "igsid_disconnected",
        recipientHash: hashRecipientId("igsid_disconnected"),
      },
    });
    await db.contactOffer.create({
      data: {
        workspaceId: WORKSPACE,
        contactId: "contact_disconnected",
        offerId: offer.id,
        sentAt: new Date(),
      },
    });
    // What the worker records before the offer's first row
    // (offers-start.db.test.ts).
    await db.offer.update({
      where: { id: offer.id },
      data: { firstOfferedAt: new Date() },
    });
    await db.instagramAccount.delete({ where: { id: "account_disconnected" } });
    expect(await db.contactOffer.count({ where: { offerId: offer.id } })).toBe(0);

    const response = await DELETE(apiRequest("DELETE", `?id=${offer.id}`));

    expect(await response.json()).toEqual({
      success: true,
      data: { deleted: true, archived: true, campaignsWithoutOffers: [] },
    });
    const row = await db.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(row.archivedAt).toBeInstanceOf(Date);
    const link = await click(offer.linkSlug, "igsid_disconnected");
    expect(link.headers.get("location")).toBe("https://example.test/Guide");
  });

  // A campaign's own order lists the only offers it may start; emptied, it
  // would read as the workspace's default order.
  it("switches offers off for a campaign whose own order held only the deleted offer, and names it", async () => {
    const a = await createOffer("A");
    const b = await createOffer("B");
    const campaigns = [
      { id: "campaign_only_a", offersEnabled: true, offerIds: [a.id] },
      { id: "campaign_a_and_b", offersEnabled: true, offerIds: [a.id, b.id] },
      { id: "campaign_default_order", offersEnabled: true, offerIds: [] },
      { id: "campaign_offers_off", offersEnabled: false, offerIds: [a.id] },
    ];
    for (const campaign of campaigns) {
      await db.automation.create({
        data: {
          ...campaign,
          workspaceId: WORKSPACE,
          instagramAccountId: "account",
          name: `Name of ${campaign.id}`,
          keywords: ["GUIDE"],
          dmMessage: "Your link",
        },
      });
    }
    // Another workspace's campaign naming the same id is left alone.
    await db.automation.update({
      where: { id: `campaign_${OTHER_WORKSPACE}` },
      data: { offersEnabled: true, offerIds: [a.id] },
    });

    try {
      const response = await DELETE(apiRequest("DELETE", `?id=${a.id}`));

      expect(await response.json()).toEqual({
        success: true,
        data: {
          deleted: true,
          archived: false,
          campaignsWithoutOffers: [
            { id: "campaign_only_a", name: "Name of campaign_only_a" },
          ],
        },
      });
      const rows = await db.automation.findMany({
        where: { id: { in: campaigns.map((campaign) => campaign.id) } },
        select: { id: true, offersEnabled: true, offerIds: true },
      });
      expect(
        Object.fromEntries(rows.map(({ id, ...rest }) => [id, rest]))
      ).toEqual({
        campaign_only_a: { offersEnabled: false, offerIds: [] },
        campaign_a_and_b: { offersEnabled: true, offerIds: [b.id] },
        campaign_default_order: { offersEnabled: true, offerIds: [] },
        campaign_offers_off: { offersEnabled: false, offerIds: [] },
      });
      const other = await db.automation.findUniqueOrThrow({
        where: { id: `campaign_${OTHER_WORKSPACE}` },
        select: { offersEnabled: true, offerIds: true },
      });
      expect(other).toEqual({ offersEnabled: true, offerIds: [a.id] });
    } finally {
      await db.automation.deleteMany({
        where: { id: { in: campaigns.map((campaign) => campaign.id) } },
      });
      await db.automation.update({
        where: { id: `campaign_${OTHER_WORKSPACE}` },
        data: { offersEnabled: false, offerIds: [] },
      });
    }
  });

  // A failed tag write must not leave clickedAt behind: later clicks no
  // longer find a clicked row, so the tag would never be written.
  it("records a click and its tag together, so the next click makes good a tag that could not be written", async () => {
    const offer = await createOffer("Fragile");
    await db.contactOffer.create({
      data: { workspaceId: WORKSPACE, contactId: "contact_igsid_1", offerId: offer.id },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // The tag insert fails once, as on a lost connection.
    await sql.query(
      `ALTER TABLE "${schema}"."ContactTag" ADD CONSTRAINT "test_click_tag_fails" CHECK ("tag" <> 'Fragile geklickt')`
    );
    try {
      const response = await click(offer.linkSlug, "igsid_1");
      expect(response.headers.get("location")).toBe("https://example.test/Fragile");
    } finally {
      await sql.query(
        `ALTER TABLE "${schema}"."ContactTag" DROP CONSTRAINT "test_click_tag_fails"`
      );
    }
    expect(consoleError).toHaveBeenCalledWith(
      "[Offer redirect] Click not recorded:",
      expect.anything()
    );
    consoleError.mockRestore();

    // Neither the click nor the tag: the funnel and the contact list agree.
    const missed = await db.contactOffer.findFirstOrThrow({ where: { offerId: offer.id } });
    expect(missed.clickedAt).toBeNull();
    expect(await db.contactTag.count({ where: { contactId: "contact_igsid_1" } })).toBe(0);

    await click(offer.linkSlug, "igsid_1");

    const clicked = await db.contactOffer.findFirstOrThrow({ where: { offerId: offer.id } });
    expect(clicked.clickedAt).toBeInstanceOf(Date);
    const tags = await db.contactTag.findMany({ where: { contactId: "contact_igsid_1" } });
    expect(tags.map((tag) => tag.tag)).toEqual(["Fragile geklickt"]);
  });

  it("marks a click on the person's own offer once and tags them", async () => {
    const offer = await createOffer("Guide");
    await db.contactOffer.create({
      data: { workspaceId: WORKSPACE, contactId: "contact_igsid_1", offerId: offer.id },
    });

    // The token of someone this offer never went to finds nothing.
    const stranger = await click(offer.linkSlug, "igsid_2");
    expect(stranger.headers.get("location")).toBe("https://example.test/Guide");
    const untouched = await db.contactOffer.findFirstOrThrow({ where: { offerId: offer.id } });
    expect(untouched.clickedAt).toBeNull();
    expect(await db.contactTag.count()).toBe(0);

    const response = await click(offer.linkSlug, "igsid_1");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.test/Guide");
    const first = await db.contactOffer.findFirstOrThrow({ where: { offerId: offer.id } });
    expect(first.clickedAt).toBeInstanceOf(Date);
    const tags = await db.contactTag.findMany({ where: { contactId: "contact_igsid_1" } });
    expect(tags.map((tag) => tag.tag)).toEqual(["Guide geklickt"]);

    // A second click changes nothing.
    await click(offer.linkSlug, "igsid_1");
    const again = await db.contactOffer.findFirstOrThrow({ where: { offerId: offer.id } });
    expect(again.clickedAt).toEqual(first.clickedAt);
    expect(await db.contactTag.count()).toBe(1);
    expect(await db.linkClick.count()).toBe(0);
  });

  it("keeps another workspace away from the offers", async () => {
    const offer = await createOffer("Guide");
    state.context = { workspaceId: OTHER_WORKSPACE, role: "OWNER" };

    expect(await listOffers()).toEqual([]);
    expect(
      (await PATCH(apiRequest("PATCH", `?id=${offer.id}`, { isActive: false }))).status
    ).toBe(404);
    expect((await PUT(apiRequest("PUT", "", { order: [offer.id] }))).status).toBe(400);
    expect((await DELETE(apiRequest("DELETE", `?id=${offer.id}`))).status).toBe(404);

    const row = await db.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(row).toMatchObject({ isActive: true, archivedAt: null, position: 0 });
  });
});
