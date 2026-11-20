/**
 * Contacts and tags — the writes that run next to the DM sends.
 *
 * They must be idempotent (a retried job or a redelivered webhook only
 * refreshes the row), never lose what an earlier write stored (a name, a
 * newer interaction, a tag's first timestamp) and, on the send paths, never
 * throw.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    contact: { upsert: vi.fn(), updateMany: vi.fn() },
    contactTag: { createMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  addContactTags,
  ensureContact,
  ensureContactSafe,
  touchContactInteraction,
} from "../lib/contacts/store";
import { hashRecipientId } from "../lib/tracking/server";

const IDENTITY = {
  workspaceId: "workspace_1",
  instagramAccountId: "account_row_1",
  igsid: "igsid_1",
};
const EARLIER = new Date("2026-11-20T09:00:00.000Z");
const NOW = new Date("2026-11-20T10:00:00.000Z");
const LATER = new Date("2026-11-20T11:00:00.000Z");

function storedContact(overrides: Record<string, unknown> = {}) {
  return {
    id: "contact_1",
    username: "reader",
    lastInteractionAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.contact.upsert.mockReset().mockResolvedValue(storedContact());
  mockPrisma.contact.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.contactTag.createMany
    .mockReset()
    .mockResolvedValue({ count: 1 });
});

describe("ensureContact", () => {
  it("creates or refreshes the one row for this account and IGSID", async () => {
    await expect(
      ensureContact({ ...IDENTITY, username: "reader" })
    ).resolves.toEqual(storedContact());

    expect(mockPrisma.contact.upsert).toHaveBeenCalledWith({
      where: {
        instagramAccountId_igsid: {
          instagramAccountId: "account_row_1",
          igsid: "igsid_1",
        },
      },
      create: {
        workspaceId: "workspace_1",
        instagramAccountId: "account_row_1",
        igsid: "igsid_1",
        username: "reader",
        recipientHash: hashRecipientId("igsid_1"),
        lastInteractionAt: null,
      },
      update: { recipientHash: hashRecipientId("igsid_1"), username: "reader" },
      select: { id: true, username: true, lastInteractionAt: true },
    });
  });

  it.each([undefined, null, ""])(
    "never overwrites a stored name with %j",
    async (username) => {
      await ensureContact({ ...IDENTITY, username });

      const [args] = mockPrisma.contact.upsert.mock.calls[0];
      expect(args.update).toEqual({ recipientHash: hashRecipientId("igsid_1") });
      expect(args.create.username).toBeNull();
    }
  );

  it("stamps a new contact with the interaction in the same write", async () => {
    mockPrisma.contact.upsert.mockResolvedValue(
      storedContact({ lastInteractionAt: NOW })
    );

    const contact = await ensureContact({ ...IDENTITY, interactionAt: NOW });

    expect(mockPrisma.contact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ lastInteractionAt: NOW }),
      })
    );
    expect(mockPrisma.contact.updateMany).not.toHaveBeenCalled();
    expect(contact.lastInteractionAt).toEqual(NOW);
  });

  it.each([
    { label: "never interacted", stored: null },
    { label: "interacted earlier", stored: EARLIER },
  ])("moves the interaction forward for a contact that $label", async ({ stored }) => {
    mockPrisma.contact.upsert.mockResolvedValue(
      storedContact({ lastInteractionAt: stored })
    );

    const contact = await ensureContact({ ...IDENTITY, interactionAt: NOW });

    expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "contact_1",
        OR: [{ lastInteractionAt: null }, { lastInteractionAt: { lt: NOW } }],
      },
      data: { lastInteractionAt: NOW },
    });
    expect(contact.lastInteractionAt).toEqual(NOW);
  });

  it.each([
    { label: "a later", stored: LATER },
    { label: "the same", stored: NOW },
  ])("never moves the interaction back from $label time", async ({ stored }) => {
    mockPrisma.contact.upsert.mockResolvedValue(
      storedContact({ lastInteractionAt: stored })
    );

    const contact = await ensureContact({ ...IDENTITY, interactionAt: NOW });

    expect(mockPrisma.contact.updateMany).not.toHaveBeenCalled();
    expect(contact.lastInteractionAt).toEqual(stored);
  });

  it("stamps nothing for a comment, which opens no messaging window", async () => {
    await ensureContact({ ...IDENTITY, username: "reader" });

    expect(mockPrisma.contact.updateMany).not.toHaveBeenCalled();
  });

  it("tries once more when a concurrent job inserted the contact first", async () => {
    mockPrisma.contact.upsert.mockRejectedValueOnce({ code: "P2002" });

    await expect(ensureContact(IDENTITY)).resolves.toEqual(storedContact());
    expect(mockPrisma.contact.upsert).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second conflict", async () => {
    mockPrisma.contact.upsert.mockRejectedValue({ code: "P2002" });

    await expect(ensureContact(IDENTITY)).rejects.toEqual({ code: "P2002" });
    expect(mockPrisma.contact.upsert).toHaveBeenCalledTimes(2);
  });

  it("does not retry any other database error", async () => {
    mockPrisma.contact.upsert.mockRejectedValue(new Error("Database unavailable"));

    await expect(ensureContact(IDENTITY)).rejects.toThrow("Database unavailable");
    expect(mockPrisma.contact.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("ensureContactSafe", () => {
  it("returns the contact", async () => {
    await expect(ensureContactSafe(IDENTITY)).resolves.toEqual(storedContact());
  });

  it("logs a failed write and returns null instead of throwing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockPrisma.contact.upsert.mockRejectedValue(
        new Error("Database unavailable")
      );

      await expect(ensureContactSafe(IDENTITY)).resolves.toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        "[Contacts] Failed to record a contact:",
        "Database unavailable"
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("also returns null when moving the interaction forward fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockPrisma.contact.updateMany.mockRejectedValue(new Error("Timeout"));

      await expect(
        ensureContactSafe({ ...IDENTITY, interactionAt: NOW })
      ).resolves.toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("touchContactInteraction", () => {
  it("updates only a contact whose last interaction is missing or older", async () => {
    await touchContactInteraction("contact_1", NOW);

    expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "contact_1",
        OR: [{ lastInteractionAt: null }, { lastInteractionAt: { lt: NOW } }],
      },
      data: { lastInteractionAt: NOW },
    });
  });
});

describe("addContactTags", () => {
  it("trims, drops empty and repeated tags, and keeps first timestamps", async () => {
    mockPrisma.contactTag.createMany.mockResolvedValue({ count: 2 });

    await expect(
      addContactTags("workspace_1", "contact_1", [
        " [LM] Guide sent ",
        "",
        "   ",
        "[LM] Guide sent",
        "VIP",
      ])
    ).resolves.toBe(2);

    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: "workspace_1", contactId: "contact_1", tag: "[LM] Guide sent" },
        { workspaceId: "workspace_1", contactId: "contact_1", tag: "VIP" },
      ],
      // A tag the contact already has is skipped, not rewritten, so the time
      // it was first set stays.
      skipDuplicates: true,
    });
  });

  it("reports a tag the contact already had as nothing new", async () => {
    mockPrisma.contactTag.createMany.mockResolvedValue({ count: 0 });

    await expect(
      addContactTags("workspace_1", "contact_1", ["VIP"])
    ).resolves.toBe(0);
  });

  it("writes nothing when no tag is left", async () => {
    await expect(
      addContactTags("workspace_1", "contact_1", ["", "  "])
    ).resolves.toBe(0);

    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
  });

  it("caps a runaway list", async () => {
    const tags = Array.from({ length: 150 }, (_, i) => `tag ${i}`);

    await addContactTags("workspace_1", "contact_1", tags);

    const [args] = mockPrisma.contactTag.createMany.mock.calls[0];
    expect(args.data).toHaveLength(100);
    expect(args.data[0].tag).toBe("tag 0");
  });
});
