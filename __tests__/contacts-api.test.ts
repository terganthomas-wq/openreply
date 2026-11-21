import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockWorkspaceId, mockContext } = vi.hoisted(() => {
  const mockPrisma = {
    contact: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    contactTag: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    contactOffer: {
      findMany: vi.fn(),
    },
    dmLog: {
      findMany: vi.fn(),
    },
    linkClick: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return {
    mockPrisma,
    mockWorkspaceId: vi.fn(),
    mockContext: vi.fn(),
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

import { DELETE, GET } from "../app/api/contacts/route";
import {
  CONTACT_SEARCH_MIN_LENGTH,
  contactSearchTerm,
  positiveIntParam,
} from "../lib/contacts/query";

const WORKSPACE = "workspace_123";

const CONTACT = {
  id: "contact_1",
  igsid: "17841400000000001",
  username: "anna.k",
  instagramAccountId: "account_row_1",
  recipientHash: "AbCdEfGhIjKlMnOpQrStUv",
  lastInteractionAt: new Date("2026-11-20T10:00:05.000Z"),
  createdAt: new Date("2026-11-20T10:00:00.000Z"),
  updatedAt: new Date("2026-11-20T10:00:05.000Z"),
  instagramAccount: { username: "brand" },
};

// The statements the deletion hands to its transaction. Prisma builds them
// lazily; here each call returns a marker, so a test sees which ones the
// transaction got.
const ANONYMISE = { statement: "anonymise DmLog" };
const DELETE_CLICKS = { statement: "delete LinkClick" };
const DELETE_CONTACT = { statement: "delete Contact" };

const ANONYMISE_SQL =
  'UPDATE "DmLog" SET "commenterId" = \'deleted\', "commenterName" = NULL, "commentText" = \'\', "commentId" = CASE WHEN "commentId" LIKE \'reveal:%\' THEN \'deleted:\' || "id" ELSE "commentId" END WHERE "workspaceId" = ? AND "instagramAccountId" = ? AND "commenterId" = ?';

function apiRequest(method: string, query = "") {
  return new NextRequest(`https://app.example.com/api/contacts${query}`, {
    method,
  });
}

const get = (query = "") => GET(apiRequest("GET", query));
const remove = (query = `?id=${CONTACT.id}`) =>
  DELETE(apiRequest("DELETE", query));

function listArgs() {
  expect(mockPrisma.contact.findMany).toHaveBeenCalledTimes(1);
  return mockPrisma.contact.findMany.mock.calls[0][0];
}

function countWhere() {
  expect(mockPrisma.contact.count).toHaveBeenCalledTimes(1);
  return mockPrisma.contact.count.mock.calls[0][0].where;
}

function expectNoWrites() {
  expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  expect(mockPrisma.linkClick.deleteMany).not.toHaveBeenCalled();
  expect(mockPrisma.contact.delete).not.toHaveBeenCalled();
}

function expectNoHistoryQueries() {
  expect(mockPrisma.contactTag.findMany).not.toHaveBeenCalled();
  expect(mockPrisma.contactOffer.findMany).not.toHaveBeenCalled();
  expect(mockPrisma.dmLog.findMany).not.toHaveBeenCalled();
  expect(mockPrisma.linkClick.findMany).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWorkspaceId.mockResolvedValue(WORKSPACE);
  mockContext.mockResolvedValue({ workspaceId: WORKSPACE, role: "OWNER" });
  mockPrisma.contact.findMany.mockResolvedValue([]);
  mockPrisma.contact.count.mockResolvedValue(0);
  mockPrisma.contact.findFirst.mockResolvedValue(CONTACT);
  mockPrisma.contactTag.groupBy.mockResolvedValue([]);
  mockPrisma.contactTag.findMany.mockResolvedValue([]);
  mockPrisma.contactOffer.findMany.mockResolvedValue([]);
  mockPrisma.dmLog.findMany.mockResolvedValue([]);
  mockPrisma.linkClick.findMany.mockResolvedValue([]);
  mockPrisma.$executeRaw.mockReturnValue(ANONYMISE);
  mockPrisma.linkClick.deleteMany.mockReturnValue(DELETE_CLICKS);
  mockPrisma.contact.delete.mockReturnValue(DELETE_CONTACT);
  mockPrisma.$transaction.mockResolvedValue([2, { count: 3 }, { id: CONTACT.id }]);
});

describe("access to /api/contacts", () => {
  it("answers 401 to the list without a workspace", async () => {
    mockWorkspaceId.mockResolvedValue(null);

    const response = await get();

    expect(response.status).toBe(401);
    expect(mockPrisma.contact.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.groupBy).not.toHaveBeenCalled();
  });

  it("answers 401 to the tag list without a workspace", async () => {
    mockWorkspaceId.mockResolvedValue(null);

    const response = await get("?view=tags");

    expect(response.status).toBe(401);
    expect(mockPrisma.contactTag.groupBy).not.toHaveBeenCalled();
  });

  it("answers 401 to a contact's history without a workspace", async () => {
    mockContext.mockResolvedValue(null);

    const response = await get(`?id=${CONTACT.id}`);

    expect(response.status).toBe(401);
    expect(mockPrisma.contact.findFirst).not.toHaveBeenCalled();
    expectNoHistoryQueries();
  });

  it("answers 401 to a deletion without a workspace", async () => {
    mockContext.mockResolvedValue(null);

    const response = await remove();

    expect(response.status).toBe(401);
    expect(mockPrisma.contact.findFirst).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("refuses a deletion by a member", async () => {
    mockContext.mockResolvedValue({ workspaceId: WORKSPACE, role: "MEMBER" });

    const response = await remove();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "Only owners and admins can delete contacts",
    });
    expect(mockPrisma.contact.findFirst).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("lets a member read contacts and a contact's history", async () => {
    mockContext.mockResolvedValue({ workspaceId: WORKSPACE, role: "MEMBER" });

    expect((await get()).status).toBe(200);
    const response = await get(`?id=${CONTACT.id}`);

    expect(response.status).toBe(200);
    // No delete button for them.
    expect((await response.json()).data.canManage).toBe(false);
  });
});

describe("GET /api/contacts (the list)", () => {
  it("lists the workspace's contacts by last seen, 20 to a page, never cached", async () => {
    mockPrisma.contact.findMany.mockResolvedValue([{ ...CONTACT, tags: [] }]);
    mockPrisma.contact.count.mockResolvedValue(41);

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const args = listArgs();
    expect(args.where).toEqual({ workspaceId: WORKSPACE });
    expect(countWhere()).toEqual({ workspaceId: WORKSPACE });
    expect(args.orderBy).toEqual([{ updatedAt: "desc" }, { id: "asc" }]);
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
    // The ?r= token stays on the server.
    expect(args.select.recipientHash).toBeUndefined();
    expect(args.select.tags).toEqual({
      select: { tag: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { tag: "asc" }],
    });
    expect(args.select.instagramAccount).toEqual({ select: { username: true } });

    const { success, data } = await response.json();
    expect(success).toBe(true);
    expect(data.contacts.map((contact: { id: string }) => contact.id)).toEqual([
      CONTACT.id,
    ]);
    expect(data.pagination).toEqual({ page: 1, limit: 20, total: 41, totalPages: 3 });
  });

  it("filters usernames by any part in any case and matches an exact IGSID", async () => {
    await get("?q=Anna");

    expect(listArgs().where).toEqual({
      workspaceId: WORKSPACE,
      OR: [
        { username: { contains: "Anna", mode: "insensitive" } },
        { igsid: "Anna" },
      ],
    });
    // The count says how many match the same search.
    expect(countWhere()).toEqual(listArgs().where);
  });

  it("finds a contact by the IGSID as a whole", async () => {
    await get(`?q=${CONTACT.igsid}`);

    expect(listArgs().where.OR).toEqual([
      { username: { contains: CONTACT.igsid, mode: "insensitive" } },
      { igsid: CONTACT.igsid },
    ]);
  });

  it("searches a handle written with its @ without the @", async () => {
    await get(`?q=${encodeURIComponent("  @anna ")}`);

    expect(listArgs().where.OR[0]).toEqual({
      username: { contains: "anna", mode: "insensitive" },
    });
  });

  it.each(["a", "@a", "  ", ""])(
    "lists everyone for the too short search %j",
    async (q) => {
      await get(`?q=${encodeURIComponent(q)}`);

      expect(listArgs().where).toEqual({ workspaceId: WORKSPACE });
    }
  );

  it("filters by a tag through the contact's tags", async () => {
    await get(`?tag=${encodeURIComponent("[LM] Guide gesendet")}`);

    expect(listArgs().where).toEqual({
      workspaceId: WORKSPACE,
      tags: { some: { tag: "[LM] Guide gesendet" } },
    });
  });

  it("reads 'all' accounts as no account filter", async () => {
    await get("?instagramAccountId=all");

    expect(listArgs().where).toEqual({ workspaceId: WORKSPACE });
  });

  it("filters by one account, within the workspace", async () => {
    await get("?instagramAccountId=account_row_2");

    expect(listArgs().where).toEqual({
      workspaceId: WORKSPACE,
      instagramAccountId: "account_row_2",
    });
  });

  it("combines search, tag and account", async () => {
    await get("?q=anna&tag=Guide%20angeboten&instagramAccountId=account_row_2");

    expect(listArgs().where).toEqual({
      workspaceId: WORKSPACE,
      instagramAccountId: "account_row_2",
      tags: { some: { tag: "Guide angeboten" } },
      OR: [
        { username: { contains: "anna", mode: "insensitive" } },
        { igsid: "anna" },
      ],
    });
  });

  it("clamps the page size to 50", async () => {
    mockPrisma.contact.count.mockResolvedValue(120);

    const response = await get("?limit=500");

    expect(listArgs().take).toBe(50);
    expect((await response.json()).data.pagination).toEqual({
      page: 1,
      limit: 50,
      total: 120,
      totalPages: 3,
    });
  });

  it.each([
    ["?page=3&limit=10", 20, 10],
    ["?page=0&limit=0", 0, 20],
    ["?page=-2&limit=-5", 0, 20],
    ["?page=abc&limit=xyz", 0, 20],
  ])("pages %s from offset %i, %i to a page", async (query, skip, take) => {
    await get(query);

    expect(listArgs().skip).toBe(skip);
    expect(listArgs().take).toBe(take);
  });

  it("adds every tag of the workspace with its count to the first page", async () => {
    mockPrisma.contactTag.groupBy.mockResolvedValue([
      { tag: "Guide angeboten", _count: { _all: 12 } },
      { tag: "[LM] Guide gesendet", _count: { _all: 7 } },
    ]);

    const response = await get("?tag=Guide%20angeboten&instagramAccountId=account_row_2");

    expect(mockPrisma.contactTag.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactTag.groupBy).toHaveBeenCalledWith({
      by: ["tag"],
      where: { workspaceId: WORKSPACE },
      _count: { _all: true },
      orderBy: { tag: "asc" },
    });
    expect((await response.json()).data.tagCounts).toEqual([
      { tag: "Guide angeboten", count: 12 },
      { tag: "[LM] Guide gesendet", count: 7 },
    ]);
  });

  it("leaves the tag counts out of later pages", async () => {
    const response = await get("?page=2");

    expect(mockPrisma.contactTag.groupBy).not.toHaveBeenCalled();
    expect((await response.json()).data).not.toHaveProperty("tagCounts");
  });
});

describe("GET /api/contacts?view=tags", () => {
  it("answers with the workspace's tags and counts only", async () => {
    mockPrisma.contactTag.groupBy.mockResolvedValue([
      { tag: "Guide angeboten", _count: { _all: 3 } },
    ]);

    const response = await get("?view=tags");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { tagCounts: [{ tag: "Guide angeboten", count: 3 }] },
    });
    expect(mockPrisma.contactTag.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WORKSPACE } })
    );
    expect(mockPrisma.contact.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.contact.count).not.toHaveBeenCalled();
  });
});

describe("GET /api/contacts?id= (one contact's history)", () => {
  it("answers 404 for a contact of another workspace, as for a missing one", async () => {
    mockPrisma.contact.findFirst.mockResolvedValue(null);

    const response = await get("?id=contact_of_another_workspace");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "Contact not found",
    });
    expect(mockPrisma.contact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "contact_of_another_workspace", workspaceId: WORKSPACE },
      })
    );
    expectNoHistoryQueries();
  });

  it("scopes every history query to the workspace", async () => {
    const response = await get(`?id=${CONTACT.id}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const calls = [
      ...mockPrisma.contactTag.findMany.mock.calls,
      ...mockPrisma.contactOffer.findMany.mock.calls,
      ...mockPrisma.dmLog.findMany.mock.calls,
      ...mockPrisma.linkClick.findMany.mock.calls,
    ];
    expect(calls).toHaveLength(4);
    for (const [args] of calls) {
      expect(args.where.workspaceId).toBe(WORKSPACE);
    }
    expect(mockPrisma.contactTag.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: WORKSPACE,
      contactId: CONTACT.id,
    });
    expect(mockPrisma.contactOffer.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: WORKSPACE,
      contactId: CONTACT.id,
    });
    // An IGSID only means something per account.
    expect(mockPrisma.dmLog.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: WORKSPACE,
      instagramAccountId: CONTACT.instagramAccountId,
      commenterId: CONTACT.igsid,
    });
    expect(mockPrisma.linkClick.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: WORKSPACE,
      recipientHash: CONTACT.recipientHash,
    });
  });

  it("answers with the contact, tags, offers and one timeline, but not the ?r= token", async () => {
    mockContext.mockResolvedValue({ workspaceId: WORKSPACE, role: "ADMIN" });
    mockPrisma.contactTag.findMany.mockResolvedValue([
      { id: "tag_1", tag: "[LM] Prompt gesendet", createdAt: new Date("2026-11-20T10:00:06.000Z") },
    ]);
    mockPrisma.contactOffer.findMany.mockResolvedValue([
      {
        id: "co_1",
        offerId: "offer_1",
        automationId: null,
        offeredAt: new Date("2026-11-20T10:00:07.000Z"),
        pitchSentAt: null,
        interestedAt: null,
        sentAt: null,
        sentVia: null,
        reminderSentAt: null,
        clickedAt: null,
        stoppedAt: null,
        stopReason: null,
        offer: { name: "Guide", archivedAt: null },
        automation: null,
      },
    ]);
    mockPrisma.dmLog.findMany.mockResolvedValue([
      {
        id: "log_tap",
        commentId: `reveal:${CONTACT.igsid}`,
        commentText: "(button tap)",
        status: "SENT",
        createdAt: new Date("2026-11-20T10:00:05.000Z"),
        automationId: "campaign_1",
        automation: { name: "Reel 12" },
      },
      {
        id: "log_comment",
        commentId: "18000000000000001",
        commentText: "Prompt bitte",
        status: "SENT",
        createdAt: new Date("2026-11-20T10:00:00.000Z"),
        automationId: "campaign_1",
        automation: { name: "Reel 12" },
      },
    ]);

    const response = await get(`?id=${CONTACT.id}`);
    const { data } = await response.json();

    expect(data.contact).toEqual({
      id: CONTACT.id,
      igsid: CONTACT.igsid,
      username: CONTACT.username,
      instagramAccountId: CONTACT.instagramAccountId,
      account: "brand",
      lastInteractionAt: CONTACT.lastInteractionAt.toISOString(),
      createdAt: CONTACT.createdAt.toISOString(),
      updatedAt: CONTACT.updatedAt.toISOString(),
    });
    expect(JSON.stringify(data)).not.toContain(CONTACT.recipientHash);
    expect(data.tags).toEqual([
      { tag: "[LM] Prompt gesendet", createdAt: "2026-11-20T10:00:06.000Z" },
    ]);
    expect(data.offers).toHaveLength(1);
    expect(data.timeline.map((event: { key: string }) => event.key)).toEqual([
      "offer:co_1:offered",
      "tag:tag_1",
      "message:log_tap",
      "message:log_comment",
    ]);
    // The offer's campaign is gone.
    expect(data.timeline[0]).toMatchObject({ campaign: null, campaignDeleted: true });
    expect(data.truncated).toEqual({ messages: false, clicks: false });
    expect(data.canManage).toBe(true);
  });

  it("shows the latest 100 DM log rows and 50 clicks and says when there are more", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({
        id: `log_${i}`,
        commentId: `comment_${i}`,
        commentText: "Prompt",
        status: "SENT",
        createdAt: new Date(Date.UTC(2026, 10, 20, 10, 0, 0) - i * 1000),
        automationId: "campaign_1",
        automation: { name: "Reel 12" },
      }))
    );
    mockPrisma.linkClick.findMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => ({
        id: `click_${i}`,
        createdAt: new Date(Date.UTC(2026, 10, 19, 10, 0, 0) - i * 1000),
        automationId: "campaign_1",
        automation: { name: "Reel 12" },
        trackedLink: { destinationUrl: "https://example.com/guide" },
      }))
    );

    const { data } = await (await get(`?id=${CONTACT.id}`)).json();

    expect(mockPrisma.dmLog.findMany.mock.calls[0][0].take).toBe(101);
    expect(mockPrisma.linkClick.findMany.mock.calls[0][0].take).toBe(51);
    const kinds = data.timeline.map((event: { kind: string }) => event.kind);
    expect(kinds.filter((kind: string) => kind === "comment")).toHaveLength(100);
    expect(kinds.filter((kind: string) => kind === "click")).toHaveLength(50);
    expect(data.truncated).toEqual({ messages: true, clicks: true });
  });
});

describe("DELETE /api/contacts?id= (data deletion)", () => {
  it("needs the contact's id", async () => {
    const response = await remove("");

    expect(response.status).toBe(400);
    expect(mockPrisma.contact.findFirst).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("answers 404 for a contact of another workspace and deletes nothing", async () => {
    mockPrisma.contact.findFirst.mockResolvedValue(null);

    const response = await remove("?id=contact_of_another_workspace");

    expect(response.status).toBe(404);
    expect(mockPrisma.contact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "contact_of_another_workspace", workspaceId: WORKSPACE },
      })
    );
    expectNoWrites();
  });

  it.each(["OWNER", "ADMIN"] as const)(
    "lets an %s anonymise the DM log rows, delete the clicks and delete the contact in one transaction",
    async (role) => {
      mockContext.mockResolvedValue({ workspaceId: WORKSPACE, role });

      const response = await remove();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        data: { deleted: true, anonymisedLogs: 2, deletedClicks: 3 },
      });

      // The person's DM log rows lose their IGSID, name and text; button-tap
      // ids, which hold the IGSID, are rewritten.
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      const [sql, ...values] = mockPrisma.$executeRaw.mock.calls[0];
      expect((sql as string[]).join("?")).toBe(ANONYMISE_SQL);
      expect(values).toEqual([WORKSPACE, CONTACT.instagramAccountId, CONTACT.igsid]);

      expect(mockPrisma.linkClick.deleteMany).toHaveBeenCalledWith({
        where: { workspaceId: WORKSPACE, recipientHash: CONTACT.recipientHash },
      });
      // Tags and offer rows go with the contact (cascade).
      expect(mockPrisma.contact.delete).toHaveBeenCalledWith({
        where: { id: CONTACT.id, workspaceId: WORKSPACE },
      });

      // All three in one transaction, in this order.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      const operations = mockPrisma.$transaction.mock.calls[0][0];
      expect(operations).toHaveLength(3);
      expect(operations[0]).toBe(ANONYMISE);
      expect(operations[1]).toBe(DELETE_CLICKS);
      expect(operations[2]).toBe(DELETE_CONTACT);
    }
  );

  it("looks the contact up within the workspace before deleting", async () => {
    await remove();

    expect(mockPrisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: CONTACT.id, workspaceId: WORKSPACE },
      select: {
        id: true,
        instagramAccountId: true,
        igsid: true,
        recipientHash: true,
      },
    });
  });
});

describe("the Contacts list's search rules", () => {
  it("needs at least two characters", () => {
    expect(CONTACT_SEARCH_MIN_LENGTH).toBe(2);
    expect(contactSearchTerm("a")).toBe("");
    expect(contactSearchTerm("an")).toBe("an");
    // Counted in characters: one emoji is not a search.
    expect(contactSearchTerm("🙌")).toBe("");
    expect(contactSearchTerm(null)).toBe("");
    expect(contactSearchTerm(undefined)).toBe("");
  });

  it("drops the @ of a handle and the spaces around it", () => {
    expect(contactSearchTerm(" @@Anna.K ")).toBe("Anna.K");
    expect(contactSearchTerm("@ a")).toBe("");
  });

  it("cuts a runaway search", () => {
    expect(contactSearchTerm("x".repeat(500))).toHaveLength(100);
  });

  it("reads page numbers as whole numbers of at least 1", () => {
    expect(positiveIntParam("3", 1)).toBe(3);
    expect(positiveIntParam("2.9", 1)).toBe(2);
    expect(positiveIntParam("0", 1)).toBe(1);
    expect(positiveIntParam("-4", 20)).toBe(20);
    expect(positiveIntParam("abc", 20)).toBe(20);
    expect(positiveIntParam(null, 20)).toBe(20);
  });
});
