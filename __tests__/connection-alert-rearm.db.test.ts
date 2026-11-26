/**
 * The alert after an all-clear (A1) against a real Postgres: the migration
 * only adds two columns, and a connection lost again after the owners were
 * told it is back gets its alert at once instead of up to 24 hours later,
 * once per 24 hours, through the worker's real check, alert and all-clear.
 *
 * Meta and Resend are fetch answered here, Redis (the account pause) is an
 * in-memory stand-in. Skipped without TEST_DATABASE_URL; each run builds its
 * own throwaway schema from prisma/migrations and drops it at the end.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";
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
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "local-test-token" }));

import { checkInstagramConnections } from "../lib/instagram/connection-check";
import { resetConnectionAlertWarnings } from "../lib/ops/connection-alert";
import { resetAllClearWarnings, sendConnectionAllClear } from "../lib/ops/connection-all-clear";
import { resetMailWarnings } from "../lib/ops/mail";
import { EMPTY_SKIPPED, type CatchUpResult } from "../lib/instagram/catch-up-state";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `alert_rearm_${randomBytes(4).toString("hex")}`;
const MIGRATION = "20261126180000_connection_alert_rearm";
// 17:00 Berlin; checks every 30 minutes.
const T0 = new Date("2026-11-25T16:00:00.000Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const INTERVAL = 30 * MINUTE;
let sql: Client;
let before: Record<string, unknown>;
let after: Record<string, unknown>;

let metaAnswer: () => Response;
let subjects: string[];

const lost = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 100,
        error_subcode: 33,
        type: "GraphMethodException",
        message: "Unsupported get request. Object with ID 'ig_db' does not exist, cannot be loaded due to missing permissions",
        fbtrace_id: "trace",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
const ok = () => Response.json({ id: "ig_db", username: "studio" });

function account() {
  return state.db.instagramAccount.findUniqueOrThrow({ where: { id: "account_db" } });
}

async function check(at: number, answer: () => Response) {
  vi.setSystemTime(at);
  metaAnswer = answer;
  return checkInstagramConnections({ intervalMs: INTERVAL });
}

/** What the catch-up leaves when it has finished, then its all-clear. */
async function allClear(at: number) {
  vi.setSystemTime(at);
  const current = await account();
  const result: CatchUpResult = {
    v: 1,
    lostAt: (current.connectionCatchUpFrom ?? new Date(at - HOUR)).toISOString(),
    recoveredAt: (current.connectionRecoveredAt ?? new Date(at)).toISOString(),
    finishedAt: new Date(at).toISOString(),
    since: new Date(at - 2 * HOUR).toISOString(),
    queued: 0,
    firstJobAt: null,
    lastJobAt: null,
    ownerAnswered: [],
    ownerAnsweredTotal: 0,
    posts: 1,
    pages: 1,
    skipped: { ...EMPTY_SKIPPED },
    complete: true,
  };
  await state.db.instagramAccount.update({
    where: { id: "account_db" },
    data: {
      connectionCatchUpFrom: null,
      connectionCatchUpResult: result as unknown as object,
      connectionAllClearDueAt: new Date(at),
    },
  });
  return sendConnectionAllClear("account_db");
}

describe.skipIf(!databaseUrl)("the alert after an all-clear on Postgres", () => {
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
        ('u_member', 'member@example.test', now())`
    );
    await sql.query(
      `INSERT INTO "Workspace" (id, name, "ownerId", "updatedAt") VALUES ('workspace_db', 'Studio', 'u_owner', now())`
    );
    await sql.query(
      `INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role) VALUES
        ('m_owner', 'workspace_db', 'u_owner', 'OWNER'),
        ('m_member', 'workspace_db', 'u_member', 'MEMBER')`
    );
    // An account as the release before wrote it: an alert that went out.
    await sql.query(
      `INSERT INTO "InstagramAccount"
        (id, "workspaceId", "instagramId", username, provider, "metaLogin", "accessToken", "webhookSubscribed", "updatedAt",
         "connectionAlertSentAt")
       VALUES ('account_db', 'workspace_db', 'ig_db', 'studio', 'META', 'UNIFIED', 'encrypted', true, '2026-11-20T10:00:00.000Z',
         '2026-11-20T09:00:00.000Z')`
    );
    before = (await sql.query(`SELECT * FROM "InstagramAccount" WHERE id = 'account_db'`)).rows[0];

    await sql.query(readFileSync(path.join(root, MIGRATION, "migration.sql"), "utf8"));
    after = (await sql.query(`SELECT * FROM "InstagramAccount" WHERE id = 'account_db'`)).rows[0];

    // One connection: the local test server runs every connection in one
    // backend session, where two statements at once garble each other.
    state.db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl, max: 1 }, { schema }),
    });
  }, 60_000);

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    state.redis = new FakeRedis();
    metaAnswer = lost;
    subjects = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.origin === "https://api.resend.com") {
          subjects.push(JSON.parse(String(init?.body)).subject as string);
          return Response.json({ id: `email_${subjects.length}` });
        }
        expect(`${url.origin}${url.pathname}`).toBe("https://graph.facebook.com/v25.0/ig_db");
        return metaAnswer();
      })
    );
    vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
    vi.stubEnv("RESEND_API_KEY", "re_test_only");
    vi.stubEnv("EMAIL_FROM", "OpenReply <alerts@example.test>");
    vi.stubEnv("EMAIL_SERVER", "");
    vi.stubEnv("NEXTAUTH_URL", "https://dm.example.test");
    vi.stubEnv("DEFAULT_LOCALE", "de");
    resetMailWarnings();
    resetConnectionAlertWarnings();
    resetAllClearWarnings();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("adds the two columns without touching an existing account", () => {
    expect(before).not.toHaveProperty("connectionAllClearSentAt");
    expect(before).not.toHaveProperty("connectionAlertRearmedAt");
    expect(after).toMatchObject(before);
    expect(after).toMatchObject({ connectionAllClearSentAt: null, connectionAlertRearmedAt: null });
  });

  it("alerts at once when the connection drops again after the all-clear, once in 24 hours", async () => {
    const ALERT = "Instagram-Verbindung unterbrochen: OpenReply sendet gerade keine DMs";
    const BACK = "Instagram-Verbindung wieder da: OpenReply sendet wieder DMs";

    // Incident 1: two lost checks, the alert.
    await check(T0, lost);
    await check(T0 + INTERVAL, lost);
    expect(subjects).toEqual([ALERT]);
    // Back with the next check, and the all-clear after the catch-up.
    await check(T0 + 2 * INTERVAL, ok);
    expect(await allClear(T0 + 2 * INTERVAL + 5 * MINUTE)).toBe("sent");
    expect(subjects).toEqual([ALERT, BACK]);
    expect((await account()).connectionAllClearSentAt).toEqual(
      new Date(T0 + 2 * INTERVAL + 5 * MINUTE)
    );

    // Incident 2, two hours after the first alert: its alert goes out at
    // once, not 22 hours later.
    await check(T0 + 3 * INTERVAL, lost);
    await check(T0 + 4 * INTERVAL, lost);
    expect(subjects).toEqual([ALERT, BACK, ALERT]);
    expect(await account()).toMatchObject({
      connectionLostAt: new Date(T0 + 3 * INTERVAL),
      connectionAlertCount: 1,
      connectionAlertSentAt: new Date(T0 + 4 * INTERVAL),
      connectionAlertRearmedAt: new Date(T0 + 4 * INTERVAL),
    });

    // Back and all-clear again, then incident 3 the same evening: no third
    // alert within 24 hours (a flapping connection does not loop).
    await check(T0 + 5 * INTERVAL, ok);
    expect(await allClear(T0 + 5 * INTERVAL + 5 * MINUTE)).toBe("sent");
    await check(T0 + 6 * INTERVAL, lost);
    await check(T0 + 7 * INTERVAL, lost);
    expect((await account()).connectionLostAt).toEqual(new Date(T0 + 6 * INTERVAL));
    expect(subjects).toEqual([ALERT, BACK, ALERT, BACK]);
  });
});
