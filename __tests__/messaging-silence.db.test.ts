/**
 * The messaging silence check (A2) against a real Postgres: the migration
 * only adds columns and an index, the database's JSON containment narrows the
 * webhooks to the account's messaging ones as the check expects (echoes,
 * comment changes, other accounts, standby), the opening DMs are read without
 * the links a tap delivered, and the guarantees in the where clauses hold on
 * the real tables: two checks at once open one incident and send one e-mail
 * per person, an inbound event at the webhook route wins over a check that
 * would open the incident, and a silence's end keeps it for the all-clear.
 *
 * Redis (the R1 pause) is an in-memory stand-in and the mail transport
 * records what it is given. Skipped without TEST_DATABASE_URL; each run builds
 * its own throwaway schema from prisma/migrations and drops it at the end.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "../app/generated/prisma/client";
import { FakeRedis } from "./helpers/fake-redis";

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  redis: null as unknown,
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => state.redis,
  getDMQueue: () => ({ add: vi.fn() }),
  CATCH_UP_JOB_NAME: "process-catch-up",
}));

import {
  checkMessagingSilences,
  latestInboundMessagingAt,
  openingDmsFor,
  resetMessagingSilenceWarnings,
} from "../lib/instagram/messaging-silence-check";
import { endMessagingSilence } from "../lib/instagram/messaging-silence-state";
import type { MailMessage, MailTransport } from "../lib/ops/mail";
import { resetMailWarnings } from "../lib/ops/mail";
import { resetMessagingSilenceMailWarnings } from "../lib/ops/messaging-silence-alert";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `messaging_silence_${randomBytes(4).toString("hex")}`;
const MIGRATION = "20261127090000_messaging_silence";
const IG = "ig_db";
const MINUTE = 60_000;
const INTERVAL = 30 * MINUTE;
const LAST_INBOUND = new Date("2026-11-25T13:15:16.000Z");
const FIRST_CHECK = Date.parse("2026-11-26T09:00:00.000Z");
const SECOND_CHECK = FIRST_CHECK + INTERVAL;
const ENV = { DEFAULT_LOCALE: "de", NEXTAUTH_URL: "https://dm.example.test" };
const NEW_COLUMNS = [
  "messagingSilenceCheckAt",
  "messagingSilentSince",
  "messagingSilenceResult",
  "messagingAlertSentAt",
  "messagingAlertRearmedAt",
  "messagingAlertCount",
  "messagingAllClearDueAt",
  "messagingAllClearSentAt",
];

let sql: Client;
let before: Record<string, unknown>;
let after: Record<string, unknown>;
let sent: MailMessage[];
let sequence = 0;
const transport: MailTransport = {
  name: "resend",
  async send(message) {
    sent.push(message);
    return { ok: true };
  },
};

function account() {
  return state.db.instagramAccount.findUniqueOrThrow({ where: { id: "account_db" } });
}

async function check(now: number) {
  vi.setSystemTime(now);
  return checkMessagingSilences({ intervalMs: INTERVAL, clock: () => now, env: ENV, transport });
}

function item(kind: string, person: string, account = IG) {
  const mid = `mid_${++sequence}`;
  const from = { sender: { id: person }, recipient: { id: account }, timestamp: 1 };
  switch (kind) {
    case "echo":
      return { sender: { id: account }, recipient: { id: person }, timestamp: 1, message: { mid, text: "Hier ist dein Guide", is_echo: true } };
    case "ownRead":
      return { sender: { id: account }, recipient: { id: person }, timestamp: 1, read: { mid } };
    case "postback":
      return { ...from, postback: { mid, title: "Ja, schick ihn mir", payload: "reveal:campaign_db:open" } };
    case "message":
      return { ...from, message: { mid, text: "Danke!" } };
    default:
      return { ...from, read: { mid } };
  }
}

async function webhook(at: string, entry: Record<string, unknown>) {
  await state.db.webhookEvent.create({
    data: {
      object: "instagram",
      status: "PROCESSED",
      createdAt: new Date(at),
      payload: { object: "instagram", entry: [{ time: 1, ...entry }] },
    },
  });
}

async function openingDm(person: string, at: string, overrides: Record<string, unknown> = {}) {
  await state.db.dmLog.create({
    data: {
      workspaceId: "workspace_db",
      automationId: "campaign_db",
      instagramAccountId: "account_db",
      commenterId: person,
      commentText: "guide",
      commentId: `comment_${++sequence}`,
      status: "SENT",
      dmSentAt: new Date(at),
      ...overrides,
    },
  });
}

describe.skipIf(!databaseUrl)("the messaging silence check on Postgres", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    expect(dirs).toContain(MIGRATION);
    expect(dirs.at(-1)).toBe(MIGRATION);
    for (const name of dirs.filter((name) => name !== MIGRATION)) {
      await sql.query(readFileSync(path.join(root, name, "migration.sql"), "utf8"));
    }

    await sql.query(
      `INSERT INTO "User" (id, email, "updatedAt") VALUES
        ('u_owner', 'owner@example.test', now()),
        ('u_admin', 'admin@example.test', now()),
        ('u_member', 'member@example.test', now())`
    );
    await sql.query(
      `INSERT INTO "Workspace" (id, name, "ownerId", "updatedAt") VALUES ('workspace_db', 'Studio', 'u_owner', now())`
    );
    await sql.query(
      `INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role) VALUES
        ('m_owner', 'workspace_db', 'u_owner', 'OWNER'),
        ('m_admin', 'workspace_db', 'u_admin', 'ADMIN'),
        ('m_member', 'workspace_db', 'u_member', 'MEMBER')`
    );
    // An account as the previous release left it, after an A1 incident.
    await sql.query(
      `INSERT INTO "InstagramAccount"
        (id, "workspaceId", "instagramId", username, provider, "metaLogin", "accessToken", "webhookSubscribed", "updatedAt",
         "connectionRecoveredAt", "connectionAlertSentAt", "connectionAlertCount")
       VALUES ('account_db', 'workspace_db', '${IG}', 'studio', 'META', 'UNIFIED', 'encrypted', true, '2026-11-20T10:00:00.000Z',
         '2026-11-25T20:39:00.000Z', '2026-11-25T17:15:00.000Z', 0)`
    );
    await sql.query(
      `INSERT INTO "WebhookEvent" (id, object, payload, status) VALUES ('we_before', 'instagram', '{"object":"instagram","entry":[]}', 'PROCESSED')`
    );
    before = (await sql.query(`SELECT * FROM "InstagramAccount" WHERE id = 'account_db'`)).rows[0];

    await sql.query(readFileSync(path.join(root, MIGRATION, "migration.sql"), "utf8"));
    after = (await sql.query(`SELECT * FROM "InstagramAccount" WHERE id = 'account_db'`)).rows[0];

    // One connection: the local test server runs every connection in one
    // backend session, where two statements at once garble each other. The
    // checks below still interleave at every await, as in the worker.
    state.db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl, max: 1 }, { schema }),
    });
    await state.db.automation.create({
      data: {
        id: "campaign_db",
        workspaceId: "workspace_db",
        instagramAccountId: "account_db",
        name: "Guide",
        keywords: ["guide"],
        matchAnyPost: true,
        dmMessage: "Hier ist dein Guide",
        openingDmEnabled: true,
        openingDmMessage: "Hey, magst du den Guide?",
        openingDmButtonLabel: "Ja, schick ihn mir",
      },
    });
  }, 60_000);

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.query("SET search_path TO DEFAULT");
      await sql.end();
    }
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIRST_CHECK);
    state.redis = new FakeRedis();
    sent = [];
    await state.db.webhookEvent.deleteMany({ where: { id: { not: "we_before" } } });
    await state.db.dmLog.deleteMany({});
    await state.db.operationalEvent.deleteMany({});
    await state.db.instagramAccount.update({
      where: { id: "account_db" },
      data: {
        messagingSilenceCheckAt: null,
        messagingSilentSince: null,
        messagingSilenceResult: Prisma.DbNull,
        messagingAlertSentAt: null,
        messagingAlertRearmedAt: null,
        messagingAlertCount: 0,
        messagingAllClearDueAt: null,
        messagingAllClearSentAt: null,
      },
    });
    resetMailWarnings();
    resetMessagingSilenceMailWarnings();
    resetMessagingSilenceWarnings();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("adds the columns and the index without touching an existing account", async () => {
    for (const column of NEW_COLUMNS) expect(before, column).not.toHaveProperty(column);
    expect(after).toMatchObject(before);
    expect(after).toMatchObject({
      messagingSilenceCheckAt: null,
      messagingSilentSince: null,
      messagingSilenceResult: null,
      messagingAlertSentAt: null,
      messagingAlertRearmedAt: null,
      messagingAlertCount: 0,
      messagingAllClearDueAt: null,
      messagingAllClearSentAt: null,
    });
    const index = await sql.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'WebhookEvent' AND indexname = 'WebhookEvent_createdAt_idx'`,
      [schema]
    );
    expect(index.rows).toHaveLength(1);
  });

  it("finds the newest inbound messaging event of the account, not echoes, comments or other accounts", async () => {
    await webhook("2026-11-25T13:15:16.000Z", { id: IG, messaging: [item("message", "p0")] });
    await webhook("2026-11-25T20:00:00.000Z", { id: IG, messaging: [item("echo", "p1")] });
    await webhook("2026-11-25T21:00:00.000Z", { id: IG, messaging: [item("ownRead", "p1")] });
    await webhook("2026-11-25T22:00:00.000Z", {
      id: IG,
      changes: [{ field: "comments", value: { id: "c_1", text: "Guide", from: { id: "p2" }, media: { id: "m_1" } } }],
    });
    await webhook("2026-11-25T23:00:00.000Z", { id: "ig_other", messaging: [item("read", "p3", "ig_other")] });
    await webhook("2026-11-26T00:00:00.000Z", { id: IG, standby: [item("echo", "p1")] });
    const window = { after: new Date("2026-11-19T09:00:00.000Z"), until: new Date(FIRST_CHECK) };
    expect(await latestInboundMessagingAt(IG, window)).toEqual({ at: LAST_INBOUND, complete: true });

    // Standby counts; a payload with an echo next to a read counts.
    await webhook("2026-11-26T01:00:00.000Z", { id: IG, standby: [item("read", "p4")] });
    expect((await latestInboundMessagingAt(IG, window)).at?.toISOString()).toBe("2026-11-26T01:00:00.000Z");
    await webhook("2026-11-26T02:00:00.000Z", { id: IG, messaging: [item("echo", "p5"), item("read", "p5")] });
    expect((await latestInboundMessagingAt(IG, window)).at?.toISOString()).toBe("2026-11-26T02:00:00.000Z");
    // Nothing after `until` or at `after` counts.
    expect(
      (await latestInboundMessagingAt(IG, { after: new Date("2026-11-26T02:00:00.000Z"), until: new Date(FIRST_CHECK) })).at
    ).toBeNull();
  });

  it("reads page after page past the account's own messaging rows", async () => {
    await webhook("2026-11-25T13:15:16.000Z", { id: IG, messaging: [item("postback", "p0")] });
    for (let n = 0; n < 60; n += 1) {
      await webhook(new Date(Date.parse("2026-11-25T21:00:00.000Z") + n * MINUTE).toISOString(), {
        id: IG,
        messaging: [item("echo", `p${n}`)],
      });
    }
    expect(
      await latestInboundMessagingAt(IG, { after: new Date("2026-11-19T09:00:00.000Z"), until: new Date(FIRST_CHECK) })
    ).toEqual({ at: LAST_INBOUND, complete: true });
  });

  it("reads the opening DMs only: not the link a tap delivered, a DM keyword's answer or a DM that may not have arrived", async () => {
    await openingDm("p1", "2026-11-25T20:49:23.000Z");
    await openingDm("p1", "2026-11-25T20:50:00.000Z", { commentId: "reveal:p1" });
    await openingDm("p2", "2026-11-25T20:50:10.000Z", { commentId: "dm:mid_2" });
    await openingDm("p3", "2026-11-25T20:50:20.000Z", { dmDeliveryUnconfirmed: true });
    await openingDm("p4", "2026-11-25T20:50:30.000Z", { status: "FAILED" });
    await openingDm("p5", "2026-11-25T20:51:36.000Z");
    await openingDm("p6", "2026-11-25T21:00:00.000Z");
    const dms = await openingDmsFor("account_db", ["campaign_db"], {
      after: new Date("2026-11-25T20:39:00.000Z"),
      until: new Date("2026-11-25T21:00:00.000Z"),
    });
    expect(dms.map((dm) => [dm.recipientId, dm.sentAt.toISOString()])).toEqual([
      ["p6", "2026-11-25T21:00:00.000Z"],
      ["p5", "2026-11-25T20:51:36.000Z"],
      ["p1", "2026-11-25T20:49:23.000Z"],
    ]);
  });

  it("opens one incident and sends one e-mail per owner and admin when two checks run at once", async () => {
    await webhook(LAST_INBOUND.toISOString(), { id: IG, messaging: [item("message", "p0")] });
    await openingDm("p1", "2026-11-25T20:49:23.000Z");
    await openingDm("p2", "2026-11-25T20:49:24.000Z");
    await openingDm("p3", "2026-11-25T20:51:36.000Z");

    expect((await check(FIRST_CHECK)).outcomes).toEqual({ strike: 1 });
    vi.setSystemTime(SECOND_CHECK);
    const options = { intervalMs: INTERVAL, clock: () => SECOND_CHECK, env: ENV, transport };
    await Promise.all([checkMessagingSilences(options), checkMessagingSilences(options)]);

    expect(await account()).toMatchObject({
      messagingSilentSince: LAST_INBOUND,
      messagingAlertCount: 1,
      messagingAlertSentAt: new Date(SECOND_CHECK),
    });
    expect(sent.map((message) => message.to).sort()).toEqual(["admin@example.test", "owner@example.test"]);
    const opened = await state.db.operationalEvent.findMany({
      where: { workspaceId: "workspace_db", level: "WARNING" },
    });
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toMatchObject({ kind: "messaging-silent", since: LAST_INBOUND.toISOString(), people: 3 });

    // A tap at the webhook route ends it, and keeps it for the all-clear.
    const ended = await endMessagingSilence("account_db", {
      via: "webhook",
      at: new Date("2026-11-26T10:30:57.000Z"),
    });
    expect(ended).toMatchObject({ since: LAST_INBOUND, via: "webhook" });
    expect(await account()).toMatchObject({
      messagingSilentSince: null,
      messagingSilenceCheckAt: null,
      messagingAlertCount: 0,
      messagingAllClearDueAt: new Date("2026-11-26T10:30:57.000Z"),
      messagingSilenceResult: {
        v: 1,
        since: LAST_INBOUND.toISOString(),
        endedAt: "2026-11-26T10:30:57.000Z",
        via: "webhook",
      },
    });
    expect(await endMessagingSilence("account_db", { via: "check", at: new Date() })).toBeNull();

    sent = [];
    expect((await check(Date.parse("2026-11-26T11:00:00.000Z"))).mailed).toBe(1);
    expect(sent).toHaveLength(2);
    expect((await account()).messagingAllClearDueAt).toBeNull();
    expect((await check(Date.parse("2026-11-26T11:30:00.000Z"))).mailed).toBe(0);
  });

  it("lets an inbound event at the webhook route win over a check that would open the incident", async () => {
    await webhook(LAST_INBOUND.toISOString(), { id: IG, messaging: [item("message", "p0")] });
    await openingDm("p1", "2026-11-25T20:49:23.000Z");
    await openingDm("p2", "2026-11-25T20:49:24.000Z");
    await openingDm("p3", "2026-11-25T20:51:36.000Z");
    await check(FIRST_CHECK);
    // The second check reads the account and the webhooks before the tap is
    // stored (none of it in its view); the route then forgets the first
    // silent check before the check writes.
    const row = await account();
    await endMessagingSilence("account_db", { via: "webhook", at: new Date(SECOND_CHECK - MINUTE) });
    const { checkAccountMessagingSilence } = await import("../lib/instagram/messaging-silence-check");
    const { messagingSilenceThresholds } = await import("../lib/instagram/messaging-silence-signal");
    vi.setSystemTime(SECOND_CHECK);
    const outcome = await checkAccountMessagingSilence(row, {
      thresholds: messagingSilenceThresholds({}).thresholds,
      strikeGapMs: 27 * MINUTE,
      now: SECOND_CHECK,
      transport,
      env: ENV,
    });
    expect(outcome).toBe("inconclusive");
    expect(await account()).toMatchObject({ messagingSilentSince: null, messagingSilenceCheckAt: null });
    expect(sent).toHaveLength(0);
  });
});
