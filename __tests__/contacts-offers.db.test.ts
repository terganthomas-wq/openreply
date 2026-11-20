/**
 * Contacts, tags and offers, tested against a real Postgres.
 *
 * "Never offer twice", "one start per contact and campaign" and the cleanup
 * on disconnect are enforced by unique indexes and foreign keys, which no
 * mock reproduces, so this suite needs a database and is skipped without one
 * (TEST_DATABASE_URL, as in tracked-link-order.db.test.ts).
 *
 * Each run builds the schema from prisma/migrations inside its own throwaway
 * Postgres schema and drops it at the end, so it never touches existing data.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");
const CONTACTS_MIGRATION = "20261120120000_contacts_offers";
const schema = `contacts_offers_${randomBytes(4).toString("hex")}`;
const workspaceId = "workspace";
let sql: Client;
let db: PrismaClient;

function migrationSql(dir: string) {
  return readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
}

function createContact(id: string, igsid: string, instagramAccountId = "account") {
  return db.contact.create({
    data: { id, workspaceId, instagramAccountId, igsid, recipientHash: `hash_${igsid}` },
  });
}

function createOffer(id: string, options: { workspaceId?: string; linkSlug?: string } = {}) {
  return db.offer.create({
    data: {
      id,
      workspaceId: options.workspaceId ?? workspaceId,
      name: id,
      offerMessages: ["Want the guide?"],
      offerDelaysSeconds: [5],
      offerButtonLabel: "Yes, please",
      cardTitle: "Guide",
      cardButtonLabel: "Download",
      destinationUrl: "https://example.test/guide",
      linkSlug: options.linkSlug ?? `slug_${id}`,
      tagOffered: `${id} offered`,
      tagInterested: `${id} interested`,
      tagSent: `${id} sent`,
      tagClicked: `${id} clicked`,
    },
  });
}

function createContactOffer(contactId: string, offerId: string, automationId: string | null) {
  return db.contactOffer.create({ data: { workspaceId, contactId, offerId, automationId } });
}

function createCampaign(id: string, instagramAccountId = "account") {
  return db.automation.create({
    data: { id, workspaceId, instagramAccountId, name: id, keywords: ["GUIDE"], dmMessage: "Your link" },
  });
}

/** Resolves to the message of the P2002 error the write must fail with. */
async function uniqueViolation(write: PromiseLike<unknown>) {
  const error = await write.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toMatchObject({ code: "P2002" });
  return (error as Error).message;
}

describe.skipIf(!databaseUrl)("contacts, tags and offers on a real Postgres", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);

    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toContain(CONTACTS_MIGRATION);
    for (const dir of dirs.filter((d) => d < CONTACTS_MIGRATION)) {
      await sql.query(migrationSql(dir));
    }
    // Rows that exist in production before the migration runs. The campaign
    // must come out of it behaving exactly as before.
    await sql.query(`
      INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('owner', 'contacts@example.test', now());
      INSERT INTO "Workspace" ("id", "name", "ownerId", "updatedAt") VALUES ('${workspaceId}', 'Contacts', 'owner', now());
      INSERT INTO "InstagramAccount" ("id", "workspaceId", "instagramId", "username", "accessToken", "updatedAt")
        VALUES ('account', '${workspaceId}', 'ig_contacts', 'contacts', 'local-test-only', now());
      INSERT INTO "Automation" ("id", "workspaceId", "instagramAccountId", "name", "keywords", "dmMessage", "requireFollow", "followPromptMessage", "updatedAt")
        VALUES ('campaign', '${workspaceId}', 'account', 'Legacy', '{GUIDE}', 'Your link', true, 'Follow me first', now());
    `);
    for (const dir of dirs.filter((d) => d >= CONTACTS_MIGRATION)) {
      await sql.query(migrationSql(dir));
    }

    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
    });
    await db.instagramAccount.create({
      data: {
        id: "account_other",
        workspaceId,
        instagramId: "ig_contacts_other",
        username: "contacts_other",
        accessToken: "local-test-only",
      },
    });
    await createCampaign("campaign_b");
    for (const id of ["offer_a", "offer_b"]) await createOffer(id);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("leaves existing campaigns and workspaces as they behaved before", async () => {
    expect(await db.automation.findUniqueOrThrow({ where: { id: "campaign" } })).toMatchObject({
      requireFollow: true,
      followPromptMessage: "Follow me first",
      ignoreQuestionComments: false,
      followPromptRetryMessage: null,
      followPromptRetryButtonLabel: null,
      deliveryTag: null,
      offersEnabled: false,
      offerIds: [],
    });
    expect(
      (await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).messageDefaults,
    ).toBeNull();
  });

  it("keeps one contact per connected account and Instagram user", async () => {
    await createContact("contact_unique", "igsid_unique");
    expect(await uniqueViolation(createContact("contact_unique_again", "igsid_unique"))).toContain(
      "Contact_instagramAccountId_igsid_key",
    );
    // The same person seen through another connected account is another contact.
    await createContact("contact_unique_other", "igsid_unique", "account_other");
  });

  it("records a tag once and keeps the time it was first set", async () => {
    await createContact("contact_tags", "igsid_tags");
    const firstSet = new Date("2026-01-01T00:00:00.000Z");
    await db.contactTag.create({
      data: { workspaceId, contactId: "contact_tags", tag: "Guide sent", createdAt: firstSet },
    });
    expect(
      await uniqueViolation(
        db.contactTag.create({ data: { workspaceId, contactId: "contact_tags", tag: "Guide sent" } }),
      ),
    ).toContain("ContactTag_contactId_tag_key");
    // Retried deliveries add their tags with skipDuplicates.
    await db.contactTag.createMany({
      data: [
        { workspaceId, contactId: "contact_tags", tag: "Guide sent" },
        { workspaceId, contactId: "contact_tags", tag: "Guide clicked" },
      ],
      skipDuplicates: true,
    });
    const tags = await db.contactTag.findMany({
      where: { contactId: "contact_tags" },
      orderBy: { tag: "asc" },
    });
    expect(tags.map((t) => t.tag)).toEqual(["Guide clicked", "Guide sent"]);
    expect(tags[1].createdAt).toEqual(firstSet);
  });

  it("keeps offer link slugs unique across workspaces", async () => {
    // /o/<slug> resolves the offer before it knows the workspace.
    await db.workspace.create({ data: { id: "workspace_slug", name: "Slug", ownerId: "owner" } });
    expect(
      await uniqueViolation(
        createOffer("offer_slug", { workspaceId: "workspace_slug", linkSlug: "slug_offer_a" }),
      ),
    ).toContain("Offer_linkSlug_key");
  });

  it("never offers the same offer to a contact twice, whichever campaign starts it", async () => {
    await createContact("contact_once", "igsid_once");
    await createContactOffer("contact_once", "offer_a", "campaign");
    expect(await uniqueViolation(createContactOffer("contact_once", "offer_a", "campaign_b"))).toContain(
      "ContactOffer_contactId_offerId_key",
    );
    expect(await uniqueViolation(createContactOffer("contact_once", "offer_a", null))).toContain(
      "ContactOffer_contactId_offerId_key",
    );
  });

  it("starts at most one offer per contact and campaign", async () => {
    await createContact("contact_campaign", "igsid_campaign");
    await createContactOffer("contact_campaign", "offer_a", "campaign");
    expect(await uniqueViolation(createContactOffer("contact_campaign", "offer_b", "campaign"))).toContain(
      "ContactOffer_contactId_automationId_key",
    );
    // Another campaign starts the next offer for the same person.
    await createContactOffer("contact_campaign", "offer_b", "campaign_b");
  });

  it("lets offer rows without a campaign coexist for one contact", async () => {
    await createContact("contact_no_campaign", "igsid_no_campaign");
    await createContactOffer("contact_no_campaign", "offer_a", null);
    await createContactOffer("contact_no_campaign", "offer_b", null);
    expect(
      await db.contactOffer.count({ where: { contactId: "contact_no_campaign", automationId: null } }),
    ).toBe(2);
  });

  it("keeps the contact, its tags and its offer history when the campaign is deleted", async () => {
    await createCampaign("campaign_deleted");
    await createContact("contact_history", "igsid_history");
    await db.contactTag.create({ data: { workspaceId, contactId: "contact_history", tag: "Guide sent" } });
    // An earlier row already lost its campaign, so the delete adds a second NULL.
    await createContactOffer("contact_history", "offer_a", null);
    await createContactOffer("contact_history", "offer_b", "campaign_deleted");

    await db.automation.delete({ where: { id: "campaign_deleted" } });

    const rows = await db.contactOffer.findMany({
      where: { contactId: "contact_history" },
      orderBy: { offerId: "asc" },
    });
    expect(rows.map((r) => [r.offerId, r.automationId])).toEqual([
      ["offer_a", null],
      ["offer_b", null],
    ]);
    expect(await db.contact.count({ where: { id: "contact_history" } })).toBe(1);
    expect(await db.contactTag.count({ where: { contactId: "contact_history" } })).toBe(1);
  });

  it("removes an account's contacts with their tags and offer rows when it is disconnected", async () => {
    await db.instagramAccount.create({
      data: {
        id: "account_gone",
        workspaceId,
        instagramId: "ig_contacts_gone",
        username: "contacts_gone",
        accessToken: "local-test-only",
      },
    });
    await createCampaign("campaign_gone", "account_gone");
    await createContact("contact_gone", "igsid_gone", "account_gone");
    await db.contactTag.create({ data: { workspaceId, contactId: "contact_gone", tag: "Guide offered" } });
    await createContactOffer("contact_gone", "offer_a", "campaign_gone");
    await createContact("contact_kept", "igsid_gone");

    // Disconnecting hard-deletes the account row.
    await db.instagramAccount.delete({ where: { id: "account_gone" } });

    expect(await db.contact.findMany({ where: { igsid: "igsid_gone" }, select: { id: true } })).toEqual([
      { id: "contact_kept" },
    ]);
    expect(await db.contactTag.count({ where: { contactId: "contact_gone" } })).toBe(0);
    expect(await db.contactOffer.count({ where: { contactId: "contact_gone" } })).toBe(0);
    // Offers belong to the workspace and stay.
    expect(await db.offer.count({ where: { id: "offer_a" } })).toBe(1);
  });

  it("removes contacts, tags, offers and offer rows with their workspace", async () => {
    const gone = "workspace_gone";
    await db.workspace.create({ data: { id: gone, name: "Gone", ownerId: "owner" } });
    await db.instagramAccount.create({
      data: {
        id: "account_workspace_gone",
        workspaceId: gone,
        instagramId: "ig_workspace_gone",
        username: "workspace_gone",
        accessToken: "local-test-only",
      },
    });
    await db.contact.create({
      data: {
        id: "contact_workspace_gone",
        workspaceId: gone,
        instagramAccountId: "account_workspace_gone",
        igsid: "igsid_workspace_gone",
        recipientHash: "hash_workspace_gone",
      },
    });
    await db.contactTag.create({
      data: { workspaceId: gone, contactId: "contact_workspace_gone", tag: "Guide sent" },
    });
    await createOffer("offer_workspace_gone", { workspaceId: gone });
    await db.contactOffer.create({
      data: { workspaceId: gone, contactId: "contact_workspace_gone", offerId: "offer_workspace_gone" },
    });

    await db.workspace.delete({ where: { id: gone } });

    const where = { workspaceId: gone };
    expect(await db.contact.count({ where })).toBe(0);
    expect(await db.contactTag.count({ where })).toBe(0);
    expect(await db.offer.count({ where })).toBe(0);
    expect(await db.contactOffer.count({ where })).toBe(0);
  });
});
