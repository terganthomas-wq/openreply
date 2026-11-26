/**
 * The durable claims of a comment's DM and its public reply
 * (lib/queue/comment-delivery.ts) on a real Postgres: one claim per campaign
 * and leg, three attempts across jobs, and one private reply per comment
 * across campaigns (the claim and the look at the other campaigns' rows in
 * one transaction, under a lock on the comment), with the public reply
 * closed or opened again in the same transaction. Skipped without
 * TEST_DATABASE_URL; each run builds its own throwaway schema from
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
import {
  claimCommentDelivery,
  claimCommentPrivateReply,
  releaseCommentClaim,
} from "../lib/queue/comment-delivery";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `delivery_claims_${randomBytes(4).toString("hex")}`;
let sql: Client;

describe.skipIf(!databaseUrl)("durable comment delivery on Postgres", () => {
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
    // One connection: the local test server runs every connection in one
    // backend session, where two statements at once garble each other. The
    // claims below still interleave at every await, as in the worker.
    state.db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl, max: 1 }, { schema }),
    });
    await state.db.user.create({
      data: { id: "user", email: "delivery@example.test" },
    });
    await state.db.workspace.create({
      data: { id: "workspace", name: "Delivery", ownerId: "user" },
    });
    await state.db.instagramAccount.create({
      data: {
        id: "account",
        workspaceId: "workspace",
        instagramId: "test_ig",
        username: "delivery",
        accessToken: "local-test-only",
      },
    });
    await state.db.automation.create({
      data: {
        id: "automation",
        workspaceId: "workspace",
        instagramAccountId: "account",
        name: "Test",
        keywords: ["AI"],
        dmMessage: "Test",
      },
    });
    await state.db.automation.create({
      data: {
        id: "automation_b",
        workspaceId: "workspace",
        instagramAccountId: "account",
        name: "Other",
        keywords: ["AI"],
        dmMessage: "Other",
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
  async function seed(commentId: string, automationId = "automation", data: Record<string, unknown> = {}) {
    return state.db.dmLog.create({
      data: {
        workspaceId: "workspace",
        instagramAccountId: "account",
        automationId,
        commenterId: "user_ig",
        commentId,
        commentText: "AI",
        ...data,
      },
    });
  }
  function row(commentId: string, automationId = "automation") {
    return state.db.dmLog.findUniqueOrThrow({
      where: { automationId_commentId: { automationId, commentId } },
    });
  }
  it("allows exactly one concurrent send and survives a lost result write", async () => {
    await seed("concurrent");
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimCommentDelivery("automation", "concurrent", "dm"),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    // A restarted worker or a fresh polling job still observes the persisted claim.
    expect(await claimCommentDelivery("automation", "concurrent", "dm")).toBe(
      false,
    );
    const row = await state.db.dmLog.findUniqueOrThrow({
      where: {
        automationId_commentId: {
          automationId: "automation",
          commentId: "concurrent",
        },
      },
    });
    expect(row).toMatchObject({ attempts: 1, dmDeliveryUnconfirmed: true });
    await seed("another-comment");
    expect(
      await claimCommentDelivery("automation", "another-comment", "dm"),
    ).toBe(true);
  });
  it("caps actual attempts across independent jobs after confirmed rejections", async () => {
    const row = await seed("bounded");
    for (let i = 0; i < 3; i++) {
      expect(await claimCommentDelivery("automation", "bounded", "dm")).toBe(
        true,
      );
      await state.db.dmLog.update({
        where: { id: row.id },
        data: { dmDeliveryUnconfirmed: false, status: "FAILED" },
      });
    }
    expect(await claimCommentDelivery("automation", "bounded", "dm")).toBe(
      false,
    );
    expect(
      (await state.db.dmLog.findUniqueOrThrow({ where: { id: row.id } }))
        .attempts,
    ).toBe(3);
  });
  it("claims public replies independently and never repeats a confirmed send", async () => {
    const row = await seed("public");
    expect(await claimCommentDelivery("automation", "public", "public")).toBe(
      true,
    );
    expect(await claimCommentDelivery("automation", "public", "public")).toBe(
      false,
    );
    expect(await claimCommentDelivery("automation", "public", "dm")).toBe(true);
    await state.db.dmLog.update({
      where: { id: row.id },
      data: {
        publicReplyDeliveryUnconfirmed: false,
        publicReplySentAt: new Date(),
        dmDeliveryUnconfirmed: false,
        status: "SENT",
      },
    });
    expect(await claimCommentDelivery("automation", "public", "public")).toBe(
      false,
    );
    expect(await claimCommentDelivery("automation", "public", "dm")).toBe(
      false,
    );
  });
  it("claims a comment's private reply for one campaign only, and names the other", async () => {
    await seed("pair");
    await seed("pair", "automation_b");
    const first = await claimCommentPrivateReply("automation", "pair");
    expect(first).toEqual({ claimed: true, rival: null });

    // The other campaign finds the claim on its way under the lock, and
    // claims nothing: no attempt, no change to its row.
    const second = await claimCommentPrivateReply("automation_b", "pair");
    expect(second).toEqual({
      claimed: false,
      rival: { automationId: "automation", name: "Test", state: "sending" },
    });
    expect(await row("pair", "automation_b")).toMatchObject({
      attempts: 0,
      dmDeliveryUnconfirmed: false,
    });

    // Sent: the rival says so. Given back without a send: the comment is free.
    await state.db.dmLog.update({
      where: { automationId_commentId: { automationId: "automation", commentId: "pair" } },
      data: { status: "SENT", dmDeliveryUnconfirmed: false },
    });
    expect((await claimCommentPrivateReply("automation_b", "pair")).rival?.state).toBe("sent");

    await seed("pair2");
    await seed("pair2", "automation_b");
    expect((await claimCommentPrivateReply("automation", "pair2")).claimed).toBe(true);
    expect(await releaseCommentClaim("automation", "pair2", "Instagram request limit")).toBe(true);
    expect(await claimCommentPrivateReply("automation_b", "pair2")).toEqual({ claimed: true, rival: null });
  });

  it("counts a claim older than a send takes as a DM that may have gone out", async () => {
    await seed("stale");
    await seed("stale", "automation_b");
    expect((await claimCommentPrivateReply("automation", "stale")).claimed).toBe(true);
    // The worker that holds it died twenty minutes ago.
    await sql.query(
      `UPDATE "${schema}"."DmLog" SET "updatedAt" = now() - interval '20 minutes' WHERE "commentId" = 'stale' AND "automationId" = 'automation'`
    );
    expect((await claimCommentPrivateReply("automation_b", "stale")).rival?.state).toBe("unconfirmed");
  });

  it("closes the public reply with the claim, and opens only its own closing again", async () => {
    const reason = "Not posted: the public reply was switched off for this manual send";
    await seed("closed");
    expect(
      await claimCommentPrivateReply("automation", "closed", {
        matchedKeyword: "(manuell)",
        closePublicReply: reason,
      })
    ).toEqual({ claimed: true, rival: null });
    expect(await row("closed")).toMatchObject({
      matchedKeyword: "(manuell)",
      dmDeliveryUnconfirmed: true,
      publicReplyDeliveryUnconfirmed: true,
      publicReplyError: reason,
    });
    // No job posts the public reply after that.
    expect(await claimCommentDelivery("automation", "closed", "public")).toBe(false);

    // Refused: a later manual send with the public reply on opens it again.
    await state.db.dmLog.update({
      where: { automationId_commentId: { automationId: "automation", commentId: "closed" } },
      data: { status: "FAILED", dmDeliveryUnconfirmed: false },
    });
    expect(
      (await claimCommentPrivateReply("automation", "closed", { reopenPublicReply: reason })).claimed
    ).toBe(true);
    expect(await row("closed")).toMatchObject({
      publicReplyDeliveryUnconfirmed: false,
      publicReplyError: null,
    });
    expect(await claimCommentDelivery("automation", "closed", "public")).toBe(true);

    // A public reply that may have gone out is never opened again.
    await seed("maybe", "automation", {
      status: "FAILED",
      publicReplyDeliveryUnconfirmed: true,
      publicReplyError: "DeliveryUnconfirmedError: Message delivery is unconfirmed",
    });
    expect(
      (await claimCommentPrivateReply("automation", "maybe", { reopenPublicReply: reason })).claimed
    ).toBe(true);
    expect(await row("maybe")).toMatchObject({ publicReplyDeliveryUnconfirmed: true });
  });
});
