/**
 * The connection check (A1) against a real Postgres: the migration only
 * adds columns, and the guarantees that live in where clauses hold on the
 * real tables — two checks at once open one incident and send one e-mail per
 * person, a reconnect in the middle of a check wins, and an incident's start
 * survives its end for the catch-up.
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
import { clearConnectionIncident } from "../lib/instagram/connection-state";
import {
  connectionAlertRecipients,
  resetConnectionAlertWarnings,
  sendConnectionAlert,
} from "../lib/ops/connection-alert";
import { resetMailWarnings } from "../lib/ops/mail";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `connection_check_${randomBytes(4).toString("hex")}`;
const MIGRATION = "20261126090000_instagram_connection_alert";
const NOW = new Date("2026-11-25T17:00:00.000Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const INTERVAL = 30 * MINUTE;
let sql: Client;
let before: Record<string, unknown>;
let after: Record<string, unknown>;

let metaAnswer: () => Response | Promise<Response>;
let resendTo: string[];

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

const CONNECTION_COLUMNS = [
  "connectionCheckFailedAt",
  "connectionLostAt",
  "connectionLostReason",
  "connectionAlertSentAt",
  "connectionAlertCount",
  "connectionRecoveredAt",
  "connectionCatchUpFrom",
];

function account() {
  return state.db.instagramAccount.findUniqueOrThrow({ where: { id: "account_db" } });
}

async function check(at: number) {
  vi.setSystemTime(at);
  return checkInstagramConnections({ intervalMs: INTERVAL });
}

describe.skipIf(!databaseUrl)("the connection check on Postgres", () => {
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

    // An account connected before the migration, written as the previous
    // app wrote it.
    await sql.query(
      `INSERT INTO "User" (id, email, "updatedAt") VALUES
        ('u_owner', 'owner@example.test', now()),
        ('u_admin', 'admin@example.test', now()),
        ('u_member', 'member@example.test', now()),
        ('u_other', 'other@example.test', now())`
    );
    await sql.query(
      `INSERT INTO "Workspace" (id, name, "ownerId", "updatedAt") VALUES
        ('workspace_db', 'Studio', 'u_owner', now()),
        ('workspace_other', 'Other', 'u_other', now())`
    );
    await sql.query(
      `INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role) VALUES
        ('m_owner', 'workspace_db', 'u_owner', 'OWNER'),
        ('m_admin', 'workspace_db', 'u_admin', 'ADMIN'),
        ('m_member', 'workspace_db', 'u_member', 'MEMBER'),
        ('m_other', 'workspace_other', 'u_other', 'ADMIN')`
    );
    await sql.query(
      `INSERT INTO "InstagramAccount"
        (id, "workspaceId", "instagramId", username, provider, "metaLogin", "accessToken", "webhookSubscribed", "updatedAt")
       VALUES ('account_db', 'workspace_db', 'ig_db', 'studio', 'META', 'UNIFIED', 'encrypted', true, '2026-11-20T10:00:00.000Z')`
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
  }, 60_000);

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    state.redis = new FakeRedis();
    await state.db.instagramAccount.update({
      where: { id: "account_db" },
      data: {
        connectionCheckFailedAt: null,
        connectionLostAt: null,
        connectionLostReason: null,
        connectionAlertSentAt: null,
        connectionAlertCount: 0,
        connectionRecoveredAt: null,
        connectionCatchUpFrom: null,
      },
    });
    await state.db.operationalEvent.deleteMany({});
    metaAnswer = lost;
    resendTo = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.origin === "https://api.resend.com") {
          resendTo.push(...(JSON.parse(String(init?.body)).to as string[]));
          return Response.json({ id: `email_${resendTo.length}` });
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
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("adds the columns without touching an existing account", () => {
    for (const column of CONNECTION_COLUMNS) {
      expect(before, column).not.toHaveProperty(column);
    }
    expect(after).toMatchObject(before);
    expect(after).toMatchObject({
      connectionCheckFailedAt: null,
      connectionLostAt: null,
      connectionLostReason: null,
      connectionAlertSentAt: null,
      connectionAlertCount: 0,
      connectionRecoveredAt: null,
      connectionCatchUpFrom: null,
    });
  });

  it("opens one incident and sends one e-mail per owner and admin when two checks run at once", async () => {
    await check(NOW);
    expect(await account()).toMatchObject({
      connectionCheckFailedAt: new Date(NOW),
      connectionLostAt: null,
    });

    vi.setSystemTime(NOW + INTERVAL);
    await Promise.all([
      checkInstagramConnections({ intervalMs: INTERVAL }),
      checkInstagramConnections({ intervalMs: INTERVAL }),
    ]);

    expect(await account()).toMatchObject({
      connectionLostAt: new Date(NOW),
      connectionLostReason: "missing (Meta 100/33)",
      connectionAlertCount: 1,
      connectionAlertSentAt: new Date(NOW + INTERVAL),
    });
    expect(resendTo.sort()).toEqual(["admin@example.test", "owner@example.test"]);
    const opened = await state.db.operationalEvent.findMany({
      where: { workspaceId: "workspace_db", level: "WARNING" },
    });
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toMatchObject({ kind: "connection-lost", lostAt: new Date(NOW).toISOString() });
  });

  it("sends the reminder 24 hours later, and nothing after it", async () => {
    await check(NOW);
    await check(NOW + INTERVAL);
    await check(NOW + 12 * HOUR);
    expect(resendTo).toHaveLength(2);

    await check(NOW + INTERVAL + 24 * HOUR);
    expect(resendTo).toHaveLength(4);
    expect((await account()).connectionAlertCount).toBe(2);

    await check(NOW + INTERVAL + 72 * HOUR);
    expect(resendTo).toHaveLength(4);
  });

  it("ends with a check that gets through, keeping the start for the catch-up", async () => {
    await check(NOW);
    await check(NOW + INTERVAL);
    metaAnswer = ok;
    await check(NOW + 3 * HOUR);

    expect(await account()).toMatchObject({
      connectionCheckFailedAt: null,
      connectionLostAt: null,
      connectionLostReason: null,
      connectionAlertCount: 0,
      connectionAlertSentAt: new Date(NOW + INTERVAL),
      connectionRecoveredAt: new Date(NOW + 3 * HOUR),
      connectionCatchUpFrom: new Date(NOW),
    });
    const back = await state.db.operationalEvent.findMany({
      where: { workspaceId: "workspace_db", level: "INFO", source: "WORKER", message: { contains: "is back" } },
    });
    expect(back).toHaveLength(1);
    expect(back[0].payload).toMatchObject({ kind: "connection-back", via: "check" });
  });

  it("ends with a reconnect, and keeps an earlier start that still waits for its catch-up", async () => {
    const earlier = new Date(NOW - 2 * 24 * HOUR);
    await state.db.instagramAccount.update({
      where: { id: "account_db" },
      data: {
        connectionCheckFailedAt: new Date(NOW),
        connectionLostAt: new Date(NOW),
        connectionLostReason: "token (Meta 190)",
        connectionAlertCount: 1,
        connectionCatchUpFrom: earlier,
      },
    });
    vi.setSystemTime(NOW + HOUR);
    const ended = await clearConnectionIncident("account_db", { via: "reconnect" });

    expect(ended).toMatchObject({ lostAt: new Date(NOW), catchUpFrom: earlier, via: "reconnect" });
    expect(await account()).toMatchObject({
      connectionLostAt: null,
      connectionAlertCount: 0,
      connectionRecoveredAt: new Date(NOW + HOUR),
      connectionCatchUpFrom: earlier,
    });
    // Nothing open any more: a second reconnect ends nothing.
    expect(await clearConnectionIncident("account_db", { via: "reconnect" })).toBeNull();
    expect(
      await state.db.operationalEvent.count({ where: { workspaceId: "workspace_db", source: "SYSTEM" } })
    ).toBe(1);
  });

  it("lets a reconnect in the middle of a check win: no incident opens", async () => {
    await check(NOW);
    // The owner reconnects while the worker's second check waits for Meta's
    // refusal of the old token.
    metaAnswer = async () => {
      await clearConnectionIncident("account_db", { via: "reconnect" });
      return lost();
    };
    await check(NOW + INTERVAL);

    expect(await account()).toMatchObject({
      connectionCheckFailedAt: null,
      connectionLostAt: null,
    });
    expect(resendTo).toHaveLength(0);
  });

  it("claims an e-mail once when two sends want it at once", async () => {
    await state.db.instagramAccount.update({
      where: { id: "account_db" },
      data: {
        connectionCheckFailedAt: new Date(NOW),
        connectionLostAt: new Date(NOW),
        connectionLostReason: "missing (Meta 100/33)",
      },
    });
    const row = await account();
    const outcomes = await Promise.all([sendConnectionAlert(row), sendConnectionAlert(row)]);
    expect(outcomes.sort()).toEqual(["sent", "taken"]);
    expect(resendTo).toHaveLength(2);
  });

  it("e-mails the workspace's owners and admins from the real tables", async () => {
    expect(await connectionAlertRecipients("workspace_db")).toEqual([
      "owner@example.test",
      "admin@example.test",
    ]);
  });
});
