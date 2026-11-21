import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { createServiceCampaign, getCampaign, listCampaigns } from "../lib/integrations/campaigns";
import { hashServiceToken, newServiceToken } from "../lib/integrations/auth";
import { callTool } from "../lib/integrations/mcp";
import { builtInMessageDefaults } from "../lib/campaigns/message-defaults";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `integrations_${randomBytes(4).toString("hex")}`;
let sql: Client;
const context = { workspaceId: "workspace", keyId: "key", scopes: ["campaigns:read"] };

describe.skipIf(!databaseUrl)("read-only integrations on real PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    const dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs.filter(d => d.name !== "20261003120000_workspace_service_keys")) {
      await sql.query(readFileSync(path.join(root, dir.name, "migration.sql"), "utf8"));
    }
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }) });
    await state.db.user.create({ data: { id: "owner", email: "integration@example.test" } });
    for (const id of ["workspace", "other"]) {
      await state.db.workspace.create({ data: { id, name: id, ownerId: "owner" } });
      await state.db.instagramAccount.create({ data: { id: `account_${id}`, workspaceId: id, instagramId: id, username: id, accessToken: "local-only-secret" } });
    }
    await state.db.automation.create({ data: {
      id: "campaign", workspaceId: "workspace", instagramAccountId: "account_workspace", name: "Example",
      keywords: ["LINK"], dmMessage: "Your link", isActive: true, openingDmEnabled: true,
      openingDmMessage: "Tap below", openingDmButtonLabel: "Open", reportShareSlug: "private-report",
    } });
    await state.db.automation.create({ data: { id: "foreign", workspaceId: "other", instagramAccountId: "account_other", name: "Other", keywords: [], dmMessage: "Private", isActive: false } });
    const before = await state.db.automation.findMany({ orderBy: { id: "asc" } });
    await sql.query(readFileSync(path.join(root, "20261003120000_workspace_service_keys", "migration.sql"), "utf8"));
    expect(await state.db.automation.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    const date = new Date("2026-01-01");
    for (const [id, label, workspaceId] of [["b", "Second", "workspace"], ["a", "First", "workspace"], ["foreign-link", "Hidden", "other"]]) {
      await state.db.trackedLink.create({ data: { id, label, workspaceId, automationId: "campaign", slug: id, destinationUrl: `https://example.test/${id}`, position: 0, createdAt: date } });
    }
  }, 60_000);
  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); }
  });

  it("returns ordered complete details with a safe whitelist and no writes", async () => {
    const before = await state.db.automation.findUniqueOrThrow({ where: { id: "campaign" } });
    const detail = await getCampaign(context, "campaign");
    expect(detail.openingDmEnabled).toBe(true);
    expect(detail.openingDmMessage).toBe("Tap below");
    expect(detail.trackedDestinationUrl).toBe("https://example.test/a");
    expect(detail.secondaryDestinationUrl).toBe("https://example.test/b");
    expect(detail.secondaryButtonLabel).toBe("Second");
    expect(detail.trackedLinks).toEqual([
      { destinationUrl: "https://example.test/a", label: "First", position: 0 },
      { destinationUrl: "https://example.test/b", label: "Second", position: 0 },
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/private-report|local-only-secret|foreign-link/);
    expect(detail).not.toHaveProperty("reportShareSlug");
    expect(detail).not.toHaveProperty("instagramAccount");
    expect(await callTool(context, "get_campaign", { id: "campaign" })).toEqual(detail);
    expect(await state.db.automation.findUniqueOrThrow({ where: { id: "campaign" } })).toEqual(before);
  });
  it("isolates workspaces and scope and keeps lists compact", async () => {
    await expect(getCampaign(context, "foreign")).rejects.toMatchObject({ status: 404 });
    await expect(getCampaign({ ...context, scopes: [] }, "campaign")).rejects.toMatchObject({ status: 403 });
    const summaries = await listCampaigns(context);
    expect(summaries.map(c => c.id)).toEqual(["campaign"]);
    expect(summaries[0]).not.toHaveProperty("trackedLinks");
    expect(summaries[0]).not.toHaveProperty("openingDmMessage");
  });
  it("follows position changes and returns null for absent links", async () => {
    await state.db.trackedLink.update({ where: { id: "b" }, data: { position: -1 } });
    expect((await getCampaign(context, "campaign")).trackedDestinationUrl).toBe("https://example.test/b");
    expect(await getCampaign({ ...context, workspaceId: "other" }, "foreign")).toMatchObject({ trackedLinks: [], trackedDestinationUrl: null, secondaryDestinationUrl: null });
  });
  it("stores only hashed keys with fixed independent expiry and workspace cascade", async () => {
    const oldExpiry = new Date("2099-01-01");
    await state.db.serviceKey.create({ data: { id: "old", workspaceId: "workspace", name: "Old", tokenHash: hashServiceToken(newServiceToken()), scopes: ["campaigns:read"], expiresAt: oldExpiry } });
    for (const days of [30, 60, 90]) {
      const token = newServiceToken();
      const expiresAt = new Date(Date.now() + days * 86400000);
      const saved = await state.db.serviceKey.create({ data: { workspaceId: "other", name: `${days} days`, tokenHash: hashServiceToken(token), scopes: ["campaigns:read"], expiresAt } });
      expect(saved.expiresAt).toEqual(expiresAt);
      expect(JSON.stringify(saved)).not.toContain(token);
    }
    expect((await state.db.serviceKey.findUniqueOrThrow({ where: { id: "old" } })).expiresAt).toEqual(oldExpiry);
    await state.db.workspace.delete({ where: { id: "other" } });
    expect(await state.db.serviceKey.count({ where: { workspaceId: "other" } })).toBe(0);
    expect(await state.db.serviceKey.count({ where: { workspaceId: "workspace" } })).toBe(1);
  });
  it("creates paused campaigns for a write key with the workspace's seeded defaults", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    try {
      await state.db.workspace.create({ data: { id: "writer", name: "writer", ownerId: "owner" } });
      await state.db.instagramAccount.create({ data: { id: "account_writer", workspaceId: "writer", instagramId: "writer", username: "writer", accessToken: "local-only-secret" } });
      const writer = { workspaceId: "writer", keyId: "writer-key", scopes: ["campaigns:read", "campaigns:write"] };
      const link = "https://drive.google.com/file/d/abc123/view?usp=sharing";
      const reel = { name: "Prompt reel", keywords: ["Prompt", "Promt"], postId: "media_writer", trackedDestinationUrl: link };
      const german = builtInMessageDefaults("de")!;

      const first = await createServiceCampaign(writer, reel);
      expect(first).toMatchObject({
        name: "Prompt reel", isActive: false, instagramAccountId: "account_writer", postId: "media_writer",
        openingDmMessage: german.campaign.openingDmMessage, dmMessage: `${german.campaign.dmMessage} {link}`,
        followPromptRetryMessage: german.campaign.followPromptRetryMessage, publicReplyMessages: german.campaign.publicReplyMessages,
        ignoreQuestionComments: true, offersEnabled: false, trackedDestinationUrl: link,
      });
      expect(await getCampaign(writer, first.id)).toEqual(first);
      expect(JSON.stringify(first)).not.toMatch(/local-only-secret|reportShareSlug/);
      // The built-in set was written into the empty column once.
      expect((await state.db.workspace.findUniqueOrThrow({ where: { id: "writer" } })).messageDefaults).toEqual(german);

      // With an active offer the defaults switch offers on.
      await state.db.offer.create({ data: { workspaceId: "writer", name: "Guide", offerMessages: ["Want it?"], offerDelaysSeconds: [0],
        offerButtonLabel: "Ja, gerne!", cardTitle: "Guide", cardButtonLabel: "Holen", destinationUrl: "https://example.test/guide",
        linkSlug: "writer-guide", tagOffered: "o", tagInterested: "i", tagSent: "s", tagClicked: "c" } });
      expect(await createServiceCampaign(writer, { ...reel, postId: "media_writer_2", isActive: true })).toMatchObject({ offersEnabled: true, isActive: true });

      // Another workspace's account is unknown here; a read key cannot create.
      await expect(createServiceCampaign(writer, { ...reel, instagramAccountId: "account_workspace" })).rejects.toMatchObject({ status: 400 });
      await expect(createServiceCampaign({ ...writer, scopes: ["campaigns:read"] }, reel)).rejects.toMatchObject({ status: 403 });
      expect(await state.db.automation.count({ where: { workspaceId: "writer" } })).toBe(2);
      expect(await state.db.automation.count({ where: { instagramAccountId: "account_workspace", name: "Prompt reel" } })).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("creates from name, keywords, post and link when the saved defaults switch the opening DM off", async () => {
    // What "Save these texts as defaults" stored with the opening DM off: the
    // German seed's offer switch stayed on, and the workspace has an active
    // offer. Offers need the opening DM (R11), so they stay off.
    const german = builtInMessageDefaults("de")!;
    await state.db.workspace.create({ data: { id: "no_opening", name: "no_opening", ownerId: "owner",
      messageDefaults: { ...german, campaign: { ...german.campaign, openingDmEnabled: false } } } });
    await state.db.instagramAccount.create({ data: { id: "account_no_opening", workspaceId: "no_opening", instagramId: "no_opening", username: "no_opening", accessToken: "local-only-secret" } });
    await state.db.offer.create({ data: { workspaceId: "no_opening", name: "Guide", offerMessages: ["Want it?"], offerDelaysSeconds: [0],
      offerButtonLabel: "Ja, gerne!", cardTitle: "Guide", cardButtonLabel: "Holen", destinationUrl: "https://example.test/guide",
      linkSlug: "no-opening-guide", tagOffered: "o", tagInterested: "i", tagSent: "s", tagClicked: "c" } });
    const writer = { workspaceId: "no_opening", keyId: "no-opening-key", scopes: ["campaigns:write"] };
    const reel = { name: "Prompt reel", keywords: ["Prompt"], postId: "media_no_opening", trackedDestinationUrl: "https://drive.google.com/file/d/abc123/view?usp=sharing" };

    expect(await createServiceCampaign(writer, reel)).toMatchObject({
      name: "Prompt reel", isActive: false, openingDmEnabled: false, openingDmMessage: null, offersEnabled: false,
      dmMessage: `${german.campaign.dmMessage} {link}`,
    });
    expect(await state.db.automation.count({ where: { workspaceId: "no_opening" } })).toBe(1);
  });
});
