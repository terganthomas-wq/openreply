import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../app/generated/prisma/client";

const state = vi.hoisted(() => ({
  keys: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  campaigns: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  workspaces: { findUnique: vi.fn(), updateMany: vi.fn() },
  accounts: { findFirst: vi.fn() },
  offers: { count: vi.fn(), findFirst: vi.fn() },
  context: vi.fn(), eval: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: { serviceKey: state.keys, automation: state.campaigns, workspace: state.workspaces, instagramAccount: state.accounts, offer: state.offers } }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: state.context, canManageWorkspace: (role: string) => ["OWNER", "ADMIN"].includes(role) }));
vi.mock("ioredis", () => ({ default: class { status = "ready"; eval = state.eval; listenerCount() { return 1; } } }));

import { authenticateService, hashServiceToken, newServiceToken } from "../lib/integrations/auth";
import { checkOrigin, readJson } from "../lib/integrations/http";
import { getCampaign, listCampaigns } from "../lib/integrations/campaigns";
import { callTool, listTools } from "../lib/integrations/mcp";
import { builtInMessageDefaults, type MessageDefaults } from "../lib/campaigns/message-defaults";
import { OFFER_DELAY_MESSAGE, WEB_LINK_MESSAGE } from "../lib/campaigns/schema";
import { keyAccess } from "../lib/integrations/scopes";
import { GET as listKeys, POST as createKey, DELETE as revokeKey } from "../app/api/integrations/keys/route";
import { POST as mcp } from "../app/api/mcp/route";
import { GET as rest, POST as restCreate } from "../app/api/v1/campaigns/route";

const token = `orp_${"a".repeat(43)}`;
const key = { id: "key", workspaceId: "workspace", scopes: ["campaigns:read"], expiresAt: new Date("2099-01-01"), revokedAt: null };
const context = { workspaceId: "workspace", keyId: "key", scopes: ["campaigns:read"] };
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
const request = (body: unknown, extra = {}) => new Request("https://example.test/api/mcp", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("NEXTAUTH_URL", "https://example.test");
  state.keys.findUnique.mockResolvedValue(key);
  state.keys.update.mockResolvedValue(key);
  state.keys.create.mockImplementation(async ({ data }) => ({ id: "new", name: data.name, scopes: data.scopes, expiresAt: data.expiresAt }));
  state.keys.findMany.mockResolvedValue([]);
  state.keys.updateMany.mockResolvedValue({ count: 1 });
  state.context.mockResolvedValue({ workspaceId: "workspace", role: "ADMIN" });
  state.eval.mockReset().mockResolvedValue(1);
});

describe("service authentication", () => {
  it("generates random secrets and stores lookups by hash only", async () => {
    const a = newServiceToken();
    expect(a).toMatch(/^orp_[A-Za-z0-9_-]{43}$/);
    expect(newServiceToken()).not.toBe(a);
    expect(hashServiceToken(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(await authenticateService(request({}))).toEqual(context);
    expect(state.keys.findUnique).toHaveBeenCalledWith({ where: { tokenHash: hashServiceToken(token) } });
  });
  it.each(["", "Bearer bad", `Bearer ${token} extra`])("rejects invalid header %s before DB", async authorization => {
    await expect(authenticateService(request({}, { authorization }))).rejects.toMatchObject({ status: 401 });
    expect(state.keys.findUnique).not.toHaveBeenCalled();
  });
  it.each([null, { ...key, revokedAt: new Date() }, { ...key, expiresAt: new Date(0) }])("rejects missing, expired or revoked keys", async value => {
    state.keys.findUnique.mockResolvedValue(value);
    await expect(authenticateService(request({}))).rejects.toMatchObject({ status: 401 });
    expect(state.eval).not.toHaveBeenCalled();
  });
  it("bounds requests and fails closed without Redis", async () => {
    state.eval.mockResolvedValueOnce(121);
    await expect(authenticateService(request({}))).rejects.toMatchObject({ status: 429 });
    state.eval.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(authenticateService(request({}))).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("REDIS_URL", "");
    await expect(authenticateService(request({}))).rejects.toMatchObject({ status: 503 });
  });
});

describe("key management", () => {
  it.each([30, 60, 90])("creates a %i-day key with safe one-time output", async days => {
    const before = Date.now();
    const response = await createKey(request({ name: "Reader", scopes: ["campaigns:read"], days }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const output = await response.json();
    expect(output.token).toMatch(/^orp_/);
    expect(output.key.tokenHash).toBeUndefined();
    const input = state.keys.create.mock.calls[0][0];
    expect(input.data.tokenHash).toBe(hashServiceToken(output.token));
    expect(input.data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + days * 86400000);
    expect(input.data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + days * 86400000);
    expect(state.keys.update).not.toHaveBeenCalled();
  });
  it("defaults to 30 days", async () => {
    const before = Date.now();
    expect((await createKey(request({ name: "Reader", scopes: ["campaigns:read"] }))).status).toBe(201);
    expect(state.keys.create.mock.calls[0][0].data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 86400000);
  });
  it.each([0, 91, 365, 1.5])("rejects lifetime %s", async days => {
    expect((await createKey(request({ name: "Reader", scopes: ["campaigns:read"], days }))).status).toBe(400);
    expect(state.keys.create).not.toHaveBeenCalled();
  });
  it.each([null, { workspaceId: "workspace", role: "MEMBER" }])("requires admin access for all management routes", async value => {
    state.context.mockResolvedValue(value);
    expect((await listKeys()).status).toBe(403);
    expect((await createKey(request({}))).status).toBe(403);
    expect((await revokeKey(new Request("https://example.test/api/integrations/keys?id=key"))).status).toBe(403);
  });
  it("rejects write scopes and foreign Origins", async () => {
    expect((await createKey(request({ name: "Reader", scopes: ["drafts:write"] }))).status).toBe(400);
    expect((await createKey(request({}, { origin: "https://evil.test" }))).status).toBe(403);
    expect(state.keys.create).not.toHaveBeenCalled();
  });
  it.each([[["campaigns:read", "campaigns:write"]], [["campaigns:write"]]])("creates a key with the scopes %j", async scopes => {
    const response = await createKey(request({ name: "Reel publisher", scopes }));
    expect(response.status).toBe(201);
    expect(state.keys.create.mock.calls[0][0].data.scopes).toEqual(scopes);
    expect((await response.json()).key.scopes).toEqual(scopes);
  });
  it.each([[["campaigns:delete"]], [["campaigns:read", "contacts:read"]], [[]], [["campaigns:read", "campaigns:write", "campaigns:read"]]])("rejects the scopes %j", async scopes => {
    expect((await createKey(request({ name: "Reel publisher", scopes }))).status).toBe(400);
    expect(state.keys.create).not.toHaveBeenCalled();
  });
  it("names a stored key by its scopes as the form does, in any order", () => {
    expect(keyAccess(["campaigns:read"])).toBe("read");
    expect(keyAccess(["campaigns:read", "campaigns:write"])).toBe("write");
    expect(keyAccess(["campaigns:write", "campaigns:read"])).toBe("write");
    expect(keyAccess(["campaigns:write"])).toBe("createOnly");
    for (const scopes of [[], ["campaigns:delete"], ["campaigns:read", "contacts:read"]]) {
      expect(keyAccess(scopes), scopes.join(" ")).toBeNull();
    }
  });
  it("lists safe workspace metadata and revokes only workspace keys", async () => {
    expect((await listKeys()).status).toBe(200);
    const selected = state.keys.findMany.mock.calls[0][0];
    expect(selected.where).toEqual({ workspaceId: "workspace" });
    expect(selected.select.tokenHash).toBeUndefined();
    expect((await revokeKey(new Request("https://example.test/api/integrations/keys?id=key"))).status).toBe(200);
    expect(state.keys.updateMany.mock.calls[0][0].where).toEqual({ id: "key", workspaceId: "workspace", revokedAt: null });
    state.keys.updateMany.mockResolvedValue({ count: 0 });
    expect((await revokeKey(new Request("https://example.test/api/integrations/keys?id=foreign"))).status).toBe(404);
  });
});

describe("read-only MCP and REST", () => {
  it("advertises only scoped read-only tools", async () => {
    expect(listTools({ ...context, scopes: [] })).toEqual([]);
    expect(listTools(context).map(tool => tool.name)).toEqual(["list_campaigns", "get_campaign", "get_campaign_stats"]);
    expect(listTools(context).every(tool => tool.annotations.readOnlyHint)).toBe(true);
    await expect(callTool(context, "create_draft", {})).rejects.toMatchObject({ status: 404 });
    await expect(callTool({ ...context, scopes: [] }, "get_campaign", { id: "test" })).rejects.toMatchObject({ status: 403 });
  });
  it("negotiates MCP, handles notifications and rejects unsupported methods", async () => {
    const response = await mcp(request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }));
    expect((await response.json()).result.protocolVersion).toBe("2025-11-25");
    expect((await mcp(request({ jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);
    expect((await (await mcp(request({ jsonrpc: "2.0", id: 2, method: "unknown" }))).json()).error.code).toBe(-32601);
    expect((await mcp(request({ jsonrpc: "2.0", id: 3, method: "ping" }, { "mcp-protocol-version": "invalid" }))).status).toBe(400);
    expect((await mcp(request({}, { accept: "application/json" }))).status).toBe(406);
  });
  it("keeps REST and MCP details identical and non-cached", async () => {
    state.campaigns.findFirst.mockResolvedValue({ id: "campaign", trackedLinks: [{ destinationUrl: "https://example.test/primary", label: "Primary", position: 0 }] });
    const restResponse = await rest(new Request("https://example.test/api/v1/campaigns?id=campaign", { headers }));
    const expected = (await restResponse.json()).data;
    const mcpResponse = await mcp(request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_campaign", arguments: { id: "campaign" } } }));
    expect(JSON.parse((await mcpResponse.json()).result.content[0].text)).toEqual(expected);
    expect(restResponse.headers.get("cache-control")).toBe("no-store");
    expect(mcpResponse.headers.get("cache-control")).toBe("no-store");
    const selection = state.campaigns.findFirst.mock.calls[0][0];
    expect(selection.where).toEqual({ id: "campaign", workspaceId: "workspace" });
    expect(selection.select.trackedLinks.where).toEqual({ workspaceId: "workspace" });
    expect(selection.select.reportShareSlug).toBeUndefined();
    expect(selection.select.instagramAccount).toBeUndefined();
  });
  it("returns the question filter, second follow request, delivery tag and offers", async () => {
    const weg2 = { ignoreQuestionComments: true, followPromptRetryMessage: "Still not following?", followPromptRetryButtonLabel: "Done now", deliveryTag: "[LM] Guide sent", offersEnabled: true, offerIds: ["offer_2", "offer_1"] };
    state.campaigns.findFirst.mockResolvedValue({ id: "campaign", ...weg2, trackedLinks: [] });
    expect(await getCampaign(context, "campaign")).toMatchObject(weg2);
    const { select } = state.campaigns.findFirst.mock.calls[0][0];
    expect(Object.fromEntries(Object.keys(weg2).map(field => [field, select[field]]))).toEqual(Object.fromEntries(Object.keys(weg2).map(field => [field, true])));
  });
  it("returns when the offer starts in the list and the detail", async () => {
    state.campaigns.findMany.mockResolvedValue([{ id: "campaign", offerDelayHours: 22 }]);
    state.campaigns.findFirst.mockResolvedValue({ id: "campaign", offerDelayHours: 22, trackedLinks: [] });
    expect(await listCampaigns(context)).toEqual([{ id: "campaign", offerDelayHours: 22 }]);
    expect(await getCampaign(context, "campaign")).toMatchObject({ offerDelayHours: 22 });
    expect(state.campaigns.findMany.mock.calls[0][0].select.offerDelayHours).toBe(true);
    expect(state.campaigns.findFirst.mock.calls[0][0].select.offerDelayHours).toBe(true);
  });
  it("does not leak foreign campaigns or invent missing links", async () => {
    state.campaigns.findFirst.mockResolvedValue(null);
    await expect(getCampaign(context, "foreign")).rejects.toMatchObject({ status: 404 });
    state.campaigns.findFirst.mockResolvedValue({ id: "empty", trackedLinks: [] });
    expect(await getCampaign(context, "empty")).toMatchObject({ trackedDestinationUrl: null, secondaryDestinationUrl: null, trackedLinks: [] });
  });
});

describe("creating campaigns (campaigns:write)", () => {
  const german = builtInMessageDefaults("de") as MessageDefaults;
  const writer = { ...key, scopes: ["campaigns:read", "campaigns:write"] };
  const link = "https://drive.google.com/file/d/abc123/view?usp=sharing";
  // What a reel needs; every other field comes from the workspace's defaults.
  const reel = { name: "Prompt reel", keywords: ["Prompt", "Promt", "Prom"], postId: "media_1", trackedDestinationUrl: link };
  const stored = { id: "created", name: "Prompt reel", isActive: false, trackedLinks: [{ destinationUrl: link, label: "Primary campaign link", position: 0 }] };
  const post = (body: unknown, extra = {}) => new Request("https://example.test/api/v1/campaigns", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const callCreate = (id: number, args: unknown) => request({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "create_campaign", arguments: args } });
  const created = (call = 0) => state.campaigns.create.mock.calls[call][0].data;
  // Slugs are random; everything else of two creates must match.
  const withoutSlugs = (value: unknown) => JSON.parse(JSON.stringify(value, (field, v) => field === "slug" || field === "reportShareSlug" ? typeof v : v));

  beforeEach(() => {
    state.keys.findUnique.mockResolvedValue(writer);
    state.workspaces.findUnique.mockResolvedValue({ id: "workspace", messageDefaults: german });
    state.workspaces.updateMany.mockResolvedValue({ count: 0 });
    state.accounts.findFirst.mockResolvedValue({ id: "account_workspace" });
    state.offers.findFirst.mockResolvedValue({ id: "offer_1" });
    state.offers.count.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length);
    state.campaigns.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "created", ...data, trackedLinks: [] }));
    state.campaigns.findFirst.mockResolvedValue(stored);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a read key with 403 before reading its body and hides create_campaign from it", async () => {
    state.keys.findUnique.mockResolvedValue(key);
    for (const attempt of [post(reel), post(reel, { "content-type": "text/plain" })]) {
      const response = await restCreate(attempt);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Missing scope: campaigns:write" });
    }
    expect(listTools(context).map(tool => tool.name)).not.toContain("create_campaign");
    const listed = await (await mcp(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).json();
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["list_campaigns", "get_campaign", "get_campaign_stats"]);
    const called = await (await mcp(callCreate(2, reel))).json();
    expect(called.result).toEqual({ isError: true, content: [{ type: "text", text: "Missing scope: campaigns:write" }] });
    expect(state.workspaces.findUnique).not.toHaveBeenCalled();
    expect(state.campaigns.create).not.toHaveBeenCalled();
  });

  it("creates a paused campaign with the workspace's German defaults from name, keywords, post and link", async () => {
    const response = await restCreate(post(reel));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: { ...stored, trackedDestinationUrl: link, secondaryDestinationUrl: null, secondaryButtonLabel: null } });
    const defaults = german.campaign;
    expect(created()).toMatchObject({
      name: "Prompt reel", keywords: reel.keywords, postId: "media_1", isActive: false,
      workspaceId: "workspace", instagramAccountId: "account_workspace",
      openingDmEnabled: true, openingDmMessage: defaults.openingDmMessage, openingDmButtonLabel: defaults.openingDmButtonLabel,
      requireFollow: true, followPromptMessage: defaults.followPromptMessage, followPromptButtonLabel: defaults.followPromptButtonLabel,
      followPromptRetryMessage: defaults.followPromptRetryMessage, followPromptRetryButtonLabel: defaults.followPromptRetryButtonLabel,
      // {link} as the editor adds it: where a text-only fallback puts the link.
      dmMessage: `${defaults.dmMessage} {link}`, linkButtonLabel: defaults.linkButtonLabel,
      publicReplyEnabled: true, publicReplyMessages: defaults.publicReplyMessages, publicReplyMessage: defaults.publicReplyMessages[0],
      ignoreQuestionComments: true, offersEnabled: true, offerIds: [],
      trackedLinks: { create: [expect.objectContaining({ workspaceId: "workspace", destinationUrl: link, position: 0 })] },
    });
    // Defaults, offers and account are this key's workspace's; nothing is seeded over stored defaults.
    expect(state.workspaces.findUnique).toHaveBeenCalledWith({ where: { id: "workspace" }, select: { messageDefaults: true } });
    expect(state.offers.findFirst).toHaveBeenCalledWith({ where: { workspaceId: "workspace", isActive: true, archivedAt: null }, select: { id: true } });
    expect(state.accounts.findFirst).toHaveBeenCalledWith({ where: { workspaceId: "workspace" }, orderBy: { connectedAt: "desc" }, select: { id: true } });
    expect(state.workspaces.updateMany).not.toHaveBeenCalled();
    // The answer is get_campaign's projection of the stored campaign.
    const { select, where } = state.campaigns.findFirst.mock.calls[0][0];
    expect(where).toEqual({ id: "created", workspaceId: "workspace" });
    await getCampaign(context, "created");
    expect(state.campaigns.findFirst.mock.calls[1][0].select).toEqual(select);
  });

  it("creates from name, keywords, post and link when the defaults switch the opening DM off", async () => {
    // "Save these texts as defaults" with the opening DM off kept the German
    // seed's offer switch on. Offers need the opening DM (R11), so the
    // defaults leave them off instead of failing every minimal create.
    state.workspaces.findUnique.mockResolvedValue({
      id: "workspace",
      messageDefaults: { ...german, campaign: { ...german.campaign, openingDmEnabled: false } },
    });
    expect((await restCreate(post(reel))).status).toBe(201);
    const called = await (await mcp(callCreate(3, reel))).json();
    expect(called.result.isError).toBeUndefined();
    expect(state.campaigns.create).toHaveBeenCalledTimes(2);
    for (const call of [0, 1]) {
      expect(created(call)).toMatchObject({ openingDmEnabled: false, openingDmMessage: null, offersEnabled: false, isActive: false });
    }
    expect(state.offers.findFirst).not.toHaveBeenCalled();
  });

  it("leaves offers off without an active offer and starts a campaign only when isActive is sent", async () => {
    state.offers.findFirst.mockResolvedValue(null);
    expect((await restCreate(post(reel))).status).toBe(201);
    expect(created()).toMatchObject({ offersEnabled: false, isActive: false });
    expect((await restCreate(post({ ...reel, isActive: true }))).status).toBe(201);
    expect(created(1).isActive).toBe(true);
  });

  it("takes every field the body sends over the defaults", async () => {
    const body = { ...reel, dmMessage: "Hier ist der Prompt 👇", publicReplyEnabled: false, requireFollow: false, openingDmEnabled: false,
      offersEnabled: false, ignoreQuestionComments: false, deliveryTag: " [LM] Prompt gesendet " };
    expect((await restCreate(post(body))).status).toBe(201);
    expect(created()).toMatchObject({
      dmMessage: `${body.dmMessage} {link}`, publicReplyEnabled: false, publicReplyMessages: [], publicReplyMessage: null,
      requireFollow: false, followPromptMessage: null, followPromptRetryMessage: null,
      openingDmEnabled: false, openingDmMessage: null, offersEnabled: false, ignoreQuestionComments: false, deliveryTag: "[LM] Prompt gesendet",
    });
  });

  it.each([
    ["an unknown field", { ...reel, offerId: "offer_1" }, 'Unrecognized key: "offerId"'],
    ["a misspelt field", { ...reel, keyword: ["Prompt"] }, 'Unrecognized key: "keyword"'],
    ["no trigger post", { name: "No post", keywords: ["Prompt"] }, "postId: Choose which post(s) trigger the campaign"],
    ["offers the defaults switch on without the opening DM", { ...reel, openingDmEnabled: false }, "offersEnabled: Offers need the opening DM"],
    ["a list instead of an object", [reel], "Send the campaign as a JSON object"],
  ])("returns 400 for %s and stores nothing", async (_case, body, message) => {
    const response = await restCreate(post(body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(message);
    expect(state.campaigns.create).not.toHaveBeenCalled();
  });

  it.each([
    ["no account is connected", reel, 400, "Connect Instagram before creating campaigns"],
    ["the account belongs to another workspace", { ...reel, instagramAccountId: "account_other" }, 400, "Connect Instagram before creating campaigns"],
  ])("returns 400 when %s", async (_case, body, status, error) => {
    state.accounts.findFirst.mockResolvedValue(null);
    const response = await restCreate(post(body));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(state.accounts.findFirst.mock.calls[0][0].where.workspaceId).toBe("workspace");
    expect(state.campaigns.create).not.toHaveBeenCalled();
  });

  it("refuses an offer order with another workspace's or an archived offer", async () => {
    state.offers.count.mockResolvedValue(0);
    const response = await restCreate(post({ ...reel, offerIds: ["offer_other"] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unknown offer" });
    expect(state.offers.count).toHaveBeenCalledWith({ where: { workspaceId: "workspace", id: { in: ["offer_other"] }, archivedAt: null } });
  });

  it("seeds the installation's built-in defaults into a workspace that has none", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    state.workspaces.findUnique.mockResolvedValue({ id: "workspace", messageDefaults: null });
    state.workspaces.updateMany.mockResolvedValue({ count: 1 });
    expect((await restCreate(post(reel))).status).toBe(201);
    expect(state.workspaces.updateMany).toHaveBeenCalledWith({ where: { id: "workspace", messageDefaults: { equals: Prisma.DbNull } }, data: { messageDefaults: german } });
    expect(state.workspaces.updateMany.mock.calls[0][0].where.messageDefaults.equals).toBe(Prisma.DbNull);
    expect(created()).toMatchObject({ dmMessage: `${german.campaign.dmMessage} {link}`, openingDmMessage: german.campaign.openingDmMessage, isActive: false });
  });

  it.each([
    ["a link and a text without the token", { dmMessage: "  Hier ist der Prompt  " }, "Hier ist der Prompt {link}"],
    ["a text that has the token", { dmMessage: "Hier: {LINK} viel Spaß" }, "Hier: {LINK} viel Spaß"],
    ["no link", { dmMessage: "Schreib mir!", trackedDestinationUrl: "" }, "Schreib mir!"],
    ["no link field at all", { dmMessage: "Schreib mir!", trackedDestinationUrl: undefined }, "Schreib mir!"],
  ])("stores the DM text for %s", async (_case, fields, dmMessage) => {
    expect((await restCreate(post({ ...reel, ...fields }))).status).toBe(201);
    expect(created().dmMessage).toBe(dmMessage);
  });

  it("does not turn an empty DM text into the token alone", async () => {
    const response = await restCreate(post({ ...reel, dmMessage: "" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("dmMessage");
    expect(state.campaigns.create).not.toHaveBeenCalled();
  });

  it("needs the texts in the body where the installation's language has no built-in set", async () => {
    vi.stubEnv("DEFAULT_LOCALE", undefined);
    state.workspaces.findUnique.mockResolvedValue({ id: "workspace", messageDefaults: null });
    const missing = await restCreate(post(reel));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("dmMessage");
    expect(state.workspaces.updateMany).not.toHaveBeenCalled();
    expect((await restCreate(post({ ...reel, dmMessage: "Here is your link" }))).status).toBe(201);
    expect(created()).toMatchObject({ dmMessage: "Here is your link {link}", isActive: false, openingDmEnabled: false, requireFollow: false,
      publicReplyEnabled: false, ignoreQuestionComments: true, offersEnabled: false });
  });

  it("creates the same campaign with the MCP tool and answers like REST", async () => {
    const expected = (await (await restCreate(post(reel))).json()).data;
    const init = await (await mcp(request({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }))).json();
    expect(init.result.instructions).toContain("create_campaign");
    expect(init.result.instructions).toContain("paused");
    const listed = await (await mcp(request({ jsonrpc: "2.0", id: 4, method: "tools/list" }))).json();
    const tool = listed.result.tools.find((entry: { name: string }) => entry.name === "create_campaign");
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(tool.inputSchema).toMatchObject({ type: "object", required: ["name"], additionalProperties: false });
    expect(Object.keys(tool.inputSchema.properties)).toEqual(expect.arrayContaining(["name", "keywords", "postId", "trackedDestinationUrl", "isActive", "offersEnabled", "offerIds"]));
    // The workspace's defaults and the paused start apply, not the schema's own defaults.
    expect(JSON.stringify(tool.inputSchema)).not.toContain('"default"');
    const called = await (await mcp(callCreate(5, reel))).json();
    expect(JSON.parse(called.result.content[0].text)).toEqual(expected);
    expect(withoutSlugs(created(1))).toEqual(withoutSlugs(created(0)));
    const misspelt = await (await mcp(callCreate(6, { ...reel, colour: "red" }))).json();
    expect(misspelt.result.isError).toBe(true);
    expect(misspelt.result.content[0].text).toContain('Unrecognized key: "colour"');
    expect(state.campaigns.create).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["trackedDestinationUrl", "javascript:alert(document.cookie)"],
    ["trackedDestinationUrl", "data:text/html,<script>alert(1)</script>"],
    ["trackedDestinationUrl", "mailto:someone@example.com"],
    ["secondaryDestinationUrl", "vbscript:msgbox(1)"],
    ["secondaryDestinationUrl", "file:///etc/passwd"],
    ["postUrl", "javascript:alert(1)"],
  ])("refuses a %s of %j over REST and MCP and stores nothing", async (field, link) => {
    const body = { ...reel, [field]: link };
    const error = `Invalid campaign: ${field}: ${WEB_LINK_MESSAGE}`;
    const response = await restCreate(post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    const called = await (await mcp(callCreate(7, body))).json();
    expect(called.result).toEqual({ isError: true, content: [{ type: "text", text: error }] });
    expect(state.campaigns.create).not.toHaveBeenCalled();
  });

  it("creates with http links and tells MCP clients which links it takes", async () => {
    const body = { ...reel, trackedDestinationUrl: "http://example.com/guide", secondaryDestinationUrl: "https://example.com/second" };
    expect((await restCreate(post(body))).status).toBe(201);
    expect(created().trackedLinks.create.map((link: { destinationUrl: string }) => link.destinationUrl))
      .toEqual(["http://example.com/guide", "https://example.com/second"]);
    const listed = await (await mcp(request({ jsonrpc: "2.0", id: 8, method: "tools/list" }))).json();
    const tool = listed.result.tools.find((entry: { name: string }) => entry.name === "create_campaign");
    expect(tool.inputSchema.properties.trackedDestinationUrl.description).toContain("http:// or https://");
  });

  it("starts the offer right after the link unless the body asks for 22 hours later", async () => {
    expect((await restCreate(post(reel))).status).toBe(201);
    expect(created().offerDelayHours).toBe(0);
    expect((await restCreate(post({ ...reel, offerDelayHours: 22 }))).status).toBe(201);
    expect(created(1).offerDelayHours).toBe(22);
    const called = await (await mcp(callCreate(9, { ...reel, offerDelayHours: 22 }))).json();
    expect(called.result.isError).toBeUndefined();
    expect(created(2).offerDelayHours).toBe(22);
  });

  it.each([1, 12, 23, 24, "22", null])("refuses %j as when the offer starts over REST and MCP", async (hours) => {
    const body = { ...reel, offerDelayHours: hours };
    const error = `Invalid campaign: offerDelayHours: ${OFFER_DELAY_MESSAGE}`;
    const response = await restCreate(post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    const called = await (await mcp(callCreate(10, body))).json();
    expect(called.result).toEqual({ isError: true, content: [{ type: "text", text: error }] });
    expect(state.campaigns.create).not.toHaveBeenCalled();
  });

  it("tells MCP clients the two values the offer start takes", async () => {
    const listed = await (await mcp(request({ jsonrpc: "2.0", id: 11, method: "tools/list" }))).json();
    const tool = listed.result.tools.find((entry: { name: string }) => entry.name === "create_campaign");
    const property = tool.inputSchema.properties.offerDelayHours;
    expect(property).toMatchObject({ type: "number", enum: [0, 22] });
    expect(property).not.toHaveProperty("default");
    expect(property.description).toContain("22");
    expect(tool.inputSchema.required).toEqual(["name"]);
  });

  it("answers a create-only key with its campaign but lets it read nothing else", async () => {
    state.keys.findUnique.mockResolvedValue({ ...key, scopes: ["campaigns:write"] });
    const response = await restCreate(post(reel));
    expect(response.status).toBe(201);
    expect((await response.json()).data.id).toBe("created");
    const createOnly = { ...context, scopes: ["campaigns:write"] };
    expect(listTools(createOnly).map(tool => tool.name)).toEqual(["create_campaign"]);
    await expect(callTool(createOnly, "get_campaign", { id: "created" })).rejects.toMatchObject({ status: 403 });
    expect((await rest(new Request("https://example.test/api/v1/campaigns", { headers }))).status).toBe(403);
  });
});

describe("request boundaries", () => {
  it("enforces Origin while permitting non-browser clients", () => {
    expect(() => checkOrigin(request({}))).not.toThrow();
    expect(() => checkOrigin(request({}, { origin: "https://evil.test" }))).toThrow("Origin not allowed");
  });
  it("bounds chunked JSON independent of Content-Length", async () => {
    await expect(readJson(request({ padding: "x".repeat(65536) }))).rejects.toMatchObject({ status: 413 });
    await expect(readJson(request({}, { "content-type": "text/plain" }))).rejects.toMatchObject({ status: 415 });
    await expect(readJson(new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }))).rejects.toMatchObject({ status: 400 });
  });
});
