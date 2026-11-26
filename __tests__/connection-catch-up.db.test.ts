/**
 * The catch-up after a lost Instagram connection (A1) against a real
 * Postgres: the migration only adds columns, and the guarantees that live in
 * where clauses hold on the real tables. Two runs at once read and queue
 * once; a reconnect and a check that end the incident at the same moment
 * lead to one catch-up and one all-clear per person; a run that died is taken
 * over once its lease is old and goes on where it saved; one more incident
 * ending in the middle makes it run again without queueing anything twice;
 * the all-clear is claimed once.
 *
 * Meta and Resend are fetch answered here, Redis (the account pause) is an
 * in-memory stand-in and the queue keeps each job id once, as BullMQ does.
 * Skipped without TEST_DATABASE_URL; each run builds its own throwaway schema
 * from prisma/migrations and drops it at the end.
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
const queue = vi.hoisted(() => ({
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
      queue.adds.push({ name, data, opts });
      const id = opts.jobId as string | undefined;
      if (id && queue.ids.has(id)) return { id, duplicate: true };
      if (id) queue.ids.add(id);
      return { id };
    },
  }),
  CATCH_UP_JOB_NAME: "process-catch-up",
  COMMENT_JOB_NAME: "process-comment",
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "local-test-token" }));

import { checkInstagramConnections } from "../lib/instagram/connection-check";
import { runConnectionCatchUp } from "../lib/instagram/connection-catch-up";
import { clearConnectionIncident } from "../lib/instagram/connection-state";
import { resetLatestMetaUsage } from "../lib/meta/usage";
import { resetAllClearWarnings, sendConnectionAllClear } from "../lib/ops/connection-all-clear";
import { resetConnectionAlertWarnings } from "../lib/ops/connection-alert";
import { resetMailWarnings } from "../lib/ops/mail";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `connection_catch_up_${randomBytes(4).toString("hex")}`;
const MIGRATION = "20261126120000_connection_catch_up";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LOST_AT = new Date("2026-11-25T16:45:00.000Z");
const RECOVERED = new Date("2026-11-25T20:50:00.000Z");
const NOW = RECOVERED.getTime() + MINUTE;
const FACEBOOK = "https://graph.facebook.com/v25.0";
const NEW_COLUMNS = [
  "connectionCatchUpClaimedAt",
  "connectionCatchUpProgress",
  "connectionCatchUpResult",
  "connectionAllClearDueAt",
];

let sql: Client;
let before: Record<string, unknown>;
let after: Record<string, unknown>;
let resendTo: string[];
let metaCalls: URL[];
let metaHook: (url: URL) => Promise<void> | void;
let accountNode: () => Response;

const at = (offsetMs: number) => new Date(LOST_AT.getTime() + offsetMs).toISOString();
const COMMENTS: Record<string, { id: string; text: string; timestamp: string; from: { id: string; username: string } }[]> = {
  p1: [
    { id: "c1", text: "guide", timestamp: at(HOUR), from: { id: "person_1", username: "anna" } },
    { id: "c_logged", text: "guide", timestamp: at(HOUR), from: { id: "person_2", username: "ben" } },
  ],
  p2: [{ id: "c2", text: "guide bitte", timestamp: at(2 * HOUR), from: { id: "person_3", username: "cara" } }],
};

function answerMeta(url: URL): Response {
  const [, node, edge] = url.pathname.split("/").filter(Boolean);
  if (edge === "media") {
    return Response.json({
      data: ["p1", "p2"].map((id) => ({
        id,
        permalink: `https://www.instagram.com/p/${id}/`,
        timestamp: at(-HOUR),
        comments_count: COMMENTS[id].length,
      })),
    });
  }
  if (edge === "comments") return Response.json({ data: COMMENTS[node] ?? [] });
  // The connection check's read of the account's own node.
  return accountNode();
}

function account() {
  return state.db.instagramAccount.findUniqueOrThrow({ where: { id: "account_db" } });
}
function commentJobs() {
  return queue.adds.filter((add) => add.name === "process-comment");
}
function catchUpJobs() {
  return queue.adds.filter((add) => add.name === "process-catch-up");
}
const noWait = async () => {};
function catchUp() {
  return runConnectionCatchUp("account_db", { sleep: noWait });
}

describe.skipIf(!databaseUrl)("the catch-up on Postgres", () => {
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
    // The new migration is the newest one.
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
    // An account as the previous release left it: an incident that ended,
    // whose catch-up is owed.
    await sql.query(
      `INSERT INTO "InstagramAccount"
        (id, "workspaceId", "instagramId", username, provider, "metaLogin", "accessToken", "webhookSubscribed", "updatedAt",
         "connectionRecoveredAt", "connectionCatchUpFrom")
       VALUES ('account_db', 'workspace_db', 'ig_db', 'studio', 'META', 'UNIFIED', 'encrypted', true, '2026-11-20T10:00:00.000Z',
         '${RECOVERED.toISOString()}', '${LOST_AT.toISOString()}')`
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
      },
    });
    await state.db.dmLog.create({
      data: {
        workspaceId: "workspace_db",
        automationId: "campaign_db",
        instagramAccountId: "account_db",
        commenterId: "person_2",
        commentText: "guide",
        commentId: "c_logged",
        status: "FAILED",
      },
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
        connectionAlertCount: 0,
        connectionRecoveredAt: RECOVERED,
        connectionCatchUpFrom: LOST_AT,
        connectionCatchUpClaimedAt: null,
        connectionCatchUpProgress: Prisma.DbNull,
        connectionCatchUpResult: Prisma.DbNull,
        connectionAllClearDueAt: null,
      },
    });
    await state.db.operationalEvent.deleteMany({});
    queue.adds = [];
    queue.ids = new Set();
    resendTo = [];
    metaCalls = [];
    metaHook = () => {};
    accountNode = () => Response.json({ id: "ig_db", username: "studio" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.origin === "https://api.resend.com") {
          resendTo.push(...(JSON.parse(String(init?.body)).to as string[]));
          return Response.json({ id: `email_${resendTo.length}` });
        }
        expect(url.href.startsWith(FACEBOOK)).toBe(true);
        metaCalls.push(url);
        await metaHook(url);
        return answerMeta(url);
      })
    );
    vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
    vi.stubEnv("RESEND_API_KEY", "re_test_only");
    vi.stubEnv("EMAIL_FROM", "OpenReply <alerts@example.test>");
    vi.stubEnv("EMAIL_SERVER", "");
    vi.stubEnv("NEXTAUTH_URL", "https://dm.example.test");
    vi.stubEnv("DEFAULT_LOCALE", "de");
    resetMailWarnings();
    resetAllClearWarnings();
    resetConnectionAlertWarnings();
    resetLatestMetaUsage();
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
    for (const column of NEW_COLUMNS) {
      expect(before, column).not.toHaveProperty(column);
      expect(after[column], column).toBeNull();
    }
    expect(after).toMatchObject(before);
  });

  it("reads and queues once when two runs start at the same moment, and sends one all-clear per person", async () => {
    const outcomes = await Promise.all([catchUp(), catchUp()]);
    expect(outcomes.sort()).toEqual(["busy", "done"]);

    // c_logged has a DmLog row: another job handles it.
    expect(commentJobs().map((job) => job.opts.jobId)).toEqual(["recover_ig_db_c1", "recover_ig_db_c2"]);
    expect(metaCalls.filter((url) => url.pathname.endsWith("/comments"))).toHaveLength(2);
    expect(resendTo.sort()).toEqual(["admin@example.test", "owner@example.test"]);
    expect(await account()).toMatchObject({
      connectionCatchUpFrom: null,
      connectionCatchUpClaimedAt: null,
      connectionCatchUpProgress: null,
      connectionAllClearDueAt: null,
    });
    expect((await account()).connectionCatchUpResult).toMatchObject({ queued: 2, lostAt: LOST_AT.toISOString() });

    // The run that stood back looks again in a moment, and finds it done.
    expect(catchUpJobs()).toHaveLength(1);
    vi.setSystemTime(NOW + 10_000);
    expect(await catchUp()).toBe("none");
    expect(resendTo).toHaveLength(2);
  });

  it("leads to one catch-up when a reconnect and a check end the incident at the same moment", async () => {
    await state.db.instagramAccount.update({
      where: { id: "account_db" },
      data: {
        connectionCheckFailedAt: LOST_AT,
        connectionLostAt: LOST_AT,
        connectionLostReason: "missing (Meta 100/33)",
        connectionAlertCount: 1,
        connectionRecoveredAt: null,
        connectionCatchUpFrom: null,
      },
    });
    await Promise.all([
      clearConnectionIncident("account_db", { via: "reconnect" }),
      checkInstagramConnections({ intervalMs: 30 * MINUTE }),
    ]);
    const row = await account();
    expect(row).toMatchObject({ connectionLostAt: null, connectionCatchUpFrom: LOST_AT });

    // The jobs the queue holds, run as the worker would.
    const jobIds = [...new Set(catchUpJobs().map((job) => job.opts.jobId))];
    expect(jobIds).toEqual([`catchup_account_db_${LOST_AT.getTime()}`]);
    const outcomes = [];
    for (const job of catchUpJobs()) {
      outcomes.push(await runConnectionCatchUp(job.data.accountConnectionId as string, { sleep: noWait }));
    }
    expect(outcomes).toContain("done");
    expect(commentJobs()).toHaveLength(2);
    expect(resendTo.sort()).toEqual(["admin@example.test", "owner@example.test"]);
  });

  it("takes over from a run that died once its lease is 10 minutes old, and goes on where it saved", async () => {
    // A run saved after the first post and then the worker died.
    await state.db.instagramAccount.update({
      where: { id: "account_db" },
      data: {
        connectionCatchUpClaimedAt: new Date(NOW - 5 * MINUTE),
        connectionCatchUpProgress: {
          v: 1,
          from: LOST_AT.toISOString(),
          recoveredAt: RECOVERED.toISOString(),
          startedAt: new Date(NOW - 6 * MINUTE).toISOString(),
          posts: [
            { id: "p1", permalink: "https://www.instagram.com/p/p1/" },
            { id: "p2", permalink: "https://www.instagram.com/p/p2/" },
          ],
          next: 1,
          pages: 1,
          queuedIds: ["c1"],
          firstJobAt: new Date(NOW - 6 * MINUTE).toISOString(),
          lastJobAt: new Date(NOW - 6 * MINUTE).toISOString(),
          answeredIds: [],
          answered: [],
          seen: 2,
          handled: 1,
          skipped: {},
          stops: 0,
          resumeAt: null,
        },
      },
    });

    expect(await catchUp()).toBe("busy");
    expect(metaCalls).toHaveLength(0);
    const [retry] = catchUpJobs();
    expect(retry.opts.delay).toBe(5 * MINUTE + 1_000);

    vi.setSystemTime(NOW + 5 * MINUTE + 1_000);
    expect(await catchUp()).toBe("done");
    // Only what was left: p2. c1 is not queued again.
    expect(metaCalls.map((url) => url.pathname)).toEqual(["/v25.0/p2/comments"]);
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c2"]);
    expect((await account()).connectionCatchUpResult).toMatchObject({ queued: 2 });
  });

  it("runs again, without queueing anything twice, when one more incident ends in the middle", async () => {
    metaHook = async (url) => {
      if (!url.pathname.includes("/p2/")) return;
      metaHook = () => {};
      // The connection is lost again for a while and the owner reconnects.
      await state.db.instagramAccount.update({
        where: { id: "account_db" },
        data: { connectionLostAt: new Date(NOW), connectionCheckFailedAt: new Date(NOW) },
      });
      vi.setSystemTime(NOW + MINUTE);
      await clearConnectionIncident("account_db", { via: "reconnect" });
    };

    expect(await catchUp()).toBe("superseded");
    const row = await account();
    // The earlier start is kept for the one catch-up of both.
    expect(row).toMatchObject({ connectionCatchUpFrom: LOST_AT, connectionCatchUpClaimedAt: null });
    expect(resendTo).toHaveLength(0);

    metaCalls = [];
    vi.setSystemTime(NOW + 2 * MINUTE);
    expect(await catchUp()).toBe("done");
    expect(metaCalls.filter((url) => url.pathname.endsWith("/comments"))).toHaveLength(2);
    expect(commentJobs().map((job) => job.data.commentId)).toEqual(["c1", "c2"]);
    expect([...queue.ids].filter((id) => id.startsWith("recover_"))).toHaveLength(2);
    expect(resendTo.sort()).toEqual(["admin@example.test", "owner@example.test"]);
  });

  it("claims the all-clear once when two senders want it at the same moment", async () => {
    expect(await catchUp()).toBe("done");
    expect(resendTo).toHaveLength(2);
    // Owed again, as after an answer that never came.
    await state.db.instagramAccount.update({
      where: { id: "account_db" },
      data: { connectionAllClearDueAt: new Date(NOW) },
    });
    const outcomes = await Promise.all([
      sendConnectionAllClear("account_db"),
      sendConnectionAllClear("account_db"),
    ]);
    expect(outcomes.sort()).toEqual(["sent", "taken"]);
    expect(resendTo).toHaveLength(4);
  });
});
