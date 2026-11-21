import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockWorkspaceId, mockContext, mockDel, afterCallbacks } = vi.hoisted(() => {
  const mockPrisma = {
    offer: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    contactOffer: {
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    automation: {
      updateManyAndReturn: vi.fn(),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return {
    mockPrisma,
    mockWorkspaceId: vi.fn(),
    mockContext: vi.fn(),
    mockDel: vi.fn(),
    afterCallbacks: [] as (() => unknown)[],
  };
});

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: vi.fn(),
  getCurrentWorkspaceId: mockWorkspaceId,
}));

// The real role check; only the signed-in context is replaced.
vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/workspace-access")>()),
  getCurrentWorkspaceContext: mockContext,
}));

// Card images uploaded in the editor live in Vercel Blob; nothing here
// reaches a store.
vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: mockDel }));

// after() runs its callback once the response is out. Collected here, so a
// test sees what the response did before it and runs the callbacks itself.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => {
    afterCallbacks.push(callback);
  },
}));

import { DELETE, GET, PATCH, POST, PUT } from "../app/api/offers/route";
import { OFFER_ORDER } from "../lib/offers/schedule";

const WORKSPACE = "workspace_123";
// 11 units of text plus five emoji of two units each: 21 UTF-16 units but
// only 16 code points, so zod's own .max(20) would let it through.
const LABEL_21_UNITS = "Ja, gerne! 🙌🙌🙌🙌🙌";
// The last offer message carries the button, and Instagram cuts the text of
// a button message after 640 units. 641 units are 640 code points here.
const TEXT_641_UNITS = `${"a".repeat(639)}🙌`;
const TEXT_640_UNITS = `${"a".repeat(638)}🙌`;
const DRIVE_URL =
  "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing";

const validOffer = {
  name: "Prompting Guide",
  offerMessages: [
    "Ich hab übrigens noch einen ausführlichen Guide geschrieben.",
    "Soll ich ihn dir schicken? Da du mir folgst, ist er für dich kostenlos :)",
  ],
  offerDelaysSeconds: [5, 2],
  offerButtonLabel: "Ja, gerne! 🙌",
  confirmationMessages: ["Alles klar!", "Hier geht's zum Guide 👇"],
  confirmationDelaysSeconds: [3, 3],
  cardImageUrl: "https://cdn.example.com/guide-cover.jpg",
  cardTitle: "ChatGPT Prompting Guide",
  cardSubtitle: "In 7 Schritten zu besseren Antworten",
  cardButtonLabel: "Jetzt holen",
  destinationUrl: "https://example.com/guide",
  reminderEnabled: true,
  reminderDelayHours: 23,
  reminderMessage:
    "Hey, nur kurz zur Info: Der Guide ist nicht ewig kostenlos, aber du kannst ihn dir hier noch holen 👇",
  tagOffered: "Guide angeboten",
  tagInterested: "Guide Interesse",
  tagSent: "[LM] Guide gesendet",
  tagClicked: "Guide geklickt",
};

function storedOffer(overrides: Record<string, unknown> = {}) {
  return {
    id: "offer_1",
    workspaceId: WORKSPACE,
    isActive: true,
    position: 0,
    archivedAt: null,
    linkSlug: "slug_offer_1",
    createdAt: new Date("2026-11-20T10:00:00.000Z"),
    updatedAt: new Date("2026-11-20T10:00:00.000Z"),
    ...validOffer,
    ...overrides,
  };
}

function apiRequest(method: string, query = "", body?: unknown) {
  return new NextRequest(`https://app.example.com/api/offers${query}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
  });
}

const post = (body: unknown) => POST(apiRequest("POST", "", body));
const patch = (body: unknown, query = "?id=offer_1") =>
  PATCH(apiRequest("PATCH", query, body));
const put = (body: unknown) => PUT(apiRequest("PUT", "", body));
const remove = (query = "?id=offer_1") => DELETE(apiRequest("DELETE", query));

// One request per write method, each with a body that passes validation.
const WRITES = {
  POST: () => post(validOffer),
  PATCH: () => patch({ isActive: false }),
  PUT: () => put({ order: ["offer_1"] }),
  DELETE: () => remove(),
} as const;

function createData() {
  return mockPrisma.offer.create.mock.calls[0][0].data;
}

function expectNoWrites() {
  expect(mockPrisma.offer.create).not.toHaveBeenCalled();
  expect(mockPrisma.offer.update).not.toHaveBeenCalled();
  expect(mockPrisma.offer.updateMany).not.toHaveBeenCalled();
  expect(mockPrisma.offer.delete).not.toHaveBeenCalled();
  expect(mockPrisma.automation.updateManyAndReturn).not.toHaveBeenCalled();
  expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
}

/**
 * The statement that switches offers off for the campaigns whose own order
 * holds only this offer: emptied, that order would read as the default one.
 */
function expectOffersOffFor(offerId: string) {
  expect(mockPrisma.automation.updateManyAndReturn).toHaveBeenCalledTimes(1);
  expect(mockPrisma.automation.updateManyAndReturn).toHaveBeenCalledWith({
    where: { workspaceId: WORKSPACE, offersEnabled: true, offerIds: { equals: [offerId] } },
    data: { offersEnabled: false },
    select: { id: true, name: true },
  });
}

/** The statement that takes an offer out of every campaign's custom order. */
function expectOrderCleanup(offerId: string) {
  expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  const [sql, ...values] = mockPrisma.$executeRaw.mock.calls[0];
  expect((sql as string[]).join("?")).toBe(
    'UPDATE "Automation" SET "offerIds" = array_remove("offerIds", ?) WHERE "workspaceId" = ? AND ? = ANY("offerIds")'
  );
  expect(values).toEqual([offerId, WORKSPACE, offerId]);
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  // No Blob store, whatever the shell running the tests has set.
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  mockWorkspaceId.mockResolvedValue(WORKSPACE);
  mockContext.mockResolvedValue({ workspaceId: WORKSPACE, role: "OWNER" });
  mockPrisma.offer.findMany.mockResolvedValue([{ id: "offer_1" }]);
  // As the lookup selects it: PATCH reads the id and the card image, DELETE
  // also the mark the worker sets once the offer was first started for
  // someone.
  mockPrisma.offer.findFirst.mockResolvedValue({
    id: "offer_1",
    firstOfferedAt: null,
    cardImageUrl: null,
  });
  mockPrisma.offer.count.mockResolvedValue(0);
  mockDel.mockResolvedValue(undefined);
  mockPrisma.offer.aggregate.mockResolvedValue({ _max: { position: null } });
  mockPrisma.offer.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) =>
      storedOffer({ id: "offer_new", ...data })
  );
  mockPrisma.offer.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      storedOffer({ id: where.id, ...data })
  );
  mockPrisma.offer.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.offer.delete.mockResolvedValue(storedOffer());
  mockPrisma.contactOffer.groupBy.mockResolvedValue([]);
  mockPrisma.contactOffer.count.mockResolvedValue(0);
  mockPrisma.automation.updateManyAndReturn.mockResolvedValue([]);
  mockPrisma.$executeRaw.mockResolvedValue(0);
  mockPrisma.$transaction.mockImplementation(async (operations: unknown) =>
    Array.isArray(operations) ? Promise.all(operations) : operations
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("access to /api/offers", () => {
  it("answers 401 to a read without a workspace", async () => {
    mockWorkspaceId.mockResolvedValue(null);

    const response = await GET(apiRequest("GET"));

    expect(response.status).toBe(401);
    expect(mockPrisma.offer.findMany).not.toHaveBeenCalled();
  });

  it.each(Object.keys(WRITES) as (keyof typeof WRITES)[])(
    "answers 401 to %s without a workspace",
    async (method) => {
      mockContext.mockResolvedValue(null);

      const response = await WRITES[method]();

      expect(response.status).toBe(401);
      expectNoWrites();
    }
  );

  it.each(Object.keys(WRITES) as (keyof typeof WRITES)[])(
    "refuses %s to a member",
    async (method) => {
      mockContext.mockResolvedValue({ workspaceId: WORKSPACE, role: "MEMBER" });

      const response = await WRITES[method]();

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        success: false,
        error: "Only owners and admins can manage offers",
      });
      expectNoWrites();
    }
  );

  it("lets an admin create an offer", async () => {
    mockContext.mockResolvedValue({ workspaceId: WORKSPACE, role: "ADMIN" });

    const response = await post(validOffer);

    expect(response.status).toBe(201);
  });
});

describe("GET /api/offers", () => {
  it("lists the current offers in the default order, each with its link and funnel from one groupBy", async () => {
    mockPrisma.offer.findMany.mockResolvedValue([
      storedOffer({ id: "offer_1", linkSlug: "slug_1" }),
      storedOffer({ id: "offer_2", linkSlug: "slug_2", position: 1 }),
    ]);
    mockPrisma.contactOffer.groupBy.mockResolvedValue([
      {
        offerId: "offer_1",
        _count: { _all: 10, interestedAt: 4, sentAt: 6, clickedAt: 3, stoppedAt: 1 },
      },
      // An archived offer's rows: in the counts, not in the list.
      {
        offerId: "offer_archived",
        _count: { _all: 2, interestedAt: 2, sentAt: 2, clickedAt: 2, stoppedAt: 0 },
      },
    ]);

    const response = await GET(apiRequest("GET"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockPrisma.offer.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, archivedAt: null },
      orderBy: OFFER_ORDER,
    });
    expect(mockPrisma.contactOffer.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.groupBy).toHaveBeenCalledWith({
      by: ["offerId"],
      where: { workspaceId: WORKSPACE },
      _count: {
        _all: true,
        interestedAt: true,
        sentAt: true,
        clickedAt: true,
        stoppedAt: true,
      },
    });

    const { success, data } = await response.json();
    expect(success).toBe(true);
    expect(data.map((offer: { id: string }) => offer.id)).toEqual([
      "offer_1",
      "offer_2",
    ]);
    expect(data[0].trackedUrl).toMatch(/\/o\/slug_1$/);
    expect(data[0].funnel).toEqual({
      offered: 10,
      interested: 4,
      sent: 6,
      clicked: 3,
      stopped: 1,
    });
    // Nobody got the second offer yet.
    expect(data[1].funnel).toEqual({
      offered: 0,
      interested: 0,
      sent: 0,
      clicked: 0,
      stopped: 0,
    });
  });

  it("adds archived offers only on request", async () => {
    await GET(apiRequest("GET", "?archived=1"));

    expect(mockPrisma.offer.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE },
      orderBy: OFFER_ORDER,
    });
  });
});

describe("POST /api/offers", () => {
  it("creates the offer at the end of the default order with a fresh link slug", async () => {
    mockPrisma.offer.aggregate.mockResolvedValue({ _max: { position: 4 } });

    const response = await post(validOffer);

    expect(response.status).toBe(201);
    expect(mockPrisma.offer.aggregate).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, archivedAt: null },
      _max: { position: true },
    });
    const data = createData();
    expect(data).toMatchObject({
      ...validOffer,
      workspaceId: WORKSPACE,
      position: 5,
    });
    // generateTrackedLinkSlug: 7 random bytes in base64url.
    expect(data.linkSlug).toMatch(/^[A-Za-z0-9_-]{10}$/);
    // Left out, the column's default (active) applies.
    expect(data.isActive).toBeUndefined();

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.trackedUrl).toMatch(new RegExp(`/o/${data.linkSlug}$`));
  });

  it("puts the first offer at position 0", async () => {
    await post(validOffer);

    expect(createData().position).toBe(0);
  });

  it("takes neither the workspace nor the slug, position, archive time or offered mark from the body", async () => {
    await post({
      ...validOffer,
      workspaceId: "workspace_other",
      linkSlug: "chosen-slug",
      position: 99,
      archivedAt: "2026-11-01T00:00:00.000Z",
      firstOfferedAt: "2026-11-01T00:00:00.000Z",
    });

    const data = createData();
    expect(data.workspaceId).toBe(WORKSPACE);
    expect(data.linkSlug).not.toBe("chosen-slug");
    expect(data.position).toBe(0);
    expect(data).not.toHaveProperty("archivedAt");
    // Only the worker sets it, when the offer is first started for someone.
    expect(data).not.toHaveProperty("firstOfferedAt");
  });

  it("draws a new slug once when the first one is taken", async () => {
    mockPrisma.offer.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const response = await post(validOffer);

    expect(response.status).toBe(201);
    expect(mockPrisma.offer.create).toHaveBeenCalledTimes(2);
    const [first, second] = mockPrisma.offer.create.mock.calls.map(
      ([args]) => args.data.linkSlug
    );
    expect(second).not.toBe(first);
  });

  it("does not retry any other database error", async () => {
    mockPrisma.offer.create.mockRejectedValueOnce(new Error("connection lost"));

    await expect(post(validOffer)).rejects.toThrow("connection lost");
    expect(mockPrisma.offer.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 21-unit button label with an emoji", { offerButtonLabel: LABEL_21_UNITS }, "offerButtonLabel", "At most 20 characters (emoji count as 2)"],
    ["a 21-unit card button label", { cardButtonLabel: LABEL_21_UNITS }, "cardButtonLabel", "At most 20 characters (emoji count as 2)"],
    ["an 81-character card title", { cardTitle: "a".repeat(81) }, "cardTitle", "At most 80 characters (emoji count as 2)"],
    ["an 81-character card subtitle", { cardSubtitle: "a".repeat(81) }, "cardSubtitle", "At most 80 characters (emoji count as 2)"],
    [
      "a 641-unit last offer message",
      { offerMessages: ["Kurz.", TEXT_641_UNITS] },
      "offerMessages",
      "The last offer message carries the button: at most 640 characters (emoji count as 2)",
    ],
    ["a delay count that does not match the offer messages", { offerDelaysSeconds: [5] }, "offerDelaysSeconds", "Give one delay per offer message"],
    [
      "a delay count that does not match the confirmations",
      { confirmationDelaysSeconds: [3] },
      "confirmationDelaysSeconds",
      "Give one delay per confirmation message",
    ],
    ["a delay over 60 seconds", { offerDelaysSeconds: [5, 61] }, "offerDelaysSeconds", undefined],
    ["reminderDelayHours 24", { reminderDelayHours: 24 }, "reminderDelayHours", undefined],
    ["a reminder without its text", { reminderMessage: "   " }, "reminderMessage", "Write the reminder, or turn it off"],
    ["a 641-unit reminder", { reminderMessage: TEXT_641_UNITS }, "reminderMessage", "At most 640 characters (emoji count as 2)"],
    ["an http image URL", { cardImageUrl: "http://cdn.example.com/guide-cover.jpg" }, "cardImageUrl", undefined],
    ["a javascript: destination", { destinationUrl: "javascript:alert(1)" }, "destinationUrl", undefined],
    ["a mailto: destination", { destinationUrl: "mailto:someone@example.com" }, "destinationUrl", undefined],
    ["no offer message", { offerMessages: [], offerDelaysSeconds: [] }, "offerMessages", undefined],
    ["six offer messages", { offerMessages: ["1", "2", "3", "4", "5", "6"], offerDelaysSeconds: [0, 0, 0, 0, 0, 0] }, "offerMessages", undefined],
    ["an empty tag", { tagClicked: "  " }, "tagClicked", undefined],
  ])("rejects %s", async (_case, change, field, message) => {
    const response = await post({ ...validOffer, ...change });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ success: false, error: "Invalid input" });
    expect(body.details.fieldErrors[field]).toHaveLength(1);
    if (message) expect(body.details.fieldErrors[field]).toEqual([message]);
    expect(mockPrisma.offer.create).not.toHaveBeenCalled();
  });

  it("accepts a Google Drive share link, a 640-unit last message and a 20-unit label", async () => {
    const response = await post({
      ...validOffer,
      destinationUrl: DRIVE_URL,
      // Only the last message carries the button: the others keep 1000.
      offerMessages: [TEXT_641_UNITS, TEXT_640_UNITS],
      offerButtonLabel: "Ja, gerne!! 🙌🙌🙌🙌",
    });

    expect(response.status).toBe(201);
    expect(createData()).toMatchObject({
      destinationUrl: DRIVE_URL,
      offerMessages: [TEXT_641_UNITS, TEXT_640_UNITS],
      offerButtonLabel: "Ja, gerne!! 🙌🙌🙌🙌",
    });
  });

  it("saves an offer without image, subtitle, confirmations or reminder", async () => {
    const response = await post({
      ...validOffer,
      cardImageUrl: null,
      cardSubtitle: "  ",
      confirmationMessages: undefined,
      confirmationDelaysSeconds: undefined,
      reminderEnabled: false,
      reminderMessage: "",
    });

    expect(response.status).toBe(201);
    expect(createData()).toMatchObject({
      cardImageUrl: null,
      cardSubtitle: null,
      confirmationMessages: [],
      confirmationDelaysSeconds: [],
      reminderEnabled: false,
      reminderMessage: null,
    });
  });

  // The editor sends what its field holds, and a blank image field holds "".
  it.each([
    ["an empty image URL", ""],
    ["an image URL of spaces", "   "],
  ])("saves %s as no image", async (_case, cardImageUrl) => {
    const created = await post({ ...validOffer, cardImageUrl });
    expect(created.status).toBe(201);
    expect(createData().cardImageUrl).toBeNull();

    const edited = await patch({ ...validOffer, cardImageUrl });
    expect(edited.status).toBe(200);
    expect(mockPrisma.offer.update.mock.calls[0][0].data.cardImageUrl).toBeNull();
  });

  it("trims the image URL before checking it", async () => {
    const response = await post({
      ...validOffer,
      cardImageUrl: "  https://cdn.example.com/guide-cover.jpg ",
    });

    expect(response.status).toBe(201);
    expect(createData().cardImageUrl).toBe("https://cdn.example.com/guide-cover.jpg");
  });

  it("answers a malformed body with 400", async () => {
    const response = await post("{not json");

    expect(response.status).toBe(400);
    expect(mockPrisma.offer.create).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/offers", () => {
  it("pauses an offer with { isActive: false } alone", async () => {
    const response = await patch({ isActive: false });

    expect(response.status).toBe(200);
    expect(mockPrisma.offer.findFirst).toHaveBeenCalledWith({
      where: { id: "offer_1", workspaceId: WORKSPACE, archivedAt: null },
      select: { id: true, cardImageUrl: true },
    });
    expect(mockPrisma.offer.update).toHaveBeenCalledWith({
      where: { id: "offer_1", workspaceId: WORKSPACE },
      data: { isActive: false },
    });
    const body = await response.json();
    expect(body.data).toMatchObject({ id: "offer_1", isActive: false });
  });

  it("saves a whole offer and leaves the pause switch alone without isActive", async () => {
    const response = await patch({ ...validOffer, cardTitle: "  New title  " });

    expect(response.status).toBe(200);
    const { data } = mockPrisma.offer.update.mock.calls[0][0];
    expect(data).toMatchObject({ ...validOffer, cardTitle: "New title" });
    expect(data).not.toHaveProperty("isActive");
    // Slug, position and workspace are never edited.
    expect(data).not.toHaveProperty("linkSlug");
    expect(data).not.toHaveProperty("position");
    expect(data).not.toHaveProperty("workspaceId");
  });

  it("clears what a whole offer leaves out, except the pause switch", async () => {
    const body: Record<string, unknown> = { ...validOffer, reminderEnabled: false };
    for (const field of [
      "cardImageUrl",
      "cardSubtitle",
      "confirmationMessages",
      "confirmationDelaysSeconds",
      "reminderMessage",
    ]) {
      delete body[field];
    }

    const response = await patch(body);

    expect(response.status).toBe(200);
    const { data } = mockPrisma.offer.update.mock.calls[0][0];
    expect(data).toMatchObject({
      cardImageUrl: null,
      cardSubtitle: null,
      confirmationMessages: [],
      confirmationDelaysSeconds: [],
      reminderEnabled: false,
      reminderMessage: null,
    });
    expect(data).not.toHaveProperty("isActive");
  });

  it("names the field that failed in a whole offer that also carries isActive", async () => {
    const response = await patch({
      ...validOffer,
      isActive: true,
      offerButtonLabel: LABEL_21_UNITS,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.details.fieldErrors.offerButtonLabel).toEqual([
      "At most 20 characters (emoji count as 2)",
    ]);
    expect(mockPrisma.offer.update).not.toHaveBeenCalled();
  });

  it.each([
    ["isActive with a single other field", { isActive: false, name: "Renamed" }],
    ["a part of an offer", { name: "Renamed" }],
    ["isActive that is not a boolean", { isActive: "no" }],
  ])("rejects %s", async (_case, body) => {
    const response = await patch(body);

    expect(response.status).toBe(400);
    expect(mockPrisma.offer.update).not.toHaveBeenCalled();
  });

  it.each([["another workspace's"], ["an archived"]])(
    "answers 404 for %s offer",
    async () => {
      // The lookup is scoped to the workspace and to current offers, so
      // neither is found.
      mockPrisma.offer.findFirst.mockResolvedValue(null);

      const response = await patch({ isActive: false });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error: "Offer not found",
      });
      expect(mockPrisma.offer.findFirst).toHaveBeenCalledWith({
        where: { id: "offer_1", workspaceId: WORKSPACE, archivedAt: null },
        select: { id: true, cardImageUrl: true },
      });
      expect(mockPrisma.offer.update).not.toHaveBeenCalled();
    }
  );

  it("needs the offer's id", async () => {
    const response = await patch({ isActive: false }, "");

    expect(response.status).toBe(400);
    expect(mockPrisma.offer.update).not.toHaveBeenCalled();
  });
});

describe("PUT /api/offers", () => {
  beforeEach(() => {
    mockPrisma.offer.findMany.mockResolvedValue([
      { id: "offer_a" },
      { id: "offer_b" },
      { id: "offer_c" },
    ]);
  });

  it("writes positions 0..n-1 in the given order in one transaction", async () => {
    const response = await put({ order: ["offer_c", "offer_a", "offer_b"] });

    expect(response.status).toBe(200);
    expect(mockPrisma.offer.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, archivedAt: null },
      select: { id: true },
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(3);
    expect(mockPrisma.offer.updateMany.mock.calls.map(([args]) => args)).toEqual([
      { where: { id: "offer_c", workspaceId: WORKSPACE }, data: { position: 0 } },
      { where: { id: "offer_a", workspaceId: WORKSPACE }, data: { position: 1 } },
      { where: { id: "offer_b", workspaceId: WORKSPACE }, data: { position: 2 } },
    ]);
  });

  it.each([
    ["a partial order", ["offer_c", "offer_a"]],
    ["an order with a foreign offer", ["offer_c", "offer_a", "offer_b", "offer_foreign"]],
    ["an order that swaps an offer for a foreign one", ["offer_c", "offer_a", "offer_foreign"]],
    ["an order that repeats an offer", ["offer_c", "offer_a", "offer_a"]],
  ])("rejects %s", async (_case, order) => {
    const response = await put({ order });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "The order must list every offer exactly once",
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.offer.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a body without an order", async () => {
    const response = await put({ offers: ["offer_a"] });

    expect(response.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/offers", () => {
  it("archives an offer someone was offered and takes it out of every campaign's order in one transaction", async () => {
    mockPrisma.contactOffer.count.mockResolvedValue(3);
    const archive = Promise.resolve(storedOffer());
    const offersOff = Promise.resolve([]);
    const cleanup = Promise.resolve(2);
    mockPrisma.offer.update.mockReturnValue(archive);
    mockPrisma.automation.updateManyAndReturn.mockReturnValue(offersOff);
    mockPrisma.$executeRaw.mockReturnValue(cleanup);

    const response = await remove();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { deleted: true, archived: true, campaignsWithoutOffers: [] },
    });
    expect(mockPrisma.contactOffer.count).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, offerId: "offer_1" },
    });
    expect(mockPrisma.offer.update).toHaveBeenCalledWith({
      where: { id: "offer_1", workspaceId: WORKSPACE },
      data: { archivedAt: expect.any(Date), isActive: false },
    });
    expect(mockPrisma.offer.delete).not.toHaveBeenCalled();
    expectOffersOffFor("offer_1");
    expectOrderCleanup("offer_1");
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    const [operations] = mockPrisma.$transaction.mock.calls[0];
    // Offers go off before the cleanup empties the order they are read from.
    expect(operations).toHaveLength(3);
    expect(operations[0]).toBe(archive);
    expect(operations[1]).toBe(offersOff);
    expect(operations[2]).toBe(cleanup);
  });

  it("deletes an offer nobody was offered, with the same cleanup in the same transaction", async () => {
    const deletion = Promise.resolve(storedOffer());
    const offersOff = Promise.resolve([]);
    const cleanup = Promise.resolve(0);
    mockPrisma.offer.delete.mockReturnValue(deletion);
    mockPrisma.automation.updateManyAndReturn.mockReturnValue(offersOff);
    mockPrisma.$executeRaw.mockReturnValue(cleanup);

    const response = await remove();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { deleted: true, archived: false, campaignsWithoutOffers: [] },
    });
    expect(mockPrisma.offer.delete).toHaveBeenCalledWith({
      where: { id: "offer_1", workspaceId: WORKSPACE },
    });
    expect(mockPrisma.offer.update).not.toHaveBeenCalled();
    expectOffersOffFor("offer_1");
    expectOrderCleanup("offer_1");
    const [operations] = mockPrisma.$transaction.mock.calls[0];
    expect(operations).toHaveLength(3);
    expect(operations[0]).toBe(deletion);
    expect(operations[1]).toBe(offersOff);
    expect(operations[2]).toBe(cleanup);
  });

  // Disconnecting an account deletes its contacts and their ContactOffer
  // rows, while the cards stay in their inboxes. The mark the worker set at
  // the first start is still there.
  it("archives an offer that was offered once, though none of its rows is left", async () => {
    mockPrisma.offer.findFirst.mockResolvedValue({
      id: "offer_1",
      firstOfferedAt: new Date("2026-11-19T09:00:00.000Z"),
    });
    mockPrisma.contactOffer.count.mockResolvedValue(0);

    const response = await remove();

    expect(await response.json()).toMatchObject({
      success: true,
      data: { deleted: true, archived: true },
    });
    expect(mockPrisma.offer.update).toHaveBeenCalledWith({
      where: { id: "offer_1", workspaceId: WORKSPACE },
      data: { archivedAt: expect.any(Date), isActive: false },
    });
    expect(mockPrisma.offer.delete).not.toHaveBeenCalled();
    // The mark decides: no rows to count.
    expect(mockPrisma.contactOffer.count).not.toHaveBeenCalled();
  });

  // Emptied, a campaign's own order would read as the workspace's default
  // order, and the campaign would start offers nobody picked for it.
  it("switches offers off for campaigns whose own order held only this offer, and names them", async () => {
    mockPrisma.automation.updateManyAndReturn.mockResolvedValue([
      { id: "campaign_reel_12", name: "Reel 12" },
    ]);

    const response = await remove();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        deleted: true,
        archived: false,
        campaignsWithoutOffers: [{ id: "campaign_reel_12", name: "Reel 12" }],
      },
    });
    expectOffersOffFor("offer_1");
    // In the same transaction as the deletion and before the cleanup, which
    // empties the order the statement reads.
    expect(
      mockPrisma.automation.updateManyAndReturn.mock.invocationCallOrder[0]
    ).toBeLessThan(mockPrisma.$executeRaw.mock.invocationCallOrder[0]);
    const [operations] = mockPrisma.$transaction.mock.calls[0];
    expect(operations).toHaveLength(3);
  });

  it.each([["another workspace's"], ["an archived"]])(
    "answers 404 for %s offer",
    async () => {
      mockPrisma.offer.findFirst.mockResolvedValue(null);

      const response = await remove();

      expect(response.status).toBe(404);
      expect(mockPrisma.offer.findFirst).toHaveBeenCalledWith({
        where: { id: "offer_1", workspaceId: WORKSPACE, archivedAt: null },
        select: { id: true, firstOfferedAt: true, cardImageUrl: true },
      });
      expect(mockPrisma.contactOffer.count).not.toHaveBeenCalled();
      expectNoWrites();
    }
  );

  it("needs the offer's id", async () => {
    const response = await remove("");

    expect(response.status).toBe(400);
    expectNoWrites();
  });
});

// Spec D2: an image uploaded in the editor goes once no offer shows it, an
// image hosted anywhere else never. The upload itself and the rules for a
// URL are in offers-image.test.ts.
describe("card images uploaded in the editor", () => {
  // Shaped like a read-write token; a local test value, never a real one.
  const TOKEN = "vercel_blob_rw_teststore_localtestvalue";
  const STORE = "https://teststore.public.blob.vercel-storage.com";
  const UPLOADED = `${STORE}/offers/${WORKSPACE}/cover-AbC123xYz.jpg`;
  const NEW_UPLOAD = `${STORE}/offers/${WORKSPACE}/cover-NeW456qRs.png`;

  async function runAfterCallbacks() {
    for (const callback of afterCallbacks.splice(0)) await callback();
  }

  beforeEach(() => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
    mockPrisma.offer.findFirst.mockResolvedValue({
      id: "offer_1",
      firstOfferedAt: null,
      cardImageUrl: UPLOADED,
    });
  });

  it("tells the editor whether images can be uploaded", async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);

    const withStore = await (await GET(apiRequest("GET"))).json();
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const withoutStore = await (await GET(apiRequest("GET"))).json();

    expect(withStore).toMatchObject({ success: true, imageUploadEnabled: true });
    expect(withoutStore).toMatchObject({ success: true, imageUploadEnabled: false });
  });

  it.each([
    ["replaced by another upload", NEW_UPLOAD],
    ["replaced by a link", "https://cdn.example.com/guide-cover.jpg"],
    ["removed", ""],
  ])("deletes the stored upload once it is %s, after the response", async (_case, cardImageUrl) => {
    const response = await patch({ ...validOffer, cardImageUrl });

    expect(response.status).toBe(200);
    expect(mockDel).not.toHaveBeenCalled();
    await runAfterCallbacks();
    // Archived offers count too: no archivedAt in the lookup.
    expect(mockPrisma.offer.count).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, cardImageUrl: UPLOADED },
    });
    expect(mockDel).toHaveBeenCalledTimes(1);
    expect(mockDel).toHaveBeenCalledWith(UPLOADED, { token: TOKEN });
  });

  it("keeps an upload another offer of the workspace still shows", async () => {
    mockPrisma.offer.count.mockResolvedValue(1);

    await patch({ ...validOffer, cardImageUrl: NEW_UPLOAD });
    await runAfterCallbacks();

    expect(mockDel).not.toHaveBeenCalled();
  });

  it.each([
    ["the pause switch", { isActive: false }],
    ["an edit that keeps the image", { ...validOffer, cardImageUrl: UPLOADED }],
  ])("keeps the image on %s", async (_case, body) => {
    const response = await patch(body);

    expect(response.status).toBe(200);
    expect(afterCallbacks).toHaveLength(0);
    expect(mockDel).not.toHaveBeenCalled();
  });

  it.each([
    ["an image hosted elsewhere", "https://cdn.example.com/guide-cover.jpg"],
    ["another workspace's upload", `${STORE}/offers/workspace_other/cover-AbC123xYz.jpg`],
    ["a file outside the offers folder", `${STORE}/avatars/${WORKSPACE}/cover.jpg`],
  ])("never deletes %s, on an edit or a deletion", async (_case, stored) => {
    mockPrisma.offer.findFirst.mockResolvedValue({
      id: "offer_1",
      firstOfferedAt: null,
      cardImageUrl: stored,
    });

    expect((await patch({ ...validOffer, cardImageUrl: NEW_UPLOAD })).status).toBe(200);
    expect((await remove()).status).toBe(200);
    await runAfterCallbacks();

    expect(mockPrisma.offer.count).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
  });

  it("deletes nothing while no Blob store is connected", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    await patch({ ...validOffer, cardImageUrl: NEW_UPLOAD });
    await remove();

    expect(afterCallbacks).toHaveLength(0);
    expect(mockDel).not.toHaveBeenCalled();
  });

  it("deletes the image of an offer deleted for good, after the response", async () => {
    const response = await remove();

    expect(await response.json()).toMatchObject({ data: { archived: false } });
    expect(mockDel).not.toHaveBeenCalled();
    await runAfterCallbacks();
    expect(mockDel).toHaveBeenCalledWith(UPLOADED, { token: TOKEN });
  });

  it("keeps the image of an archived offer: the cards already sent still show it", async () => {
    mockPrisma.contactOffer.count.mockResolvedValue(2);

    const response = await remove();

    expect(await response.json()).toMatchObject({ data: { archived: true } });
    expect(afterCallbacks).toHaveLength(0);
    expect(mockDel).not.toHaveBeenCalled();
  });

  it("deletes nothing when the edit is refused", async () => {
    const refused = await patch({ ...validOffer, cardImageUrl: NEW_UPLOAD, cardTitle: "" });
    mockPrisma.offer.findFirst.mockResolvedValue(null);
    const missing = await patch({ ...validOffer, cardImageUrl: NEW_UPLOAD });

    expect(refused.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(afterCallbacks).toHaveLength(0);
    expect(mockDel).not.toHaveBeenCalled();
  });
});
