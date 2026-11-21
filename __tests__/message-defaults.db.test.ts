/**
 * The workspace message defaults route against a real Postgres.
 *
 * The first read seeds the JSONB column only while it is SQL NULL
 * (messageDefaults: { equals: Prisma.DbNull }), and a reset writes SQL NULL
 * again. The mocked suite (message-defaults-route) proves which statements
 * the route sends; only a database shows that the guard matches NULL and
 * nothing else, and that the texts (emoji, German quotes, line breaks) come
 * back as they went in. Skipped without TEST_DATABASE_URL; each run builds
 * its own throwaway schema from prisma/migrations and drops it at the end.
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
  locale: "de" as string,
  // The workspace row as the request loaded it, when a test needs it stale.
  snapshot: undefined as unknown,
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
// The signed-in context loads the workspace row, as the real one does.
vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () =>
    state.context && {
      ...state.context,
      userId: "owner",
      workspace:
        state.snapshot ??
        (await state.db.workspace.findUniqueOrThrow({ where: { id: state.context.workspaceId } })),
    },
}));
vi.mock("@/lib/i18n/server", () => ({
  getI18n: async () => ({ locale: state.locale }),
}));

import { DELETE, GET, PUT } from "../app/api/workspace/message-defaults/route";
import {
  BUILT_IN_MESSAGE_DEFAULTS,
  EMPTY_MESSAGE_DEFAULTS,
  type MessageDefaults,
} from "../lib/campaigns/message-defaults";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `message_defaults_${randomBytes(4).toString("hex")}`;
const WORKSPACE = "workspace";
const OTHER_WORKSPACE = "workspace_other";
const german = BUILT_IN_MESSAGE_DEFAULTS.de as MessageDefaults;
let sql: Client;
let db: PrismaClient;

async function read() {
  const response = await GET();
  expect(response.status).toBe(200);
  return (await response.json()).data.defaults as MessageDefaults | null;
}

async function save(body: unknown) {
  return PUT(
    new NextRequest("https://app.example.test/api/workspace/message-defaults", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

// A reset; "?section=campaign" is the campaign editor's.
async function reset(query = "") {
  return DELETE(
    new NextRequest(`https://app.example.test/api/workspace/message-defaults${query}`, {
      method: "DELETE",
    })
  );
}

// Offer texts an admin saved from the offer editor.
const OWN_OFFER = {
  offerMessages: ["Mein eigenes Angebot"],
  offerDelaysSeconds: [1],
  offerButtonLabel: "Klar!",
};

// What the column holds, as SQL sees it: SQL NULL and JSON null differ.
async function column(workspaceId: string) {
  const { rows } = await sql.query(
    `SELECT "messageDefaults" IS NULL AS "isNull", "messageDefaults" AS value, "updatedAt" FROM "${schema}"."Workspace" WHERE id = $1`,
    [workspaceId]
  );
  return rows[0] as { isNull: boolean; value: unknown; updatedAt: Date };
}

describe.skipIf(!databaseUrl)("message defaults on a real Postgres", () => {
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

    await db.user.create({ data: { id: "owner", email: "message-defaults@example.test" } });
    for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
      await db.workspace.create({ data: { id, name: id, ownerId: "owner" } });
    }
  }, 60_000);

  beforeEach(async () => {
    state.context = { workspaceId: WORKSPACE, role: "OWNER" };
    state.locale = "de";
    state.snapshot = undefined;
    await sql.query(`UPDATE "${schema}"."Workspace" SET "messageDefaults" = NULL`);
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("seeds the German set on the first read, once, and reads it back unchanged", async () => {
    expect((await column(WORKSPACE)).isNull).toBe(true);

    expect(await read()).toEqual(german);
    const seeded = await column(WORKSPACE);
    expect(seeded.isNull).toBe(false);
    // Emoji, „…“ and the line breaks of the follow request survive JSONB.
    expect(seeded.value).toEqual(german);

    // The next read finds them and writes nothing.
    expect(await read()).toEqual(german);
    expect((await column(WORKSPACE)).updatedAt).toEqual(seeded.updatedAt);
    // Another workspace is seeded by its own first read only.
    expect((await column(OTHER_WORKSPACE)).isNull).toBe(true);
  });

  it("never seeds over defaults saved after the request loaded the workspace", async () => {
    // The request saw the column empty; an admin saved before the seed ran.
    state.snapshot = await db.workspace.findUniqueOrThrow({ where: { id: WORKSPACE } });
    const saved = { ...german, campaign: { ...german.campaign, dmMessage: "Schon gespeichert" } };
    await db.workspace.update({ where: { id: WORKSPACE }, data: { messageDefaults: saved } });

    expect(await read()).toEqual(saved);
    expect((await column(WORKSPACE)).value).toEqual(saved);
  });

  it("writes nothing in a language without a built-in set", async () => {
    state.locale = "en";

    expect(await read()).toBeNull();
    expect((await column(WORKSPACE)).isNull).toBe(true);
  });

  it("saves texts field by field and reads them back", async () => {
    const response = await save({
      campaign: {
        openingDmMessage: "Hi 👋\nWillst du die Checkliste?",
        publicReplyMessages: ["Schau in deine DMs 📩"],
      },
    });
    expect(response.status).toBe(200);

    const expected = {
      ...german,
      campaign: {
        ...german.campaign,
        openingDmMessage: "Hi 👋\nWillst du die Checkliste?",
        publicReplyMessages: ["Schau in deine DMs 📩"],
      },
    };
    expect((await column(WORKSPACE)).value).toEqual(expected);
    expect(await read()).toEqual(expected);

    // A later save of the offer's texts keeps the campaign's.
    expect((await save({ offer: { cardButtonLabel: "Hol ihn dir" } })).status).toBe(200);
    expect(await read()).toEqual({
      ...expected,
      offer: { ...german.offer, cardButtonLabel: "Hol ihn dir" },
    });
    expect((await column(OTHER_WORKSPACE)).isNull).toBe(true);
  });

  it("resets to SQL NULL, and the next read seeds the built-in set again", async () => {
    await save({ campaign: { dmMessage: "Eigener Text" } });
    await db.workspace.update({
      where: { id: OTHER_WORKSPACE },
      data: { messageDefaults: german },
    });

    const response = await reset();
    expect(response.status).toBe(200);
    expect((await response.json()).data.defaults).toEqual(german);
    expect((await column(WORKSPACE)).isNull).toBe(true);
    // Only this workspace.
    expect((await column(OTHER_WORKSPACE)).value).toEqual(german);

    expect(await read()).toEqual(german);
    expect((await column(WORKSPACE)).value).toEqual(german);
  });

  it("keeps the offer's texts when the campaign editor resets the campaign's", async () => {
    // The first read seeds the German set; the offer editor saves its texts,
    // the campaign editor its own.
    expect(await read()).toEqual(german);
    expect((await save({ offer: OWN_OFFER })).status).toBe(200);
    expect((await save({ campaign: { dmMessage: "Eigener Text" } })).status).toBe(200);

    const response = await reset("?section=campaign");
    expect(response.status).toBe(200);
    const expected = { ...german, offer: { ...german.offer, ...OWN_OFFER } };
    expect((await response.json()).data.defaults).toEqual(expected);
    expect((await column(WORKSPACE)).value).toEqual(expected);
    expect(await read()).toEqual(expected);
    expect((await column(OTHER_WORKSPACE)).isNull).toBe(true);
  });

  it("keeps saved offer texts through a campaign reset in a language without a built-in set", async () => {
    state.locale = "en";
    expect(await read()).toBeNull();
    expect((await save({ offer: OWN_OFFER })).status).toBe(200);

    expect((await reset("?section=campaign")).status).toBe(200);
    const expected = {
      ...EMPTY_MESSAGE_DEFAULTS,
      offer: { ...EMPTY_MESSAGE_DEFAULTS.offer, ...OWN_OFFER },
    };
    expect((await column(WORKSPACE)).value).toEqual(expected);
    expect(await read()).toEqual(expected);
  });

  it("goes back to SQL NULL when a campaign reset leaves only built-in texts", async () => {
    await save({ campaign: { dmMessage: "Eigener Text" } });

    expect((await reset("?section=campaign")).status).toBe(200);
    expect((await column(WORKSPACE)).isNull).toBe(true);
    expect(await read()).toEqual(german);
  });

  it("leaves the column alone for a member", async () => {
    state.context = { workspaceId: WORKSPACE, role: "MEMBER" };

    expect((await save({ campaign: { dmMessage: "Nein" } })).status).toBe(403);
    expect((await reset()).status).toBe(403);
    expect((await reset("?section=campaign")).status).toBe(403);
    expect((await column(WORKSPACE)).isNull).toBe(true);
  });
});
