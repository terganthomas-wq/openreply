/**
 * Creating campaigns outside the editor (R14).
 *
 * createCampaign is the dashboard's create route without its HTTP envelope,
 * so the service API (POST /api/v1/campaigns, MCP create_campaign) stores a
 * campaign exactly as the editor does. campaignDefaultsFor gives such a
 * campaign the texts and switches a new campaign opens with in the editor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "../app/generated/prisma/client";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { create: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn(), updateMany: vi.fn() },
    offer: { count: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: vi.fn() }));

vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: () => true,
  getCurrentWorkspaceContext: vi.fn(async () => ({
    workspaceId: "workspace_123",
    role: "OWNER",
  })),
}));

import { POST } from "../app/api/automations/route";
import { campaignDefaultsFor, createCampaign } from "../lib/campaigns/create";
import {
  builtInMessageDefaults,
  type MessageDefaults,
} from "../lib/campaigns/message-defaults";
import { createAutomationSchema } from "../lib/campaigns/schema";

const german = builtInMessageDefaults("de") as MessageDefaults;

// A Weg-2 campaign with every kind of field the mapping treats specially.
const body = {
  name: "Guide drop",
  goal: "Grow the newsletter",
  instagramAccountId: "account_123",
  postId: "media_1",
  postUrl: "https://www.instagram.com/reel/abc/",
  keywords: ["GUIDE", "Guid"],
  dmMessage: "Here is your guide {link}",
  trackedDestinationUrl: "https://docs.google.com/document/d/abc/edit?usp=sharing",
  secondaryDestinationUrl: "https://example.com/second",
  secondaryButtonLabel: "Second",
  linkButtonLabel: "Jetzt öffnen",
  openingDmEnabled: true,
  openingDmMessage: "Want it?",
  openingDmButtonLabel: "Ja, schick sie mir",
  requireFollow: true,
  followPromptMessage: "Follow first",
  followPromptButtonLabel: "Erledigt 👍",
  followPromptRetryMessage: "Still not?",
  followPromptRetryButtonLabel: "Erledigt 👍",
  followUpEnabled: true,
  followUpMessage: "Enjoy",
  followUpDelayMinutes: 5,
  publicReplyEnabled: true,
  publicReplyMessages: [" Check your DMs ", "", "Sent!"],
  ignoreQuestionComments: false,
  deliveryTag: "  [LM] Guide sent ",
  offersEnabled: true,
  offerIds: ["offer_2", "offer_1", "offer_2"],
  isActive: false,
  wholeWordMatch: false,
  dmTriggerEnabled: true,
};

// What the create route wrote for this body before createCampaign existed
// (slugs are random and checked by type).
const expectedRow = {
  name: "Guide drop",
  goal: "Grow the newsletter",
  postId: "media_1",
  postUrl: "https://www.instagram.com/reel/abc/",
  pendingNextReel: false,
  matchAnyPost: false,
  keywords: ["GUIDE", "Guid"],
  matchAnyWord: false,
  dmTriggerEnabled: true,
  dmMessage: "Here is your guide {link}",
  openingDmEnabled: true,
  openingDmMessage: "Want it?",
  openingDmButtonLabel: "Ja, schick sie mir",
  linkButtonLabel: "Jetzt öffnen",
  requireFollow: true,
  followPromptMessage: "Follow first",
  followPromptButtonLabel: "Erledigt 👍",
  followPromptRetryMessage: "Still not?",
  followPromptRetryButtonLabel: "Erledigt 👍",
  followUpEnabled: true,
  followUpMessage: "Enjoy",
  followUpDelayMinutes: 5,
  publicReplyEnabled: true,
  publicReplyMessages: ["Check your DMs", "Sent!"],
  publicReplyMessage: "Check your DMs",
  isActive: false,
  wholeWordMatch: false,
  ignoreQuestionComments: false,
  deliveryTag: "[LM] Guide sent",
  offersEnabled: true,
  offerIds: ["offer_2", "offer_1"],
  workspaceId: "workspace_123",
  instagramAccountId: "account_123",
  reportShareSlug: expect.any(String),
  trackedLinks: {
    create: [
      {
        workspaceId: "workspace_123",
        slug: expect.any(String),
        label: "Primary campaign link",
        destinationUrl: "https://docs.google.com/document/d/abc/edit?usp=sharing",
        position: 0,
      },
      {
        workspaceId: "workspace_123",
        slug: expect.any(String),
        label: "Second",
        destinationUrl: "https://example.com/second",
        position: 1,
      },
    ],
  },
};

function postRequest(payload: unknown) {
  return new NextRequest("https://example.com/api/automations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const parse = (payload: unknown) => createAutomationSchema.parse(payload);

// The arguments of a create call, slugs aside: they are random.
function createArgs(call: number) {
  const args = mockPrisma.automation.create.mock.calls[call][0];
  return JSON.parse(
    JSON.stringify(args, (key, value) =>
      key === "slug" || key === "reportShareSlug" ? typeof value : value
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "workspace_123" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "account_123" });
  mockPrisma.automation.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "automation_new",
      ...data,
      trackedLinks: [{ id: "link_1", slug: "abc" }],
    })
  );
  // Every requested offer exists unless a test says otherwise.
  mockPrisma.offer.count.mockImplementation(
    async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length
  );
});

afterEach(() => vi.unstubAllEnvs());

describe("createCampaign", () => {
  it("writes the row the create route wrote before for a representative body", async () => {
    const result = await createCampaign("workspace_123", parse(body));

    expect(result.ok).toBe(true);
    expect(mockPrisma.automation.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.automation.create).toHaveBeenCalledWith({
      data: expectedRow,
      include: { trackedLinks: true },
    });
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "account_123", workspaceId: "workspace_123" },
      select: { id: true },
    });
    expect(mockPrisma.offer.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_123",
        id: { in: ["offer_2", "offer_1"] },
        archivedAt: null,
      },
    });
  });

  it("is what the dashboard's create route stores, answered with 201 and the stored campaign", async () => {
    const response = await POST(postRequest(body));
    await createCampaign("workspace_123", parse(body));

    expect(response.status).toBe(201);
    expect(createArgs(0)).toEqual(createArgs(1));
    const created = await mockPrisma.automation.create.mock.results[0].value;
    expect(await response.json()).toEqual({
      success: true,
      data: JSON.parse(JSON.stringify(created)),
    });
  });

  it("uses the most recently connected account when none or all is named", async () => {
    for (const instagramAccountId of [undefined, "all"]) {
      mockPrisma.instagramAccount.findFirst.mockClear();
      await createCampaign(
        "workspace_123",
        parse({ ...body, instagramAccountId })
      );
      expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: "workspace_123" },
        orderBy: { connectedAt: "desc" },
        select: { id: true },
      });
    }
  });

  it.each([
    ["the workspace is gone", { workspace: null, account: null, offers: 0 }, 404, "Workspace not found"],
    ["no account is connected", { workspace: {}, account: null, offers: 0 }, 400, "Connect Instagram before creating campaigns"],
    ["an offer is unknown", { workspace: {}, account: { id: "account_123" }, offers: 1 }, 400, "Unknown offer"],
  ])("stores nothing when %s", async (_case, found, status, error) => {
    mockPrisma.workspace.findUnique.mockResolvedValue(found.workspace);
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(found.account);
    mockPrisma.offer.count.mockResolvedValue(found.offers);

    expect(await createCampaign("workspace_123", parse(body))).toEqual({
      ok: false,
      status,
      error,
    });

    const response = await POST(postRequest(body));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ success: false, error });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("checks no offers when the campaign uses the default order", async () => {
    await createCampaign("workspace_123", parse({ ...body, offerIds: [] }));

    expect(mockPrisma.offer.count).not.toHaveBeenCalled();
    expect(mockPrisma.automation.create.mock.calls[0][0].data.offerIds).toEqual([]);
  });
});

describe("campaignDefaultsFor", () => {
  it("gives the campaign section of the stored defaults while an active offer exists", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ messageDefaults: german });
    mockPrisma.offer.findFirst.mockResolvedValue({ id: "offer_1" });

    expect(await campaignDefaultsFor("workspace_123")).toEqual(german.campaign);
    expect(mockPrisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: "workspace_123" },
      select: { messageDefaults: true },
    });
    expect(mockPrisma.offer.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_123", isActive: true, archivedAt: null },
      select: { id: true },
    });
    expect(mockPrisma.workspace.updateMany).not.toHaveBeenCalled();
  });

  it("switches offers off while the workspace has no active offer", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ messageDefaults: german });
    mockPrisma.offer.findFirst.mockResolvedValue(null);

    expect(await campaignDefaultsFor("workspace_123")).toEqual({
      ...german.campaign,
      offersEnabled: false,
    });
    // The stored defaults keep their switch.
    expect(german.campaign.offersEnabled).toBe(true);
  });

  it("asks for no offer when the defaults leave offers off", async () => {
    const saved = { ...german, campaign: { ...german.campaign, offersEnabled: false } };
    mockPrisma.workspace.findUnique.mockResolvedValue({ messageDefaults: saved });

    expect(await campaignDefaultsFor("workspace_123")).toEqual(saved.campaign);
    expect(mockPrisma.offer.findFirst).not.toHaveBeenCalled();
  });

  it("seeds the installation language's built-in set once into an empty column", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    mockPrisma.workspace.findUnique.mockResolvedValue({ messageDefaults: null });
    mockPrisma.workspace.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.offer.findFirst.mockResolvedValue({ id: "offer_1" });

    expect(await campaignDefaultsFor("workspace_123")).toEqual(german.campaign);
    expect(mockPrisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: "workspace_123", messageDefaults: { equals: Prisma.DbNull } },
      data: { messageDefaults: german },
    });
    expect(
      mockPrisma.workspace.updateMany.mock.calls[0][0].where.messageDefaults.equals
    ).toBe(Prisma.DbNull);
  });

  it("takes defaults saved meanwhile over the built-in set", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    const saved = {
      ...german,
      campaign: { ...german.campaign, dmMessage: "Hier ist dein Link 👇", offersEnabled: false },
    };
    mockPrisma.workspace.findUnique
      .mockResolvedValueOnce({ messageDefaults: null })
      .mockResolvedValueOnce({ messageDefaults: saved });
    mockPrisma.workspace.updateMany.mockResolvedValue({ count: 0 });

    expect(await campaignDefaultsFor("workspace_123")).toEqual(saved.campaign);
  });

  it("uses the built-in set without replacing stored defaults it cannot read", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    const unreadable = { version: 99 };
    mockPrisma.workspace.findUnique.mockResolvedValue({ messageDefaults: unreadable });
    // The column holds JSON, so the NULL-only write takes nothing.
    mockPrisma.workspace.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.offer.findFirst.mockResolvedValue({ id: "offer_1" });

    expect(await campaignDefaultsFor("workspace_123")).toEqual(german.campaign);
  });

  it.each([undefined, "en", "pt-BR"])(
    "gives nothing and writes nothing in a language without a built-in set (%s)",
    async (locale) => {
      vi.stubEnv("DEFAULT_LOCALE", locale);
      mockPrisma.workspace.findUnique.mockResolvedValue({ messageDefaults: null });

      expect(await campaignDefaultsFor("workspace_123")).toEqual({});
      expect(mockPrisma.workspace.updateMany).not.toHaveBeenCalled();
    }
  );

  it("gives nothing for a workspace that does not exist", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    mockPrisma.workspace.findUnique.mockResolvedValue(null);

    expect(await campaignDefaultsFor("workspace_gone")).toEqual({});
    expect(mockPrisma.workspace.updateMany).not.toHaveBeenCalled();
  });
});
