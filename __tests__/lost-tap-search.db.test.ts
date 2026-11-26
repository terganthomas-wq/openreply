/**
 * The search for lost taps after a messaging silence (A2) against a real
 * Postgres: the migration only adds four nullable columns, the database's
 * JSON containment finds the stored taps of a person as the search and a
 * lost tap's job expect (messaging only, not echoes, standby or other
 * accounts), the records of DmLog are read with their real update times,
 * and the guarantees in the where clauses hold on the real tables: the two
 * ends of one silence (the webhook route and the check) owe one search, two
 * runs at once read once and continue every tap once, and a silence that
 * ends during the search is merged into it.
 *
 * Meta is fetch answered here, Redis (the R1 pause, the pace) an in-memory
 * stand-in, the queue takes each job id once as BullMQ does, and the mail
 * transport records what it is given. Skipped without TEST_DATABASE_URL; each
 * run builds its own throwaway schema from prisma/migrations and drops it at
 * the end.
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
  adds: [] as { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }[],
  ids: new Set<string>(),
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => state.redis,
  getDMQueue: () => ({
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
      state.adds.push({ name, data, opts });
      const id = opts.jobId as string | undefined;
      if (id && state.ids.has(id)) return { id, duplicate: true };
      if (id) state.ids.add(id);
      return { id };
    },
  }),
  CATCH_UP_JOB_NAME: "process-catch-up",
  POSTBACK_JOB_NAME: "process-postback",
  LOST_TAP_SEARCH_JOB_NAME: "process-lost-taps",
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "local-test-token" }));

import { lostTapAnswered, recordedPairs, recordedTapsSince, pairKey } from "../lib/instagram/lost-tap-records";
import { resetLostTapSearches, runLostTapSearch } from "../lib/instagram/lost-tap-search";
import { endMessagingSilence } from "../lib/instagram/messaging-silence-state";
import { resetLatestMetaUsage } from "../lib/meta/usage";
import type { MailMessage, MailTransport } from "../lib/ops/mail";
import { resetMailWarnings } from "../lib/ops/mail";
import { resetMessagingSilenceMailWarnings } from "../lib/ops/messaging-silence-alert";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `lost_taps_${randomBytes(4).toString("hex")}`;
const MIGRATION = "20261127120000_messaging_tap_search";
const IG = "ig_db";
const MINUTE = 60_000;
const SINCE = new Date("2026-11-25T13:15:16.000Z");
const ENDED = new Date("2026-11-26T10:30:57.000Z");
const NOW = Date.parse("2026-11-26T10:31:30.000Z");
const ENV = { DEFAULT_LOCALE: "de", NEXTAUTH_URL: "https://dm.example.test" };
const LABEL = "Ja, schick ihn mir";
const NEW_COLUMNS = [
  "messagingTapSearchFrom",
  "messagingTapSearchUntil",
  "messagingTapSearchClaimedAt",
  "messagingTapSearchProgress",
];

let sql: Client;
let before: Record<string, unknown>;
let after: Record<string, unknown>;
let sent: MailMessage[];
let sequence = 0;
let conversations: { id: string; person: string; updated: string; messages: { id: string; text: string; at: string; from: string }[] }[];
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

const metaTime = (iso: string) => new Date(iso).toISOString().replace(".000Z", "+0000");

function answerMeta(url: URL): Response {
  const [, node, edge] = url.pathname.split("/").filter(Boolean);
  if (edge === "conversations") {
    return Response.json({
      data: [...conversations]
        .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
        .map((conversation) => ({
          id: conversation.id,
          updated_time: metaTime(conversation.updated),
          participants: { data: [{ id: IG }, { id: conversation.person, username: conversation.person }] },
        })),
    });
  }
  const conversation = conversations.find((item) => item.id === node)!;
  return Response.json({
    id: node,
    messages: {
      data: conversation.messages.map((message) => ({
        id: message.id,
        created_time: metaTime(message.at),
        from: { id: message.from },
        message: message.text,
      })),
    },
  });
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

function postback(person: string, payload = "followcheck:campaign_db:open", mid = `mid_${++sequence}`) {
  return { sender: { id: person }, recipient: { id: IG }, timestamp: 1, postback: { mid, title: LABEL, payload } };
}

async function openingDm(person: string, at: string, overrides: Record<string, unknown> = {}) {
  await state.db.dmLog.create({
    data: {
      workspaceId: "workspace_db",
      automationId: "campaign_db",
      instagramAccountId: "account_db",
      commenterId: person,
      commenterName: person,
      commentText: "guide",
      commentId: `comment_${++sequence}`,
      status: "SENT",
      dmSentAt: new Date(at),
      ...overrides,
    },
  });
}

function conversation(person: string, openingAt: string, tapAt?: string) {
  const messages = [
    ...(tapAt ? [{ id: `m_${person}_tap`, text: LABEL, at: tapAt, from: person }] : []),
    { id: `m_${person}_opening`, text: "Hey! Magst du den Guide?", at: openingAt, from: IG },
  ];
  conversations.push({ id: `conv_${person}`, person, updated: messages[0].at, messages });
}

function run(at: number) {
  vi.setSystemTime(at);
  return runLostTapSearch("account_db", { sleep: async () => {}, transport, env: ENV });
}

describe.skipIf(!databaseUrl)("the search for lost taps on Postgres", () => {
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
    for (const name of dirs.filter((name) => name !== MIGRATION)) {
      await sql.query(readFileSync(path.join(root, name, "migration.sql"), "utf8"));
    }

    await sql.query(
      `INSERT INTO "User" (id, email, "updatedAt") VALUES
        ('u_owner', 'owner@example.test', now()),
        ('u_admin', 'admin@example.test', now())`
    );
    await sql.query(
      `INSERT INTO "Workspace" (id, name, "ownerId", "updatedAt") VALUES ('workspace_db', 'Studio', 'u_owner', now())`
    );
    await sql.query(
      `INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role) VALUES
        ('m_owner', 'workspace_db', 'u_owner', 'OWNER'),
        ('m_admin', 'workspace_db', 'u_admin', 'ADMIN')`
    );
    // An account as the previous release left it, after a silence ended.
    await sql.query(
      `INSERT INTO "InstagramAccount"
        (id, "workspaceId", "instagramId", username, provider, "metaLogin", "accessToken", "webhookSubscribed", "updatedAt",
         "messagingSilenceResult", "messagingAllClearDueAt")
       VALUES ('account_db', 'workspace_db', '${IG}', 'studio', 'META', 'UNIFIED', 'encrypted', true, '2026-11-20T10:00:00.000Z',
         '{"v":1,"since":"2026-11-20T13:00:00.000Z","endedAt":"2026-11-21T10:00:00.000Z","via":"webhook"}', '2026-11-21T10:00:00.000Z')`
    );
    before = (await sql.query(`SELECT * FROM "InstagramAccount" WHERE id = 'account_db'`)).rows[0];

    await sql.query(readFileSync(path.join(root, MIGRATION, "migration.sql"), "utf8"));
    after = (await sql.query(`SELECT * FROM "InstagramAccount" WHERE id = 'account_db'`)).rows[0];

    // One connection: the local test server runs every connection in one
    // backend session, where two statements at once garble each other. The
    // runs below still interleave at every await, as in the worker.
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
        openingDmMessage: "Hey! Magst du den Guide?",
        openingDmButtonLabel: LABEL,
        requireFollow: true,
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
    vi.setSystemTime(NOW);
    state.redis = new FakeRedis();
    state.adds = [];
    state.ids = new Set();
    sent = [];
    conversations = [];
    await state.db.webhookEvent.deleteMany({});
    await state.db.dmLog.deleteMany({});
    await state.db.operationalEvent.deleteMany({});
    await state.db.instagramAccount.update({
      where: { id: "account_db" },
      data: {
        messagingSilentSince: SINCE,
        messagingSilenceCheckAt: null,
        messagingSilenceResult: Prisma.DbNull,
        messagingAllClearDueAt: null,
        messagingAllClearSentAt: null,
        messagingTapSearchFrom: null,
        messagingTapSearchUntil: null,
        messagingTapSearchClaimedAt: null,
        messagingTapSearchProgress: Prisma.DbNull,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://graph.facebook.com");
        return answerMeta(url);
      })
    );
    vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
    resetMailWarnings();
    resetMessagingSilenceMailWarnings();
    resetLatestMetaUsage();
    resetLostTapSearches();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("adds four nullable columns without touching an existing account", () => {
    for (const column of NEW_COLUMNS) expect(before, column).not.toHaveProperty(column);
    expect(after).toMatchObject(before);
    for (const column of NEW_COLUMNS) expect(after[column], column).toBeNull();
  });

  it("finds a person's stored taps by JSON containment: messaging only, not echoes, standby or another account", async () => {
    await webhook("2026-11-26T10:31:00.000Z", { id: IG, messaging: [postback("p1", "followcheck:campaign_db:open", "mid_a")] });
    await webhook("2026-11-26T10:32:00.000Z", {
      id: IG,
      messaging: [
        { sender: { id: IG }, recipient: { id: "p1" }, timestamp: 1, message: { mid: "echo", text: "Hier", is_echo: true } },
        { sender: { id: "p1" }, recipient: { id: IG }, timestamp: 1, read: { mid: "r" } },
      ],
    });
    await webhook("2026-11-26T10:33:00.000Z", { id: IG, standby: [postback("p1", "followcheck:campaign_db:open", "mid_standby")] });
    await webhook("2026-11-26T10:34:00.000Z", { id: "ig_other", messaging: [postback("p1", "followcheck:campaign_db:open", "mid_other")] });
    await webhook("2026-11-26T10:35:00.000Z", { id: IG, messaging: [postback("p2", "reveal:campaign_db:open", "mid_p2")] });
    await webhook("2026-11-26T10:36:00.000Z", { id: IG, messaging: [postback("p1", "offer:o1:yes", "mid_offer")] });
    await webhook("2026-11-26T10:20:00.000Z", { id: IG, messaging: [postback("p1", "reveal:campaign_db", "mid_old")] });

    const after = new Date("2026-11-26T10:30:00.000Z");
    expect(await recordedTapsSince(IG, after, { userId: "p1" })).toEqual({
      taps: [{ userId: "p1", automationId: "campaign_db", mid: "mid_a", at: Date.parse("2026-11-26T10:31:00.000Z") }],
      complete: true,
    });
    expect((await recordedTapsSince(IG, after)).taps.map((tap) => tap.mid).sort()).toEqual(["mid_a", "mid_p2"]);
  });

  it("reads the tap path's rows with their real update times", async () => {
    await openingDm("p1", "2026-11-25T20:49:23.000Z");
    await state.db.dmLog.create({
      data: {
        workspaceId: "workspace_db",
        automationId: "campaign_db",
        instagramAccountId: "account_db",
        commenterId: "p1",
        commentText: "(button tap)",
        commentId: "reveal:p1",
        status: "FAILED",
      },
    });
    const pairs = [{ userId: "p1", automationId: "campaign_db", since: Date.parse("2026-11-25T20:49:23.000Z") }];
    // Written now, long after the opening DM: a tap was answered.
    expect((await recordedPairs({ id: "account_db", instagramId: IG }, pairs)).recorded).toEqual(
      new Set([pairKey("p1", "campaign_db")])
    );
    // A failed link is no answer for a lost tap's own job, a SENT one after it is.
    const ask = () =>
      lostTapAnswered({
        instagramId: IG,
        automationId: "campaign_db",
        userId: "p1",
        tappedAt: Date.parse("2026-11-25T20:51:10.000Z"),
        mid: "m_lost",
      });
    expect(await ask()).toBeNull();
    await state.db.dmLog.update({
      where: { automationId_commentId: { automationId: "campaign_db", commentId: "reveal:p1" } },
      data: { status: "SENT", dmSentAt: new Date(NOW) },
    });
    expect(await ask()).toBe("link");
  });

  it("owes one search when the webhook route and the check end the silence at once, and two runs continue each tap once", async () => {
    await openingDm("p1", "2026-11-25T20:49:23.000Z");
    conversation("p1", "2026-11-25T20:49:23.000Z", "2026-11-25T20:51:10.000Z");
    await openingDm("p2", "2026-11-25T20:49:24.000Z");
    conversation("p2", "2026-11-25T20:49:24.000Z");
    await openingDm("p3", "2026-11-26T04:51:55.000Z");
    conversation("p3", "2026-11-26T04:51:55.000Z", "2026-11-26T04:53:00.000Z");

    const ends = await Promise.all([
      endMessagingSilence("account_db", { via: "webhook", at: ENDED }),
      endMessagingSilence("account_db", { via: "check", at: ENDED }),
    ]);
    expect(ends.filter(Boolean)).toHaveLength(1);
    expect(await account()).toMatchObject({
      messagingSilentSince: null,
      messagingTapSearchFrom: SINCE,
      messagingTapSearchUntil: ENDED,
      // The old all-clear of the silence before would tell old news.
      messagingAllClearDueAt: null,
    });
    expect(state.adds.filter((add) => add.name === "process-lost-taps")).toHaveLength(1);

    const outcomes = await Promise.all([run(NOW), run(NOW)]);
    expect(outcomes.sort()).toEqual(["busy", "done"]);
    const taps = state.adds.filter((add) => add.name === "process-postback");
    expect(taps.map((add) => add.data.userId)).toEqual(["p1", "p3"]);
    expect(new Set(taps.map((add) => add.opts.jobId)).size).toBe(2);

    const row = await account();
    expect(row).toMatchObject({
      messagingTapSearchFrom: null,
      messagingTapSearchUntil: null,
      messagingTapSearchClaimedAt: null,
      messagingTapSearchProgress: null,
    });
    expect(row.messagingSilenceResult).toMatchObject({
      since: SINCE.toISOString(),
      endedAt: ENDED.toISOString(),
      taps: { people: 3, continued: 2, noTap: 1, complete: true },
    });
    expect(sent.map((message) => message.to).sort()).toEqual(["admin@example.test", "owner@example.test"]);
    expect(row.messagingAllClearDueAt).toBeNull();
    expect(row.messagingAllClearSentAt).not.toBeNull();

    // Asked again, it finds nothing owed.
    expect(await run(NOW + MINUTE)).toBe("none");
  });

  it("merges a silence that ends while the search is still owed into it, from the earlier start", async () => {
    await openingDm("p1", "2026-11-25T20:49:23.000Z");
    conversation("p1", "2026-11-25T20:49:23.000Z", "2026-11-25T20:51:10.000Z");
    await openingDm("p2", "2026-11-27T02:00:00.000Z");
    conversation("p2", "2026-11-27T02:00:00.000Z", "2026-11-27T02:01:00.000Z");
    await endMessagingSilence("account_db", { via: "webhook", at: ENDED });
    // A new silence opened later, and ends now: its end keeps the earlier
    // start of the search still owed.
    const second = new Date("2026-11-27T09:00:00.000Z");
    await state.db.instagramAccount.update({
      where: { id: "account_db" },
      data: { messagingSilentSince: new Date("2026-11-26T20:00:00.000Z") },
    });
    await endMessagingSilence("account_db", { via: "check", at: second });
    expect(await account()).toMatchObject({
      messagingTapSearchFrom: SINCE,
      messagingTapSearchUntil: second,
    });
    expect(await run(Date.parse("2026-11-27T09:01:00.000Z"))).toBe("done");
    // Both silences' people: p1's tap is too old by now, p2's goes on.
    expect((await account()).messagingSilenceResult).toMatchObject({
      since: "2026-11-26T20:00:00.000Z",
      endedAt: second.toISOString(),
      taps: {
        people: 2,
        continued: 1,
        listed: [{ username: "p1", campaign: "Guide", tappedAt: "2026-11-25T20:51:10.000Z", reason: "window" }],
      },
    });
    expect(state.adds.filter((add) => add.name === "process-postback").map((add) => add.data.userId)).toEqual(["p2"]);
  });
});
