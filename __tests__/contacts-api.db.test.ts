/**
 * The Contacts API against a real Postgres.
 *
 * The list searches handles case-insensitively and filters by tag through a
 * relation, and the data deletion anonymises DM log rows and what
 * Diagnostics keeps with raw SQL (a CASE on the comment id, string
 * concatenation, JSONB key removal and text search). The mocked suite
 * (contacts-api) proves which statements the route sends; only a database
 * shows that Postgres runs them as meant and that the cascades take the
 * tags and offer rows along. Skipped without TEST_DATABASE_URL; each run
 * builds its own throwaway schema from prisma/migrations and drops it at the
 * end.
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

import { DELETE, GET } from "../app/api/contacts/route";
import { hashRecipientId } from "../lib/tracking/server";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `contacts_api_${randomBytes(4).toString("hex")}`;
const WORKSPACE = "workspace";
const OTHER_WORKSPACE = "workspace_other";
// One person (one IGSID string) seen by two accounts of the workspace and by
// an account of another workspace: three contacts.
const ANNA = "17841400000000001";
const BEN = "17841400000000002";
let sql: Client;
let db: PrismaClient;

function apiRequest(method: string, query: string) {
  return new NextRequest(`https://app.example.test/api/contacts${query}`, { method });
}

async function listIds(query: string) {
  const response = await GET(apiRequest("GET", query));
  expect(response.status).toBe(200);
  const { data } = await response.json();
  return (data.contacts as { id: string }[]).map((contact) => contact.id).sort();
}

async function seedPerson(contactId: string, workspaceId: string, accountId: string, igsid: string, username: string) {
  await db.contact.create({
    data: {
      id: contactId,
      workspaceId,
      instagramAccountId: accountId,
      igsid,
      username,
      recipientHash: hashRecipientId(igsid),
    },
  });
}

async function seedLog(id: string, workspaceId: string, accountId: string, commenterId: string, commentId: string, commentText: string) {
  await db.dmLog.create({
    data: {
      id,
      workspaceId,
      automationId: `campaign_${accountId}`,
      instagramAccountId: accountId,
      commenterId,
      commenterName: "anna.k",
      commentText,
      commentId,
      status: "SENT",
    },
  });
}

async function seedClick(id: string, workspaceId: string, accountId: string, igsid: string) {
  await db.linkClick.create({
    data: {
      id,
      workspaceId,
      automationId: `campaign_${accountId}`,
      instagramAccountId: accountId,
      trackedLinkId: `link_${accountId}`,
      recipientHash: hashRecipientId(igsid),
    },
  });
}

describe.skipIf(!databaseUrl)("contacts API on a real Postgres", () => {
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

    await db.user.create({ data: { id: "owner", email: "contacts-api@example.test" } });
    for (const [workspaceId, accounts] of [
      [WORKSPACE, ["account", "account_b"]],
      [OTHER_WORKSPACE, ["account_other"]],
    ] as const) {
      await db.workspace.create({ data: { id: workspaceId, name: workspaceId, ownerId: "owner" } });
      for (const account of accounts) {
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
            id: `campaign_${account}`,
            workspaceId,
            instagramAccountId: account,
            name: `Campaign ${account}`,
            keywords: ["PROMPT"],
            dmMessage: "Your link",
          },
        });
        await db.trackedLink.create({
          data: {
            id: `link_${account}`,
            workspaceId,
            automationId: `campaign_${account}`,
            slug: `slug_${account}`,
            destinationUrl: "https://drive.google.com/file/d/abc/view",
          },
        });
      }
    }
    await db.offer.create({
      data: {
        id: "offer",
        workspaceId: WORKSPACE,
        name: "Guide",
        offerMessages: ["Soll ich ihn dir schicken?"],
        offerDelaysSeconds: [0],
        offerButtonLabel: "Ja, gerne!",
        cardTitle: "Guide",
        cardButtonLabel: "Jetzt holen",
        destinationUrl: "https://example.test/guide",
        linkSlug: "offer_slug",
        tagOffered: "Guide angeboten",
        tagInterested: "Guide Interesse",
        tagSent: "[LM] Guide gesendet",
        tagClicked: "Guide geklickt",
      },
    });
  }, 60_000);

  beforeEach(async () => {
    state.context = { workspaceId: WORKSPACE, role: "OWNER" };
    // Each test starts from the same people; their tags and offer rows
    // cascade with them.
    await db.linkClick.deleteMany({});
    await db.dmLog.deleteMany({});
    await db.contact.deleteMany({});

    await seedPerson("anna", WORKSPACE, "account", ANNA, "Anna.K");
    await seedPerson("ben", WORKSPACE, "account", BEN, "ben_m");
    await seedPerson("anna_b", WORKSPACE, "account_b", ANNA, "anna_b");
    await seedPerson("anna_other", OTHER_WORKSPACE, "account_other", ANNA, "anna.k");
    await db.contactTag.createMany({
      data: [
        { workspaceId: WORKSPACE, contactId: "anna", tag: "Guide angeboten" },
        { workspaceId: WORKSPACE, contactId: "anna", tag: "[LM] Prompt gesendet" },
        { workspaceId: WORKSPACE, contactId: "ben", tag: "Guide angeboten" },
        { workspaceId: OTHER_WORKSPACE, contactId: "anna_other", tag: "Guide angeboten" },
      ],
    });
    await db.contactOffer.create({
      data: {
        id: "anna_offer",
        workspaceId: WORKSPACE,
        contactId: "anna",
        offerId: "offer",
        automationId: "campaign_account",
        sentAt: new Date(),
        sentVia: "CARD",
      },
    });

    // Anna on the first account: a comment, a button tap and a DM.
    await seedLog("anna_comment", WORKSPACE, "account", ANNA, "18000000000000001", "Prompt bitte");
    await seedLog("anna_tap", WORKSPACE, "account", ANNA, `reveal:${ANNA}`, "(button tap)");
    await seedLog("anna_dm", WORKSPACE, "account", ANNA, "dm:mid_1", "PROMPT");
    // Everyone else.
    await seedLog("ben_comment", WORKSPACE, "account", BEN, "18000000000000002", "Prompt");
    await seedLog("anna_b_tap", WORKSPACE, "account_b", ANNA, `reveal:${ANNA}`, "(button tap)");
    await seedLog("anna_other_tap", OTHER_WORKSPACE, "account_other", ANNA, `reveal:${ANNA}`, "(button tap)");

    await seedClick("anna_click_1", WORKSPACE, "account", ANNA);
    await seedClick("anna_click_2", WORKSPACE, "account", ANNA);
    await seedClick("ben_click", WORKSPACE, "account", BEN);
    // The same IGSID gives the same ?r= token in another workspace.
    await seedClick("anna_other_click", OTHER_WORKSPACE, "account_other", ANNA);
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("searches handles in any case and IGSIDs whole, within the workspace", async () => {
    expect(await listIds("")).toEqual(["anna", "anna_b", "ben"]);
    expect(await listIds("?q=ANNA")).toEqual(["anna", "anna_b"]);
    expect(await listIds("?q=@anna.k")).toEqual(["anna"]);
    expect(await listIds(`?q=${BEN}`)).toEqual(["ben"]);
    // Part of an IGSID finds nobody.
    expect(await listIds(`?q=${BEN.slice(0, 10)}`)).toEqual([]);
  });

  it("filters by tag and account, and counts the workspace's tags", async () => {
    expect(await listIds("?tag=Guide%20angeboten")).toEqual(["anna", "ben"]);
    expect(await listIds(`?tag=${encodeURIComponent("[LM] Prompt gesendet")}`)).toEqual(["anna"]);
    expect(await listIds("?instagramAccountId=account_b")).toEqual(["anna_b"]);
    expect(await listIds("?instagramAccountId=all&tag=Guide%20angeboten&q=ben")).toEqual(["ben"]);

    const response = await GET(apiRequest("GET", "?view=tags"));
    const { data } = await response.json();
    expect(data.tagCounts).toEqual([
      { tag: "Guide angeboten", count: 2 },
      { tag: "[LM] Prompt gesendet", count: 1 },
    ]);
  });

  it("shows one person's history from their account only", async () => {
    const response = await GET(apiRequest("GET", "?id=anna"));
    expect(response.status).toBe(200);
    const { data } = await response.json();

    expect(data.contact).toMatchObject({ id: "anna", igsid: ANNA, account: "account" });
    expect(data.tags.map((tag: { tag: string }) => tag.tag).sort()).toEqual([
      "Guide angeboten",
      "[LM] Prompt gesendet",
    ]);
    const keys = (data.timeline as { key: string }[]).map((event) => event.key);
    expect(keys.filter((key) => key.startsWith("message:")).sort()).toEqual([
      "message:anna_comment",
      "message:anna_dm",
      "message:anna_tap",
    ]);
    expect(keys.filter((key) => key.startsWith("click:")).sort()).toEqual([
      "click:anna_click_1",
      "click:anna_click_2",
    ]);
    expect(keys).toContain("offer:anna_offer:sent");

    expect((await GET(apiRequest("GET", "?id=anna_other"))).status).toBe(404);
  });

  it("deletes the person, anonymises their DM log rows and leaves everyone else alone", async () => {
    const response = await DELETE(apiRequest("DELETE", "?id=anna"));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      deleted: true,
      anonymisedLogs: 3,
      deletedClicks: 2,
      // Nothing in Diagnostics names them yet (see the next test).
      anonymisedEvents: 0,
      clearedWebhookEvents: 0,
    });

    // The contact goes, and its tags and offer rows with it.
    expect(await db.contact.findUnique({ where: { id: "anna" } })).toBeNull();
    expect(await db.contactTag.count({ where: { contactId: "anna" } })).toBe(0);
    expect(await db.contactOffer.count({ where: { id: "anna_offer" } })).toBe(0);
    // The offer and the campaign stay.
    expect(await db.offer.count({ where: { id: "offer" } })).toBe(1);
    expect(await db.automation.count({ where: { id: "campaign_account" } })).toBe(1);

    // Their DM log rows stay for the counts, without IGSID, name or text.
    // The comment id stays for the dedupe; a tap's id held the IGSID.
    const rows = await db.dmLog.findMany({
      where: { id: { in: ["anna_comment", "anna_tap", "anna_dm"] } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        commenterId: true,
        commenterName: true,
        commentText: true,
        commentId: true,
        status: true,
        automationId: true,
      },
    });
    expect(rows).toEqual([
      { id: "anna_comment", commenterId: "deleted", commenterName: null, commentText: "", commentId: "18000000000000001", status: "SENT", automationId: "campaign_account" },
      { id: "anna_dm", commenterId: "deleted", commenterName: null, commentText: "", commentId: "dm:mid_1", status: "SENT", automationId: "campaign_account" },
      { id: "anna_tap", commenterId: "deleted", commenterName: null, commentText: "", commentId: "deleted:anna_tap", status: "SENT", automationId: "campaign_account" },
    ]);
    expect(JSON.stringify(rows)).not.toContain(ANNA);

    // The same IGSID on another account, or in another workspace, is
    // another contact, and so is Ben.
    expect(
      (await db.dmLog.findMany({
        where: { id: { in: ["ben_comment", "anna_b_tap", "anna_other_tap"] } },
        orderBy: { id: "asc" },
        select: { id: true, commenterId: true, commentId: true },
      }))
    ).toEqual([
      { id: "anna_b_tap", commenterId: ANNA, commentId: `reveal:${ANNA}` },
      { id: "anna_other_tap", commenterId: ANNA, commentId: `reveal:${ANNA}` },
      { id: "ben_comment", commenterId: BEN, commentId: "18000000000000002" },
    ]);
    expect(
      (await db.contact.findMany({ orderBy: { id: "asc" }, select: { id: true } })).map((c) => c.id)
    ).toEqual(["anna_b", "anna_other", "ben"]);

    // Their clicks go; Ben's and the other workspace's stay.
    expect(
      (await db.linkClick.findMany({ orderBy: { id: "asc" }, select: { id: true } })).map((c) => c.id)
    ).toEqual(["anna_other_click", "ben_click"]);

    // Gone is gone.
    expect((await DELETE(apiRequest("DELETE", "?id=anna"))).status).toBe(404);
  });

  it("anonymises what Diagnostics keeps of the person and leaves everyone else's", async () => {
    const jobId = `postback_ig_account_${ANNA}_mid_1`;
    await db.operationalEvent.createMany({
      data: [
        // The worker's events about Anna on the first account.
        { id: "ev_gate", workspaceId: WORKSPACE, source: "WORKER", message: "Follow gate rejected a button tap",
          payload: { automationId: "campaign_account", automationName: "Campaign account", userId: ANNA, commenterName: "anna.k" } },
        { id: "ev_offer", workspaceId: WORKSPACE, source: "WORKER", level: "WARNING", message: "Offer stopped: messaging window closed",
          payload: { contactOfferId: "anna_offer", offerId: "offer", offerName: "Guide", automationId: "campaign_account", userId: ANNA, reason: "WINDOW_CLOSED" } },
        { id: "ev_job", workspaceId: WORKSPACE, source: "WORKER", level: "ERROR", message: `DM worker job ${jobId} failed: boom`,
          payload: { jobId, attemptsMade: 3, instagramAccountId: "ig_account", commentId: null } },
        // Named once more where no key says so: the payload goes.
        { id: "ev_nested", workspaceId: WORKSPACE, source: "WORKER", message: "Offer message delivery unconfirmed",
          payload: { userId: ANNA, error: `Unknown recipient ${ANNA}` } },
        // Everyone else's.
        { id: "ev_ben", workspaceId: WORKSPACE, source: "WORKER", message: "Follow gate rejected a button tap",
          payload: { automationId: "campaign_account", userId: BEN, commenterName: "ben_m" } },
        { id: "ev_sweep", workspaceId: WORKSPACE, source: "SYSTEM", message: 'Comment sweep "Campaign account" [PROMPT]: 1 enqueued',
          payload: { campaign: "Campaign account", enqueued: 1 } },
        { id: "ev_other", workspaceId: OTHER_WORKSPACE, source: "WORKER", message: "Follow gate rejected a button tap",
          payload: { userId: ANNA, commenterName: "anna.k" } },
      ],
    });
    const comment = (account: string, from: string, text: string) => ({
      object: "instagram",
      entry: [{ id: `ig_${account}`, time: 1, changes: [{ field: "comments", value: { id: `c_${from}`, text, from: { id: from, username: "someone" }, media: { id: "media_1" } } }] }],
    });
    const tap = (account: string, from: string) => ({
      object: "instagram",
      entry: [{ id: `ig_${account}`, time: 1, messaging: [{ sender: { id: from }, recipient: { id: `ig_${account}` }, postback: { mid: "mid_1", title: "Ja, schick sie mir", payload: "reveal:campaign_account" } }] }],
    });
    await db.webhookEvent.createMany({
      data: [
        { id: "wh_comment", workspaceId: WORKSPACE, object: "instagram", status: "PROCESSED", payload: comment("account", ANNA, "Prompt bitte") },
        // Meta's button taps are stored without a workspace.
        { id: "wh_tap", object: "instagram", status: "FAILED", errorMessage: "Redis down", payload: tap("account", ANNA) },
        { id: "wh_ben", workspaceId: WORKSPACE, object: "instagram", payload: comment("account", BEN, "Prompt") },
        { id: "wh_anna_b", workspaceId: WORKSPACE, object: "instagram", payload: comment("account_b", ANNA, "Prompt") },
        { id: "wh_other", workspaceId: OTHER_WORKSPACE, object: "instagram", payload: comment("account_other", ANNA, "Prompt") },
        { id: "wh_tap_other", object: "instagram", payload: tap("account_other", ANNA) },
      ],
    });

    const response = await DELETE(apiRequest("DELETE", "?id=anna"));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ anonymisedEvents: 4, clearedWebhookEvents: 2 });

    const events = Object.fromEntries(
      (await db.operationalEvent.findMany({ select: { id: true, message: true, payload: true, level: true } })).map(
        ({ id, ...event }) => [id, event]
      )
    );
    // What the events say about campaigns and offers stays; the person goes.
    expect(events.ev_gate).toEqual({ level: "INFO", message: "Follow gate rejected a button tap",
      payload: { automationId: "campaign_account", automationName: "Campaign account" } });
    expect(events.ev_offer.payload).toEqual({ contactOfferId: "anna_offer", offerId: "offer", offerName: "Guide",
      automationId: "campaign_account", reason: "WINDOW_CLOSED" });
    expect(events.ev_job).toEqual({ level: "ERROR", message: "DM worker job postback_ig_account_deleted_mid_1 failed: boom",
      payload: { jobId: "postback_ig_account_deleted_mid_1", attemptsMade: 3, instagramAccountId: "ig_account", commentId: null } });
    expect(events.ev_nested).toEqual({ level: "INFO", message: "Offer message delivery unconfirmed", payload: null });
    for (const id of ["ev_gate", "ev_offer", "ev_job", "ev_nested"]) {
      expect(JSON.stringify(events[id]), id).not.toMatch(new RegExp(`${ANNA}|anna\\.k`));
    }
    expect(events.ev_ben.payload).toEqual({ automationId: "campaign_account", userId: BEN, commenterName: "ben_m" });
    expect(events.ev_sweep.payload).toEqual({ campaign: "Campaign account", enqueued: 1 });
    expect(events.ev_other.payload).toEqual({ userId: ANNA, commenterName: "anna.k" });

    const webhooks = Object.fromEntries(
      (await db.webhookEvent.findMany({ select: { id: true, payload: true, status: true, errorMessage: true } })).map(
        ({ id, ...webhook }) => [id, webhook]
      )
    );
    // Anna's raw comment and tap on this account are emptied; the rows stay
    // for Diagnostics.
    expect(webhooks.wh_comment).toEqual({ payload: {}, status: "PROCESSED", errorMessage: null });
    expect(webhooks.wh_tap).toEqual({ payload: {}, status: "FAILED", errorMessage: "Redis down" });
    // Ben's, the other account's (the same IGSID string there is another
    // person) and the other workspace's stay as received.
    expect(webhooks.wh_ben.payload).toEqual(comment("account", BEN, "Prompt"));
    expect(webhooks.wh_anna_b.payload).toEqual(comment("account_b", ANNA, "Prompt"));
    expect(webhooks.wh_other.payload).toEqual(comment("account_other", ANNA, "Prompt"));
    expect(webhooks.wh_tap_other.payload).toEqual(tap("account_other", ANNA));
  });

  it("deletes nothing of another workspace", async () => {
    const response = await DELETE(apiRequest("DELETE", "?id=anna_other"));

    expect(response.status).toBe(404);
    expect(await db.contact.count({ where: { id: "anna_other" } })).toBe(1);
    expect(await db.linkClick.count({ where: { id: "anna_other_click" } })).toBe(1);
    expect(
      await db.dmLog.count({ where: { id: "anna_other_tap", commenterId: ANNA } })
    ).toBe(1);
  });

  it("refuses a member and changes nothing", async () => {
    state.context = { workspaceId: WORKSPACE, role: "MEMBER" };

    const response = await DELETE(apiRequest("DELETE", "?id=anna"));

    expect(response.status).toBe(403);
    expect(await db.contact.count({ where: { id: "anna" } })).toBe(1);
    expect(await db.dmLog.count({ where: { commenterId: ANNA, workspaceId: WORKSPACE } })).toBe(4);
    expect(await db.linkClick.count({ where: { workspaceId: WORKSPACE } })).toBe(3);
  });
});
