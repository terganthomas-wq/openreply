/**
 * Campaign import.
 *
 * The import used to validate its rows with a schema of its own and map them
 * by hand, so the fields added for Weg 2 were neither checked nor given their
 * defaults there: an imported campaign answered questions while every
 * campaign made in the editor left them alone. Rows now go through the shared
 * create schema and are stored like the create route stores them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn(), create: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    offer: { count: vi.fn() },
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

import { POST as importCampaigns } from "../app/api/automations/import/route";
import { POST as createCampaign } from "../app/api/automations/route";
import { OFFER_RULE_MESSAGE, WEB_LINK_MESSAGE } from "../lib/campaigns/schema";

// A row as the CSV-era import took it.
const olderRow = {
  postId: "media_1",
  keywords: ["GUIDE", "Leitfaden"],
  dmMessage: "Here is your guide {link}",
  trackedUrl: "https://example.com/guide",
  publicReplyMessage: "  Check your DMs  ",
};

// The fields of a Weg-2 campaign, as the editor sends them.
const weg2Fields = {
  openingDmEnabled: true,
  openingDmMessage: "Want the guide? Tap the button.",
  openingDmButtonLabel: "Ja, schick sie mir",
  requireFollow: true,
  followPromptMessage: "Follow me first",
  followPromptButtonLabel: "Erledigt 👍",
  followPromptRetryMessage: "I can't see your follow yet",
  followPromptRetryButtonLabel: "Done now",
  ignoreQuestionComments: false,
  deliveryTag: "  [LM] Guide sent ",
  offersEnabled: true,
  offerIds: ["offer_2", "offer_1", "offer_2"],
};

const LABEL_21_UNITS = "Ja, gerne! 🙌🙌🙌🙌🙌";
const TEXT_641_UNITS = `${"a".repeat(639)}🙌`;

function request(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function importRequest(campaigns: unknown[]) {
  return request("https://example.com/api/automations/import", {
    instagramAccountId: "account_123",
    campaigns,
  });
}

function createData(call = 0) {
  return mockPrisma.automation.create.mock.calls[call][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({
    id: "account_123",
    workspaceId: "workspace_123",
  });
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "workspace_123" });
  mockPrisma.automation.findMany.mockResolvedValue([]);
  mockPrisma.automation.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "automation_new",
      ...data,
    })
  );
  // Every requested offer exists unless a test says otherwise.
  mockPrisma.offer.count.mockImplementation(
    async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length
  );
});

describe("POST /api/automations/import", () => {
  it("imports a row of the older format with the defaults of a new campaign", async () => {
    const response = await importCampaigns(importRequest([olderRow]));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        created: [{ name: "Imported: GUIDE", postId: "media_1" }],
        skipped: [],
      },
    });
    expect(createData()).toMatchObject({
      name: "Imported: GUIDE",
      goal: null,
      postId: "media_1",
      postUrl: null,
      pendingNextReel: false,
      matchAnyPost: false,
      keywords: ["GUIDE", "Leitfaden"],
      dmMessage: "Here is your guide {link}",
      publicReplyEnabled: true,
      publicReplyMessages: ["Check your DMs"],
      publicReplyMessage: "Check your DMs",
      isActive: true,
      wholeWordMatch: true,
      // Left to the column defaults before, so imported campaigns answered
      // questions.
      ignoreQuestionComments: true,
      deliveryTag: null,
      followPromptRetryMessage: null,
      followPromptRetryButtonLabel: null,
      offersEnabled: false,
      offerIds: [],
      workspaceId: "workspace_123",
      instagramAccountId: "account_123",
    });
    expect(createData().trackedLinks.create).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_123",
        label: "Primary campaign link",
        destinationUrl: "https://example.com/guide",
        position: 0,
      }),
    ]);
    // No offer ids, no query.
    expect(mockPrisma.offer.count).not.toHaveBeenCalled();
  });

  it("stores a campaign exactly as the create route stores the same body", async () => {
    const body = {
      ...weg2Fields,
      name: "Guide drop",
      goal: "Grow the newsletter",
      postId: "media_1",
      postUrl: "https://www.instagram.com/reel/abc/",
      keywords: ["GUIDE"],
      dmMessage: "Here is your guide {link}",
      trackedDestinationUrl: "https://example.com/guide",
      publicReplyEnabled: true,
      publicReplyMessages: [" Check your DMs ", "Sent!"],
      followUpEnabled: true,
      followUpMessage: "Enjoy it!",
      followUpDelayMinutes: 5,
    };

    const created = await createCampaign(
      request("https://example.com/api/automations", {
        ...body,
        instagramAccountId: "account_123",
      })
    );
    const imported = await importCampaigns(importRequest([body]));

    expect(created.status).toBe(201);
    expect(imported.status).toBe(200);
    // Slugs are random; everything else must match.
    const comparable = ({
      reportShareSlug,
      trackedLinks,
      ...row
    }: {
      reportShareSlug: string;
      trackedLinks: { create: { slug: string }[] };
    }) => ({
      ...row,
      shareSlug: typeof reportShareSlug,
      links: trackedLinks.create.map(({ slug, ...link }) => ({
        ...link,
        slug: typeof slug,
      })),
    });
    expect(comparable(createData(1))).toEqual(comparable(createData(0)));
    expect(createData(1)).toMatchObject({
      deliveryTag: "[LM] Guide sent",
      offerIds: ["offer_2", "offer_1"],
      followPromptRetryMessage: "I can't see your follow yet",
      ignoreQuestionComments: false,
    });
  });

  it("checks the offers of every row against the workspace's current offers", async () => {
    await importCampaigns(
      importRequest([
        { ...olderRow, ...weg2Fields },
        { ...olderRow, ...weg2Fields, postId: "media_2", offerIds: ["offer_3"] },
      ])
    );

    expect(mockPrisma.offer.count).toHaveBeenCalledTimes(1);
    expect(mockPrisma.offer.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_123",
        id: { in: ["offer_2", "offer_1", "offer_3"] },
        archivedAt: null,
      },
    });
    expect(mockPrisma.automation.create).toHaveBeenCalledTimes(2);
  });

  it("imports nothing when a row names an unknown offer", async () => {
    mockPrisma.offer.count.mockResolvedValue(1);

    const response = await importCampaigns(
      importRequest([{ ...olderRow, ...weg2Fields }])
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Unknown offer",
    });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a button label of 21 UTF-16 units",
      fields: { requireFollow: true, followPromptRetryButtonLabel: LABEL_21_UNITS },
      field: "followPromptRetryButtonLabel",
      message: "At most 20 characters (emoji count as 2)",
    },
    {
      label: "a second follow request of 641 UTF-16 units",
      fields: { requireFollow: true, followPromptRetryMessage: TEXT_641_UNITS },
      field: "followPromptRetryMessage",
      message: "At most 640 characters (emoji count as 2)",
    },
    {
      label: "offers without the opening DM",
      fields: { offersEnabled: true },
      field: "offersEnabled",
      message: OFFER_RULE_MESSAGE,
    },
    {
      label: "a javascript: link",
      fields: { trackedDestinationUrl: "javascript:alert(document.cookie)" },
      field: "trackedDestinationUrl",
      message: WEB_LINK_MESSAGE,
    },
    {
      label: "a data: second link",
      fields: { secondaryDestinationUrl: "data:text/html,<script>alert(1)</script>" },
      field: "secondaryDestinationUrl",
      message: WEB_LINK_MESSAGE,
    },
    {
      label: "a javascript: post link",
      fields: { postUrl: "javascript:alert(1)" },
      field: "postUrl",
      message: WEB_LINK_MESSAGE,
    },
  ])(
    "imports nothing when a row has $label, and names the row",
    async ({ fields, field, message }) => {
      const response = await importCampaigns(
        importRequest([olderRow, { ...olderRow, postId: "media_2", ...fields }])
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toMatchObject({ success: false, error: "Invalid import data" });
      expect(body.details).toEqual([
        expect.objectContaining({
          row: 2,
          fieldErrors: { [field]: [message] },
        }),
      ]);
      expect(mockPrisma.automation.create).not.toHaveBeenCalled();
    }
  );

  it.each(["javascript:alert(1)", "ftp://example.com/guide", ""])(
    "keeps no link for %j under the older key",
    async (trackedUrl) => {
      const response = await importCampaigns(
        importRequest([{ ...olderRow, trackedUrl }])
      );

      expect(response.status).toBe(200);
      expect(createData()).not.toHaveProperty("trackedLinks");
    }
  );

  it("reads empty cells of the older format as not given", async () => {
    const response = await importCampaigns(
      importRequest([
        { ...olderRow, name: " ", goal: "", postUrl: "", publicReplyMessage: "" },
      ])
    );

    expect(response.status).toBe(200);
    expect(createData()).toMatchObject({
      name: "Imported: GUIDE",
      goal: null,
      postUrl: null,
      publicReplyEnabled: false,
      publicReplyMessages: [],
      publicReplyMessage: null,
    });
  });

  it("binds every campaign to its own post", async () => {
    await importCampaigns(
      importRequest([{ ...olderRow, matchAnyPost: true, pendingNextReel: true }])
    );

    expect(createData()).toMatchObject({
      postId: "media_1",
      matchAnyPost: false,
      pendingNextReel: false,
    });
  });

  it("skips a post that already has a campaign, also within the import", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([{ postId: "media_1" }]);

    const response = await importCampaigns(
      importRequest([
        olderRow,
        { ...olderRow, postId: "media_2" },
        { ...olderRow, postId: "media_2" },
      ])
    );

    expect(await response.json()).toEqual({
      success: true,
      data: {
        created: [{ name: "Imported: GUIDE", postId: "media_2" }],
        skipped: [
          { row: 1, reason: "a campaign already exists for this post" },
          { row: 3, reason: "a campaign already exists for this post" },
        ],
      },
    });
    expect(mockPrisma.automation.create).toHaveBeenCalledTimes(1);
  });
});
