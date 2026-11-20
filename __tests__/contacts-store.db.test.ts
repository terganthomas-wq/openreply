/**
 * Contact and tag writes against a real Postgres.
 *
 * The unit suite checks what the store asks Prisma for. This one checks what
 * the database makes of it: the upsert on the compound key, the forward-only
 * interaction time and a tag's first timestamp surviving a repeat. Skipped
 * without TEST_DATABASE_URL; each run builds its own throwaway schema from
 * prisma/migrations and drops it at the end.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
}));
vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));

import { addContactTags, ensureContact } from "../lib/contacts/store";
import { hashRecipientId } from "../lib/tracking/server";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `contacts_store_${randomBytes(4).toString("hex")}`;
const workspaceId = "workspace";
let sql: Client;

const EARLIER = new Date("2026-11-20T09:00:00.000Z");
const NOW = new Date("2026-11-20T10:00:00.000Z");
const LATER = new Date("2026-11-20T11:00:00.000Z");

function contactRow(igsid: string, instagramAccountId = "account") {
  return state.db.contact.findUniqueOrThrow({
    where: { instagramAccountId_igsid: { instagramAccountId, igsid } },
  });
}

describe.skipIf(!databaseUrl)("contact store on a real Postgres", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const entry of readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      await sql.query(
        readFileSync(path.join(root, entry.name, "migration.sql"), "utf8"),
      );
    }
    state.db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
    });
    await state.db.user.create({
      data: { id: "user", email: "contacts-store@example.test" },
    });
    await state.db.workspace.create({
      data: { id: workspaceId, name: "Contacts", ownerId: "user" },
    });
    for (const [id, instagramId] of [
      ["account", "ig_store"],
      ["account_other", "ig_store_other"],
    ]) {
      await state.db.instagramAccount.create({
        data: {
          id,
          workspaceId,
          instagramId,
          username: instagramId,
          accessToken: "local-test-only",
        },
      });
    }
  });

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("creates the contact from a comment, without an interaction time", async () => {
    const contact = await ensureContact({
      workspaceId,
      instagramAccountId: "account",
      igsid: "commenter",
      username: "reader",
    });

    expect(contact).toEqual({
      id: expect.any(String),
      username: "reader",
      lastInteractionAt: null,
    });
    await expect(contactRow("commenter")).resolves.toMatchObject({
      workspaceId,
      recipientHash: hashRecipientId("commenter"),
      lastInteractionAt: null,
    });
  });

  it("keeps the name on a nameless tap and moves the interaction only forward", async () => {
    const created = await ensureContact({
      workspaceId,
      instagramAccountId: "account",
      igsid: "tapper",
      username: "tapper_handle",
    });
    const before = await contactRow("tapper");

    const tapped = await ensureContact({
      workspaceId,
      instagramAccountId: "account",
      igsid: "tapper",
      interactionAt: NOW,
    });
    expect(tapped).toEqual({
      id: created.id,
      username: "tapper_handle",
      lastInteractionAt: NOW,
    });
    const after = await contactRow("tapper");
    expect(after.lastInteractionAt).toEqual(NOW);
    // Every write counts as "last seen".
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime(),
    );

    // A job that finishes late must not move the time back.
    await ensureContact({
      workspaceId,
      instagramAccountId: "account",
      igsid: "tapper",
      interactionAt: EARLIER,
    });
    await expect(contactRow("tapper")).resolves.toMatchObject({
      lastInteractionAt: NOW,
      username: "tapper_handle",
    });

    await ensureContact({
      workspaceId,
      instagramAccountId: "account",
      igsid: "tapper",
      interactionAt: LATER,
    });
    await expect(contactRow("tapper")).resolves.toMatchObject({
      lastInteractionAt: LATER,
    });
  });

  it("stamps a contact created by a DM in the same write", async () => {
    await expect(
      ensureContact({
        workspaceId,
        instagramAccountId: "account",
        igsid: "writer",
        interactionAt: NOW,
      }),
    ).resolves.toMatchObject({ username: null, lastInteractionAt: NOW });
  });

  it("keeps one contact per connected account", async () => {
    const first = await ensureContact({
      workspaceId,
      instagramAccountId: "account",
      igsid: "shared_igsid",
    });
    const again = await ensureContact({
      workspaceId,
      instagramAccountId: "account",
      igsid: "shared_igsid",
    });
    const otherAccount = await ensureContact({
      workspaceId,
      instagramAccountId: "account_other",
      igsid: "shared_igsid",
    });

    expect(again.id).toBe(first.id);
    expect(otherAccount.id).not.toBe(first.id);
  });

  it("keeps the time a tag was first set when it is added again", async () => {
    const contact = await ensureContact({
      workspaceId,
      instagramAccountId: "account",
      igsid: "tagged",
    });

    await expect(
      addContactTags(workspaceId, contact.id, [" [LM] Guide sent ", "VIP"]),
    ).resolves.toBe(2);
    const first = await state.db.contactTag.findUniqueOrThrow({
      where: { contactId_tag: { contactId: contact.id, tag: "[LM] Guide sent" } },
    });

    await expect(
      addContactTags(workspaceId, contact.id, ["[LM] Guide sent", "Buyer"]),
    ).resolves.toBe(1);

    const tags = await state.db.contactTag.findMany({
      where: { contactId: contact.id },
    });
    // Sorted here, not by the database, whose collation decides where "["
    // goes.
    expect(tags.map((t) => t.tag).sort()).toEqual([
      "Buyer",
      "VIP",
      "[LM] Guide sent",
    ]);
    expect(tags.find((t) => t.tag === "[LM] Guide sent")?.createdAt).toEqual(
      first.createdAt,
    );
  });
});
