/**
 * Sign-up feedback from the landing page, against a real Postgres.
 *
 * The migration must give every existing offer a "signed up" tag built like
 * its other tags and leave the feedback off, so links and sends stay as they
 * were. A person's code must be unique, created once on the first click and
 * the same on every later one. A report must record the sign-up and its tag
 * once, only in the key's workspace and only while the offer reports
 * sign-ups, and the chat confirmation must go out once, under a real claim.
 * Deleting the contact (GDPR) must take the code along, so a later report of
 * it is unknown. Instagram, the token, the usage counter, the rate limiter
 * and the queue are replaced. Skipped without TEST_DATABASE_URL; each run
 * builds its own throwaway schema from prisma/migrations and drops it at the
 * end.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Job } from "bullmq";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  context: null as { workspaceId: string; role: "OWNER" | "ADMIN" | "MEMBER" } | null,
}));
const { mockQueueAdd, mockEval, mockSendDirectMessage, afterCallbacks } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockEval: vi.fn(),
  mockSendDirectMessage: vi.fn(),
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
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd, remove: vi.fn() }),
  OFFER_JOB_NAME: "process-offer",
}));
// The service keys' rate limiter.
vi.mock("ioredis", () => ({
  default: class {
    status = "ready";
    eval = mockEval;
    listenerCount() {
      return 1;
    }
  },
}));
// after() runs once the response is out: collected, and run by the test.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => {
    afterCallbacks.push(callback);
  },
}));
// Closed: a Meta function the engine starts to use without a mock here fails
// the suite instead of calling Instagram.
vi.mock("@/lib/meta/client", () => {
  class MetaApiError extends Error {
    code: number;
    constructor(code: number, _subcode: number | undefined, _trace: string | undefined, message: string) {
      super(message);
      this.code = code;
      this.name = "MetaApiError";
    }
  }
  class TokenExpiredError extends MetaApiError {}
  class RateLimitError extends MetaApiError {}
  return {
    sendDirectMessage: mockSendDirectMessage,
    sendDirectMessageWithButton: vi.fn(),
    sendDirectMessageWithLinkButton: vi.fn(),
    sendDirectMessageWithCard: vi.fn(),
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

import { DELETE as deleteContact } from "../app/api/contacts/route";
import { POST as reportSignup } from "../app/api/offers/signup/route";
import { GET as openOffer } from "../app/o/[slug]/route";
import { hashServiceToken } from "../lib/integrations/auth";
import { processOffer } from "../lib/offers/worker";
import type { ProcessOfferJob } from "../lib/queue/client";
import { hashRecipientId } from "../lib/tracking/server";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");
const SIGNUP_MIGRATION = "20261121160000_offer_signup_feedback";
const schema = `offers_signup_${randomBytes(4).toString("hex")}`;
const WORKSPACE = "workspace";
const OTHER_WORKSPACE = "workspace_other";
const KEY = `orp_${"s".repeat(43)}`;
const OTHER_KEY = `orp_${"o".repeat(43)}`;
const LONG_NAME = "x".repeat(95);
const BROWSER =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101";
let sql: Client;
let db: PrismaClient;
// The offers' updatedAt before the migration, as Postgres writes it.
let updatedAtBefore: string[];

function migrationSql(dir: string) {
  return readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
}

/** A person who got the offer `offerId`, tapped a minute ago and has no code yet. */
async function personWithOffer(igsid: string, offerId = "offer_guide", workspaceId = WORKSPACE) {
  const contact = await db.contact.create({
    data: {
      workspaceId,
      instagramAccountId: workspaceId === WORKSPACE ? "account" : "account_other",
      igsid,
      username: `user_${igsid}`,
      recipientHash: hashRecipientId(igsid),
      lastInteractionAt: new Date(Date.now() - 60_000),
    },
  });
  const row = await db.contactOffer.create({
    data: {
      workspaceId,
      contactId: contact.id,
      offerId,
      startKey: `campaign:tap:mid_${igsid}`,
      interestedAt: new Date(Date.now() - 60_000),
      sentAt: new Date(Date.now() - 50_000),
      sentVia: "CARD",
    },
  });
  return { contact, row };
}

async function click(slug: string, igsid: string) {
  const response = await openOffer(
    new NextRequest(`https://app.example.test/o/${slug}?r=${hashRecipientId(igsid)}`, {
      headers: { "user-agent": BROWSER },
    }),
    { params: Promise.resolve({ slug }) }
  );
  for (const callback of afterCallbacks.splice(0)) await callback();
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

function report(token: string, key = KEY) {
  return reportSignup(
    new Request("https://app.example.test/api/offers/signup", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
  );
}

function signupJob(contactOfferId: string): Job<ProcessOfferJob> {
  return {
    name: "process-offer",
    id: `offer_${contactOfferId}_signup`,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    data: {
      workspaceId: WORKSPACE,
      accountConnectionId: "account",
      instagramAccountId: "ig_signup",
      phase: "signup",
      contactOfferId,
    },
  } as unknown as Job<ProcessOfferJob>;
}

describe.skipIf(!databaseUrl)("sign-up feedback on a real Postgres", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);

    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toContain(SIGNUP_MIGRATION);
    for (const dir of dirs.filter((d) => d < SIGNUP_MIGRATION)) {
      await sql.query(migrationSql(dir));
    }
    // What production holds before the migration: offers in German and in
    // English, one with a name as long as names may be, and a person's row.
    await sql.query(`
      INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('owner', 'offers-signup@example.test', now());
      INSERT INTO "Workspace" ("id", "name", "ownerId", "updatedAt") VALUES
        ('${WORKSPACE}', 'Sign-ups', 'owner', now()), ('${OTHER_WORKSPACE}', 'Other', 'owner', now());
      INSERT INTO "InstagramAccount" ("id", "workspaceId", "instagramId", "username", "accessToken", "updatedAt") VALUES
        ('account', '${WORKSPACE}', 'ig_signup', 'brand', 'local-test-only', now()),
        ('account_other', '${OTHER_WORKSPACE}', 'ig_other', 'other', 'local-test-only', now());
      INSERT INTO "Offer" ("id", "workspaceId", "name", "offerMessages", "offerDelaysSeconds", "offerButtonLabel",
          "cardTitle", "cardButtonLabel", "destinationUrl", "linkSlug", "reminderMessage",
          "tagOffered", "tagInterested", "tagSent", "tagClicked", "updatedAt") VALUES
        ('offer_guide', '${WORKSPACE}', 'Guide', '{"Soll ich ihn dir schicken?"}', '{0}', 'Ja, gerne!',
          'Guide', 'Jetzt holen', 'https://landing.example/guide?utm_source=instagram#formular', 'slug_guide', 'Hol ihn dir 👇',
          'Guide angeboten', 'Guide Interesse', '[LM] Guide gesendet', 'Guide geklickt', '2026-11-01 10:00:00'),
        ('offer_checklist', '${WORKSPACE}', 'Checklist', '{"Want my checklist?"}', '{0}', 'Yes please',
          'Checklist', 'Get it', 'https://example.test/checklist', 'slug_checklist', NULL,
          'Checklist offered', 'Checklist interested', 'Checklist sent', 'Checklist clicked', '2026-11-01 10:00:00'),
        ('offer_long', '${WORKSPACE}', '${LONG_NAME}', '{"Hi"}', '{0}', 'Ja',
          'Long', 'Holen', 'https://example.test/long', 'slug_long', NULL,
          '${LONG_NAME} angeboten', 'i', 's', 'c', '2026-11-01 10:00:00'),
        ('offer_other', '${OTHER_WORKSPACE}', 'Other guide', '{"Hi"}', '{0}', 'Ja',
          'Other', 'Holen', 'https://example.test/other', 'slug_other', NULL,
          'Other angeboten', 'i', 's', 'c', '2026-11-01 10:00:00');
      INSERT INTO "Contact" ("id", "workspaceId", "instagramAccountId", "igsid", "recipientHash", "lastInteractionAt", "updatedAt")
        VALUES ('contact_legacy', '${WORKSPACE}', 'account', 'igsid_legacy', 'hash_legacy', now(), now());
      INSERT INTO "ContactOffer" ("id", "workspaceId", "contactId", "offerId", "startKey")
        VALUES ('co_legacy', '${WORKSPACE}', 'contact_legacy', 'offer_guide', 'campaign:tap:mid_legacy');
    `);
    updatedAtBefore = (
      await sql.query(`SELECT "updatedAt"::text AS at FROM "Offer" ORDER BY "id"`)
    ).rows.map((row) => row.at);
    for (const dir of dirs.filter((d) => d >= SIGNUP_MIGRATION)) {
      await sql.query(migrationSql(dir));
    }

    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }) });
    state.db = db;
    // The landing pages' keys: one per workspace, sign-ups only.
    for (const [id, workspaceId, token] of [
      ["key_signups", WORKSPACE, KEY],
      ["key_other", OTHER_WORKSPACE, OTHER_KEY],
    ]) {
      await db.serviceKey.create({
        data: {
          id,
          workspaceId,
          name: "Landingpage",
          tokenHash: hashServiceToken(token),
          scopes: ["signups:write"],
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
        },
      });
    }
  }, 60_000);

  beforeEach(() => {
    state.db = db;
    state.context = { workspaceId: WORKSPACE, role: "OWNER" };
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("NEXTAUTH_URL", "https://app.example.test");
    afterCallbacks.length = 0;
    mockEval.mockReset().mockResolvedValue(1);
    mockQueueAdd.mockReset().mockResolvedValue({});
    mockSendDirectMessage
      .mockReset()
      .mockResolvedValue({ recipient_id: "person", message_id: "m_1" });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("gives existing offers their signed-up tag and leaves the feedback off", async () => {
    const offers = await db.offer.findMany({ orderBy: { id: "asc" } });
    const byId = new Map(offers.map((offer) => [offer.id, offer]));

    expect(byId.get("offer_guide")).toMatchObject({
      tagSignedUp: "Guide eingetragen",
      signupTrackingEnabled: false,
      signupMessage: null,
    });
    expect(byId.get("offer_checklist")!.tagSignedUp).toBe("Checklist signed up");
    // Cut to the 100 characters a tag may have, with no space left at the end.
    const long = byId.get("offer_long")!.tagSignedUp;
    expect(Array.from(long)).toHaveLength(100);
    expect(long).toBe(`${LONG_NAME} eing`);
    // The offers themselves did not change.
    expect(
      (await sql.query(`SELECT "updatedAt"::text AS at FROM "Offer" ORDER BY "id"`)).rows.map((row) => row.at)
    ).toEqual(updatedAtBefore);

    expect(await db.contactOffer.findUniqueOrThrow({ where: { id: "co_legacy" } })).toMatchObject({
      signupToken: null,
      signedUpAt: null,
      signupMessageSentAt: null,
    });

    // An offer the previous web app writes, without the columns.
    await sql.query(`
      INSERT INTO "Offer" ("id", "workspaceId", "name", "offerMessages", "offerDelaysSeconds", "offerButtonLabel",
          "cardTitle", "cardButtonLabel", "destinationUrl", "linkSlug", "tagOffered", "tagInterested", "tagSent", "tagClicked", "updatedAt")
        VALUES ('offer_old_app', '${WORKSPACE}', 'Old', '{"Hi"}', '{0}', 'Ja', 'Old', 'Holen', 'https://example.test/old', 'slug_old',
          'o', 'i', 's', 'c', now());
    `);
    expect(await db.offer.findUniqueOrThrow({ where: { id: "offer_old_app" } })).toMatchObject({
      tagSignedUp: "",
      signupTrackingEnabled: false,
      signupMessage: null,
    });

    const { rows } = await sql.query(
      `SELECT table_name, column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1
          AND column_name IN ('signupTrackingEnabled', 'signupMessage', 'tagSignedUp', 'signupToken', 'signedUpAt', 'signupMessageSentAt')
        ORDER BY table_name, column_name`,
      [schema]
    );
    expect(rows).toEqual([
      { table_name: "ContactOffer", column_name: "signedUpAt", is_nullable: "YES", column_default: null },
      { table_name: "ContactOffer", column_name: "signupMessageSentAt", is_nullable: "YES", column_default: null },
      { table_name: "ContactOffer", column_name: "signupToken", is_nullable: "YES", column_default: null },
      { table_name: "Offer", column_name: "signupMessage", is_nullable: "YES", column_default: null },
      { table_name: "Offer", column_name: "signupTrackingEnabled", is_nullable: "NO", column_default: "false" },
      { table_name: "Offer", column_name: "tagSignedUp", is_nullable: "NO", column_default: "''::text" },
    ]);
  });

  it("keeps every code unique, and any number of rows without one", async () => {
    const { rows } = await sql.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'ContactOffer_signupToken_key'`,
      [schema]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/^CREATE UNIQUE INDEX/);

    const first = await personWithOffer("igsid_unique_1");
    const second = await personWithOffer("igsid_unique_2");
    // Rows without a code never collide.
    await personWithOffer("igsid_unique_3");
    const code = "UnIqUe_CoDe_0123456789ab";
    await db.contactOffer.update({ where: { id: first.row.id }, data: { signupToken: code } });

    await expect(
      db.contactOffer.update({ where: { id: second.row.id }, data: { signupToken: code } })
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await db.contactOffer.count({ where: { signupToken: code } })).toBe(1);
    expect(await db.contactOffer.count({ where: { signupToken: null, offerId: "offer_guide" } })).toBeGreaterThanOrEqual(2);
  });

  it("creates the code on the first click and adds the same one to the link every time", async () => {
    await db.offer.update({ where: { id: "offer_guide" }, data: { signupTrackingEnabled: true } });
    const { row } = await personWithOffer("igsid_click");

    const first = await click("slug_guide", "igsid_click");
    const stored = await db.contactOffer.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.signupToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(first.href).toBe(
      `https://landing.example/guide?utm_source=instagram&ig=${stored.signupToken}#formular`
    );
    // The click is recorded as before, with its tag.
    expect(stored.clickedAt).not.toBeNull();

    const again = await click("slug_guide", "igsid_click");
    expect(again.searchParams.get("ig")).toBe(stored.signupToken);
    expect((await db.contactOffer.findUniqueOrThrow({ where: { id: row.id } })).signupToken).toBe(
      stored.signupToken
    );

    // Somebody who did not get the offer: the link as typed.
    const stranger = await click("slug_guide", "igsid_stranger");
    expect(stranger.href).toBe("https://landing.example/guide?utm_source=instagram#formular");
  });

  it("adds nothing and creates no code for an offer that does not report sign-ups", async () => {
    const { row } = await personWithOffer("igsid_untracked", "offer_checklist");

    const location = await click("slug_checklist", "igsid_untracked");

    expect(location.href).toBe("https://example.test/checklist");
    expect((await db.contactOffer.findUniqueOrThrow({ where: { id: row.id } })).signupToken).toBeNull();
  });

  it("records a reported sign-up once, with its tag, and queues one confirmation", async () => {
    await db.offer.update({
      where: { id: "offer_guide" },
      data: { signupTrackingEnabled: true, signupMessage: "Danke fürs Eintragen, {username}! 📩" },
    });
    const { contact, row } = await personWithOffer("igsid_report");
    const code = (await click("slug_guide", "igsid_report")).searchParams.get("ig")!;

    const response = await report(code);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { alreadyRecorded: false } });
    const recorded = await db.contactOffer.findUniqueOrThrow({ where: { id: row.id } });
    expect(recorded.signedUpAt).not.toBeNull();
    expect(
      (await db.contactTag.findMany({ where: { contactId: contact.id } })).map((t) => t.tag).sort()
    ).toEqual(["Guide eingetragen", "Guide geklickt"]);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-offer",
      expect.objectContaining({ phase: "signup", contactOfferId: row.id, workspaceId: WORKSPACE }),
      { jobId: `offer_${row.id}_signup`, removeOnComplete: true }
    );
    // The key was used.
    expect((await db.serviceKey.findUniqueOrThrow({ where: { id: "key_signups" } })).lastUsedAt).not.toBeNull();

    // The same report again: nothing changes.
    const repeated = await report(code);
    expect(await repeated.json()).toEqual({ data: { alreadyRecorded: true } });
    expect((await db.contactOffer.findUniqueOrThrow({ where: { id: row.id } })).signedUpAt).toEqual(
      recorded.signedUpAt
    );
    expect(await db.contactTag.count({ where: { contactId: contact.id, tag: "Guide eingetragen" } })).toBe(1);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    // The confirmation, under a real claim: once, and never again.
    await processOffer(signupJob(row.id));
    await processOffer(signupJob(row.id));
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage.mock.calls[0][3]).toBe("Danke fürs Eintragen, user_igsid_report! 📩");
    const confirmed = await db.contactOffer.findUniqueOrThrow({ where: { id: row.id } });
    expect(confirmed.signupMessageSentAt).not.toBeNull();
    // Even when the time was lost after the send, the claim holds.
    await db.contactOffer.update({ where: { id: row.id }, data: { signupMessageSentAt: null } });
    await processOffer(signupJob(row.id));
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect((await db.contactOffer.findUniqueOrThrow({ where: { id: row.id } })).signupMessageSentAt).not.toBeNull();
  });

  it("knows codes only in the key's workspace and while the offer reports sign-ups", async () => {
    await db.offer.update({ where: { id: "offer_guide" }, data: { signupTrackingEnabled: true } });
    const { row } = await personWithOffer("igsid_foreign");
    const code = (await click("slug_guide", "igsid_foreign")).searchParams.get("ig")!;

    // Another workspace's key.
    const foreign = await report(code, OTHER_KEY);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "Unknown token" });

    // The offer stopped reporting sign-ups.
    await db.offer.update({ where: { id: "offer_guide" }, data: { signupTrackingEnabled: false } });
    expect((await report(code)).status).toBe(404);
    expect((await db.contactOffer.findUniqueOrThrow({ where: { id: row.id } })).signedUpAt).toBeNull();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("forgets the code with the contact, so a later report of it is unknown", async () => {
    await db.offer.update({
      where: { id: "offer_guide" },
      data: { signupTrackingEnabled: true, signupMessage: "Danke! 📩" },
    });
    const { contact, row } = await personWithOffer("igsid_gdpr");
    const code = (await click("slug_guide", "igsid_gdpr")).searchParams.get("ig")!;
    expect((await report(code)).status).toBe(200);
    // A confirmation job that ran once: Diagnostics names the person.
    await processOffer(signupJob(row.id));
    await processOffer(signupJob(row.id));
    const named = await db.operationalEvent.findMany({
      where: { workspaceId: WORKSPACE, message: "Sign-up confirmation not sent: it went out before" },
    });
    expect(JSON.stringify(named)).toContain("igsid_gdpr");

    // Deleted on request.
    const deleted = await deleteContact(
      new NextRequest(`https://app.example.test/api/contacts?id=${contact.id}`, { method: "DELETE" })
    );
    expect(deleted.status).toBe(200);

    expect(await db.contactOffer.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await db.contactOffer.count({ where: { signupToken: code } })).toBe(0);
    const response = await report(code);
    expect(response.status).toBe(404);
    // A confirmation still queued finds nothing to send.
    mockSendDirectMessage.mockClear();
    await processOffer(signupJob(row.id));
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    // Diagnostics no longer names the person.
    const events = await db.operationalEvent.findMany({ where: { workspaceId: WORKSPACE } });
    expect(JSON.stringify(events)).not.toContain("igsid_gdpr");
  });
});
