import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockSyncCampaignLinks } = vi.hoisted(() => {
  const mockPrisma = {
    automation: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    instagramAccount: {
      findFirst: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
    offer: {
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  return { mockPrisma, mockSyncCampaignLinks: vi.fn() };
});

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: vi.fn(),
}));

vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: () => true,
  getCurrentWorkspaceContext: vi.fn(async () => ({
    workspaceId: "workspace_123",
    role: "OWNER",
  })),
}));

vi.mock("@/lib/campaigns/links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/campaigns/links")>()),
  syncCampaignLinks: mockSyncCampaignLinks,
}));

import { PATCH, POST } from "../app/api/automations/route";
import { OFFER_RULE_MESSAGE } from "../lib/campaigns/schema";

// 11 units of text plus five emoji of two units each: 21 UTF-16 units but
// only 16 code points, so zod's own .max(20) would let it through.
const LABEL_21_UNITS = "Ja, gerne! 🙌🙌🙌🙌🙌";
const LABEL_20_UNITS = "Ja, gerne!! 🙌🙌🙌🙌";
// The second follow request goes out as the text of a button message, which
// Instagram cuts after 640 units. 641 units are 640 code points here, so
// zod's own .max(640) would let this through.
const TEXT_641_UNITS = `${"a".repeat(639)}🙌`;
const TEXT_640_UNITS = `${"a".repeat(638)}🙌`;

const newCampaign = {
  name: "Guide drop",
  instagramAccountId: "account_123",
  matchAnyPost: true,
  keywords: ["GUIDE"],
  dmMessage: "Here is your guide {link}",
};

const openingDm = {
  openingDmEnabled: true,
  openingDmMessage: "Want the guide? Tap the button.",
  openingDmButtonLabel: "Ja, schick sie mir",
};

// A campaign saved before this release: the new columns hold their database
// defaults, and its opening-DM label is longer than the new limit of 20
// (the API used to accept 64).
const legacyRow = {
  id: "automation_123",
  workspaceId: "workspace_123",
  instagramAccountId: "account_123",
  name: "Old campaign",
  isActive: true,
  dmMessage: "Here is the link {link}",
  openingDmEnabled: true,
  openingDmMessage: "Tap below for the link",
  openingDmButtonLabel: "Send me the link to the guide please",
  requireFollow: true,
  followPromptMessage: "Follow first, then tap below",
  followPromptButtonLabel: "i'm following",
  ignoreQuestionComments: false,
  followPromptRetryMessage: null,
  followPromptRetryButtonLabel: null,
  deliveryTag: null,
  offersEnabled: false,
  offerIds: [],
};

const offerCampaignRow = {
  ...legacyRow,
  openingDmButtonLabel: "Ja, schick sie mir",
  followPromptRetryMessage: "Still can't see your follow",
  followPromptRetryButtonLabel: "Done now",
  offersEnabled: true,
  offerIds: ["offer_1"],
};

function postRequest(body: unknown) {
  return new NextRequest("https://example.com/api/automations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchRequest(body: unknown) {
  return new NextRequest("https://example.com/api/automations?id=automation_123", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createData() {
  return mockPrisma.automation.create.mock.calls[0][0].data;
}

function updateData() {
  return mockPrisma.automation.update.mock.calls[0][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "workspace_123" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "account_123" });
  mockPrisma.automation.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "automation_new",
      ...data,
    })
  );
  mockPrisma.automation.findFirst.mockResolvedValue(legacyRow);
  mockPrisma.automation.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      ...legacyRow,
      ...data,
    })
  );
  // Every requested offer exists unless a test says otherwise.
  mockPrisma.offer.count.mockImplementation(
    async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length
  );
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
});

describe("POST /api/automations", () => {
  it("refuses offers without an opening DM and names the offers field", async () => {
    const response = await POST(postRequest({ ...newCampaign, offersEnabled: true }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.details.fieldErrors.offersEnabled).toEqual([OFFER_RULE_MESSAGE]);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("refuses offers when the opening DM has no button label", async () => {
    const response = await POST(
      postRequest({
        ...newCampaign,
        ...openingDm,
        openingDmButtonLabel: "  ",
        offersEnabled: true,
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.details.fieldErrors.offersEnabled).toEqual([OFFER_RULE_MESSAGE]);
  });

  it("stores offers in the order given, without duplicates, when the opening DM is complete", async () => {
    const response = await POST(
      postRequest({
        ...newCampaign,
        ...openingDm,
        offersEnabled: true,
        offerIds: ["offer_2", "offer_1", "offer_2"],
      })
    );

    expect(response.status).toBe(201);
    expect(createData()).toMatchObject({
      offersEnabled: true,
      offerIds: ["offer_2", "offer_1"],
    });
    expect(mockPrisma.offer.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_123",
        id: { in: ["offer_2", "offer_1"] },
        archivedAt: null,
      },
    });
  });

  it.each([
    ["a foreign", "offer_other_workspace"],
    ["an archived", "offer_archived"],
  ])("rejects %s offer id as an unknown offer", async (_kind, offerId) => {
    // The count only finds this workspace's offers that are not archived.
    mockPrisma.offer.count.mockResolvedValue(1);

    const response = await POST(
      postRequest({
        ...newCampaign,
        ...openingDm,
        offersEnabled: true,
        offerIds: ["offer_1", offerId],
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Unknown offer",
    });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it.each([
    "openingDmButtonLabel",
    "linkButtonLabel",
    "followPromptButtonLabel",
    "followPromptRetryButtonLabel",
    "secondaryButtonLabel",
  ])("rejects a %s of 21 UTF-16 units", async (field) => {
    const response = await POST(
      postRequest({
        ...newCampaign,
        ...openingDm,
        requireFollow: true,
        [field]: LABEL_21_UNITS,
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.details.fieldErrors[field]).toEqual([
      "At most 20 characters (emoji count as 2)",
    ]);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("accepts a label of exactly 20 UTF-16 units", async () => {
    const response = await POST(
      postRequest({
        ...newCampaign,
        ...openingDm,
        openingDmButtonLabel: LABEL_20_UNITS,
      })
    );

    expect(response.status).toBe(201);
    expect(createData().openingDmButtonLabel).toBe(LABEL_20_UNITS);
  });

  it("rejects a second follow request of 641 UTF-16 units", async () => {
    const response = await POST(
      postRequest({
        ...newCampaign,
        requireFollow: true,
        followPromptRetryMessage: TEXT_641_UNITS,
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.details.fieldErrors.followPromptRetryMessage).toEqual([
      "At most 640 characters (emoji count as 2)",
    ]);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("keeps a second follow request of exactly 640 UTF-16 units", async () => {
    const response = await POST(
      postRequest({
        ...newCampaign,
        requireFollow: true,
        followPromptRetryMessage: TEXT_640_UNITS,
      })
    );

    expect(response.status).toBe(201);
    expect(createData().followPromptRetryMessage).toBe(TEXT_640_UNITS);
  });

  it("still takes 1000 characters for the first follow request", async () => {
    const response = await POST(
      postRequest({
        ...newCampaign,
        requireFollow: true,
        followPromptMessage: "a".repeat(1000),
      })
    );

    expect(response.status).toBe(201);
    expect(createData().followPromptMessage).toHaveLength(1000);
  });

  it("ignores question comments by default, saves an empty tag as none and drops the second follow request without a follow gate", async () => {
    const response = await POST(
      postRequest({
        ...newCampaign,
        requireFollow: false,
        followPromptRetryMessage: "Still not following?",
        followPromptRetryButtonLabel: "Done now",
        deliveryTag: "",
      })
    );

    expect(response.status).toBe(201);
    expect(createData()).toMatchObject({
      ignoreQuestionComments: true,
      deliveryTag: null,
      followPromptRetryMessage: null,
      followPromptRetryButtonLabel: null,
      offersEnabled: false,
      offerIds: [],
    });
    // No offer ids, no query.
    expect(mockPrisma.offer.count).not.toHaveBeenCalled();
  });

  it("keeps the second follow request and a trimmed tag on a follow-gated campaign", async () => {
    const response = await POST(
      postRequest({
        ...newCampaign,
        ignoreQuestionComments: false,
        requireFollow: true,
        followPromptMessage: "Follow me first",
        followPromptRetryMessage: "Still not following?",
        followPromptRetryButtonLabel: "Done now",
        deliveryTag: "  [LM] Guide sent  ",
      })
    );

    expect(response.status).toBe(201);
    expect(createData()).toMatchObject({
      ignoreQuestionComments: false,
      followPromptRetryMessage: "Still not following?",
      followPromptRetryButtonLabel: "Done now",
      deliveryTag: "[LM] Guide sent",
    });
  });

  it("saves a blank tag as no tag", async () => {
    await POST(postRequest({ ...newCampaign, deliveryTag: "   " }));

    expect(createData().deliveryTag).toBeNull();
  });
});

describe("PATCH /api/automations", () => {
  it("toggles a legacy campaign without touching any other field", async () => {
    const response = await PATCH(patchRequest({ isActive: false }));

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "automation_123" },
      data: { isActive: false },
    });
    // Not even as undefined: the update carries exactly what was sent.
    expect(Object.keys(updateData())).toEqual(["isActive"]);
    expect(mockPrisma.offer.count).not.toHaveBeenCalled();
  });

  it("toggles a campaign with offers", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(offerCampaignRow);

    const response = await PATCH(patchRequest({ isActive: false }));

    expect(response.status).toBe(200);
    expect(Object.keys(updateData())).toEqual(["isActive"]);
  });

  it("still pauses a campaign whose stored row breaks the offer rule", async () => {
    // Written outside this API, e.g. by hand in the database. Pausing is the
    // way to stop it, so it must not be refused over fields it leaves alone.
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...offerCampaignRow,
      openingDmEnabled: false,
      openingDmMessage: null,
      openingDmButtonLabel: null,
    });

    const response = await PATCH(patchRequest({ isActive: false }));

    expect(response.status).toBe(200);
    expect(updateData()).toEqual({ isActive: false });
  });

  it("refuses to switch the opening DM off while offers are on", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(offerCampaignRow);

    const response = await PATCH(patchRequest({ openingDmEnabled: false }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.details.fieldErrors.offersEnabled).toEqual([OFFER_RULE_MESSAGE]);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("refuses to clear the opening DM's button while offers are on", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(offerCampaignRow);

    const response = await PATCH(patchRequest({ openingDmButtonLabel: " " }));

    expect(response.status).toBe(400);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("refuses to turn offers on for a campaign without an opening DM", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...legacyRow,
      openingDmEnabled: false,
      openingDmMessage: null,
      openingDmButtonLabel: null,
    });

    const response = await PATCH(patchRequest({ offersEnabled: true }));

    expect(response.status).toBe(400);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("switches offers and the opening DM off together", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(offerCampaignRow);

    const response = await PATCH(
      patchRequest({ offersEnabled: false, openingDmEnabled: false })
    );

    expect(response.status).toBe(200);
    expect(updateData()).toMatchObject({
      offersEnabled: false,
      openingDmEnabled: false,
      openingDmMessage: null,
      openingDmButtonLabel: null,
    });
  });

  it("turns offers on when the request also completes the opening DM", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...legacyRow,
      openingDmEnabled: false,
      openingDmMessage: null,
      openingDmButtonLabel: null,
    });

    const response = await PATCH(
      patchRequest({ ...openingDm, offersEnabled: true })
    );

    expect(response.status).toBe(200);
    expect(updateData()).toMatchObject({ ...openingDm, offersEnabled: true });
  });

  it("clears both second follow request fields when the follow gate goes off", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(offerCampaignRow);

    const response = await PATCH(patchRequest({ requireFollow: false }));

    expect(response.status).toBe(200);
    expect(updateData()).toEqual({
      requireFollow: false,
      followPromptMessage: null,
      followPromptButtonLabel: null,
      followPromptRetryMessage: null,
      followPromptRetryButtonLabel: null,
    });
  });

  it("saves the question filter, the second follow request and a trimmed tag", async () => {
    const response = await PATCH(
      patchRequest({
        ignoreQuestionComments: true,
        followPromptRetryMessage: "Still not following?",
        followPromptRetryButtonLabel: "Done now",
        deliveryTag: " [LM] Guide sent ",
      })
    );

    expect(response.status).toBe(200);
    expect(updateData()).toEqual({
      ignoreQuestionComments: true,
      followPromptRetryMessage: "Still not following?",
      followPromptRetryButtonLabel: "Done now",
      deliveryTag: "[LM] Guide sent",
    });
  });

  it("saves an empty tag as no tag", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...legacyRow,
      deliveryTag: "[LM] Guide sent",
    });

    const response = await PATCH(patchRequest({ deliveryTag: "  " }));

    expect(response.status).toBe(200);
    expect(updateData()).toEqual({ deliveryTag: null });
  });

  it("rejects a label of 21 UTF-16 units", async () => {
    const response = await PATCH(
      patchRequest({ followPromptRetryButtonLabel: LABEL_21_UNITS })
    );

    expect(response.status).toBe(400);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("rejects a second follow request of 641 UTF-16 units", async () => {
    const response = await PATCH(
      patchRequest({ followPromptRetryMessage: TEXT_641_UNITS })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.details.fieldErrors.followPromptRetryMessage).toEqual([
      "At most 640 characters (emoji count as 2)",
    ]);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("checks a new offer order against the workspace's current offers", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(offerCampaignRow);

    const response = await PATCH(
      patchRequest({ offerIds: ["offer_3", "offer_1", "offer_3"] })
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.offer.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_123",
        id: { in: ["offer_3", "offer_1"] },
        archivedAt: null,
      },
    });
    expect(updateData()).toEqual({ offerIds: ["offer_3", "offer_1"] });
  });

  it("rejects an unknown offer in a new order", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(offerCampaignRow);
    mockPrisma.offer.count.mockResolvedValue(0);

    const response = await PATCH(patchRequest({ offerIds: ["offer_foreign"] }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Unknown offer" });
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("clears a custom order without a query", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(offerCampaignRow);

    const response = await PATCH(patchRequest({ offerIds: [] }));

    expect(response.status).toBe(200);
    expect(updateData()).toEqual({ offerIds: [] });
    expect(mockPrisma.offer.count).not.toHaveBeenCalled();
  });
});
