import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "../app/generated/prisma/client";

const { mockPrisma, mockContext, mockI18n } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: {
      updateMany: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  },
  mockContext: vi.fn(),
  mockI18n: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

// Keeps next-auth out of the test; the context below stands in for it.
vi.mock("@/lib/auth", () => ({
  getCurrentUserId: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
}));

// The real role check; only the signed-in context is replaced.
vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/workspace-access")>()),
  getCurrentWorkspaceContext: mockContext,
}));

// The reader's interface language (cookie, else DEFAULT_LOCALE, else en).
vi.mock("@/lib/i18n/server", () => ({
  getI18n: mockI18n,
}));

import * as route from "../app/api/workspace/message-defaults/route";
import {
  BUILT_IN_MESSAGE_DEFAULTS,
  EMPTY_MESSAGE_DEFAULTS,
  type MessageDefaults,
} from "../lib/campaigns/message-defaults";

const { DELETE, GET, PUT } = route;

const WORKSPACE = "workspace_123";
// 21 UTF-16 units, 16 code points: zod's own .max(20) would pass it.
const LABEL_21_UNITS = "Ja, gerne! 🙌🙌🙌🙌🙌";
const german = BUILT_IN_MESSAGE_DEFAULTS.de as MessageDefaults;

// Defaults an admin saved earlier: the German set with their own texts.
const saved: MessageDefaults = {
  ...german,
  campaign: {
    ...german.campaign,
    openingDmMessage: "Hi! Willst du die Checkliste? Tipp unten.",
    publicReplyMessages: ["Schau in deine DMs 📩"],
  },
  offer: { ...german.offer, cardButtonLabel: "Holen" },
};

function signIn(role: "OWNER" | "ADMIN" | "MEMBER", messageDefaults: unknown = null) {
  mockContext.mockResolvedValue({
    userId: "user_1",
    workspaceId: WORKSPACE,
    role,
    workspace: { id: WORKSPACE, name: "Workspace", messageDefaults },
  });
}

function put(body: unknown) {
  return PUT(
    new NextRequest("https://app.example.com/api/workspace/message-defaults", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

// A reset; "?section=campaign" is the campaign editor's.
function remove(query = "") {
  return DELETE(
    new NextRequest(`https://app.example.com/api/workspace/message-defaults${query}`, {
      method: "DELETE",
    })
  );
}

function savedData() {
  expect(mockPrisma.workspace.update).toHaveBeenCalledTimes(1);
  const [{ where, data }] = mockPrisma.workspace.update.mock.calls[0];
  expect(where).toEqual({ id: WORKSPACE });
  return data.messageDefaults;
}

function expectNoWrites() {
  expect(mockPrisma.workspace.updateMany).not.toHaveBeenCalled();
  expect(mockPrisma.workspace.update).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn("OWNER");
  mockI18n.mockResolvedValue({ locale: "de" });
  mockPrisma.workspace.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.workspace.update.mockResolvedValue({ id: WORKSPACE });
  mockPrisma.workspace.findUnique.mockResolvedValue(null);
});

describe("access to /api/workspace/message-defaults", () => {
  it("is never cached", async () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect((await GET()).headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["GET", () => GET()],
    ["PUT", () => put({ campaign: { dmMessage: "Hier" } })],
    ["DELETE", () => remove()],
    ["DELETE ?section=campaign", () => remove("?section=campaign")],
  ])("answers 401 to %s without a workspace", async (_method, call) => {
    mockContext.mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(401);
    expectNoWrites();
  });

  it("lets every member read, and says who may change them", async () => {
    for (const [role, canManage] of [
      ["OWNER", true],
      ["ADMIN", true],
      ["MEMBER", false],
    ] as const) {
      signIn(role, saved);
      const body = await (await GET()).json();
      expect(body, role).toEqual({ success: true, data: { defaults: saved, canManage } });
    }
  });

  it("answers 403 to a PUT by a member and saves nothing", async () => {
    signIn("MEMBER", saved);

    const response = await put({ campaign: { dmMessage: "Hier" } });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "Only owners and admins can change the default texts",
    });
    expectNoWrites();
  });

  it("answers 403 to a DELETE by a member and resets nothing", async () => {
    signIn("MEMBER", saved);

    expect((await remove()).status).toBe(403);
    expect((await remove("?section=campaign")).status).toBe(403);
    expectNoWrites();
  });
});

describe("GET", () => {
  it("seeds a workspace without defaults once with the German set, guarded by DbNull", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { defaults: german, canManage: true },
    });
    expect(mockPrisma.workspace.updateMany).toHaveBeenCalledTimes(1);
    const [{ where, data }] = mockPrisma.workspace.updateMany.mock.calls[0];
    expect(where).toEqual({ id: WORKSPACE, messageDefaults: { equals: Prisma.DbNull } });
    // The very sentinel: Prisma tells SQL NULL from JSON null by identity.
    expect(where.messageDefaults.equals).toBe(Prisma.DbNull);
    expect(data).toEqual({ messageDefaults: german });
    expect(mockPrisma.workspace.update).not.toHaveBeenCalled();
  });

  it("returns null without writing in a language without built-in defaults", async () => {
    mockI18n.mockResolvedValue({ locale: "en" });

    const response = await GET();

    expect(await response.json()).toEqual({
      success: true,
      data: { defaults: null, canManage: true },
    });
    expectNoWrites();
  });

  it("returns saved defaults without writing and without asking for the language", async () => {
    signIn("OWNER", saved);

    expect((await (await GET()).json()).data.defaults).toEqual(saved);
    expectNoWrites();
    expect(mockI18n).not.toHaveBeenCalled();
  });

  it("keeps a workspace seeded with an earlier built-in offer text as it was", async () => {
    // The built-in third offer message used to say the guide is free
    // "because you follow me". Workspaces seeded with it keep it: only the
    // workspace's owners and admins change their texts.
    const seededEarlier: MessageDefaults = {
      ...german,
      offer: {
        ...german.offer,
        offerMessages: [
          ...german.offer.offerMessages.slice(0, 2),
          "Soll ich ihn dir schicken? Da du mir folgst, ist er für dich kostenlos :)",
        ],
      },
    };
    signIn("OWNER", seededEarlier);

    expect((await (await GET()).json()).data.defaults).toEqual(seededEarlier);
    expectNoWrites();
  });

  it("returns what a concurrent save wrote when the seed found the column taken", async () => {
    mockPrisma.workspace.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.workspace.findUnique.mockResolvedValue({ messageDefaults: saved });

    expect((await (await GET()).json()).data.defaults).toEqual(saved);
    expect(mockPrisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: WORKSPACE },
      select: { messageDefaults: true },
    });
  });

  it("shows the built-in set over stored defaults it cannot read, and leaves them", async () => {
    const unreadable = { version: 2, campaign: {} };
    signIn("OWNER", unreadable);
    // The guard does not match a column that holds something.
    mockPrisma.workspace.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.workspace.findUnique.mockResolvedValue({ messageDefaults: unreadable });

    expect((await (await GET()).json()).data.defaults).toEqual(german);
    expect(mockPrisma.workspace.update).not.toHaveBeenCalled();
  });
});

describe("PUT", () => {
  it("merges { campaign } field by field over the saved defaults and persists it", async () => {
    signIn("ADMIN", saved);

    const response = await put({
      campaign: {
        openingDmButtonLabel: "  Klar, her damit ",
        requireFollow: false,
        publicReplyMessages: ["Eins", "Zwei"],
      },
    });

    expect(response.status).toBe(200);
    const expected = {
      ...saved,
      campaign: {
        ...saved.campaign,
        openingDmButtonLabel: "Klar, her damit",
        requireFollow: false,
        publicReplyMessages: ["Eins", "Zwei"],
      },
    };
    expect(savedData()).toEqual(expected);
    // The offer's texts and the offer switch keep their saved values.
    expect(savedData().offer).toEqual(saved.offer);
    expect(savedData().campaign.offersEnabled).toBe(true);
    expect(await response.json()).toEqual({
      success: true,
      data: { defaults: expected, canManage: true },
    });
    expect(mockPrisma.workspace.updateMany).not.toHaveBeenCalled();
  });

  it("merges over the built-in set when nothing is saved yet", async () => {
    await put({ offer: { cardButtonLabel: "Hol ihn dir" } });

    expect(savedData()).toEqual({
      ...german,
      offer: { ...german.offer, cardButtonLabel: "Hol ihn dir" },
    });
  });

  it("merges over empty defaults in a language without a built-in set", async () => {
    mockI18n.mockResolvedValue({ locale: "en" });

    await put({ campaign: { dmMessage: "Here you go", linkButtonLabel: "Get it" } });

    expect(savedData()).toEqual({
      ...EMPTY_MESSAGE_DEFAULTS,
      campaign: {
        ...EMPTY_MESSAGE_DEFAULTS.campaign,
        dmMessage: "Here you go",
        linkButtonLabel: "Get it",
      },
    });
  });

  it("answers 400 to a label over 20 UTF-16 units and names the field", async () => {
    signIn("OWNER", saved);

    const response = await put({ campaign: { openingDmButtonLabel: LABEL_21_UNITS } });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(Object.keys(body.details.fieldErrors)).toEqual(["campaign.openingDmButtonLabel"]);
    expectNoWrites();
  });

  it("answers 400 when the merged defaults break a rule across fields", async () => {
    signIn("OWNER", saved);

    // Two messages, but the saved three pauses stay.
    const response = await put({ offer: { offerMessages: ["Eins", "Zwei"] } });

    expect(response.status).toBe(400);
    expect(Object.keys((await response.json()).details.fieldErrors)).toEqual([
      "offer.offerDelaysSeconds",
    ]);
    expectNoWrites();
  });

  it.each([
    ["an unknown field", { campaign: { openingDmMesage: "typo" } }],
    ["an unknown section", { campaigns: { dmMessage: "Hier" } }],
    ["a body that is not an object", ["campaign"]],
    ["a malformed body", "{"],
  ])("answers 400 to %s", async (_case, body) => {
    const response = await put(body);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid input");
    expectNoWrites();
  });
});

describe("DELETE", () => {
  it("resets to DbNull and returns the built-in set the next read seeds", async () => {
    signIn("ADMIN", saved);

    const response = await remove();

    expect(response.status).toBe(200);
    expect(mockPrisma.workspace.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: WORKSPACE },
      data: { messageDefaults: Prisma.DbNull },
    });
    expect(mockPrisma.workspace.update.mock.calls[0][0].data.messageDefaults).toBe(Prisma.DbNull);
    expect(await response.json()).toEqual({
      success: true,
      data: { defaults: german, canManage: true },
    });
  });

  it("returns null in a language without a built-in set", async () => {
    signIn("OWNER", saved);
    mockI18n.mockResolvedValue({ locale: "en" });

    expect((await (await remove()).json()).data.defaults).toBeNull();
    expect(mockPrisma.workspace.update).toHaveBeenCalledTimes(1);
  });

  it("resets the campaign texts alone with ?section=campaign and keeps the offer's", async () => {
    signIn("ADMIN", saved);

    const response = await remove("?section=campaign");

    expect(response.status).toBe(200);
    // The campaign editor's reset never takes the offers' texts along.
    const expected = { ...saved, campaign: german.campaign };
    expect(savedData()).toEqual(expected);
    expect(savedData().offer).toEqual(saved.offer);
    expect(await response.json()).toEqual({
      success: true,
      data: { defaults: expected, canManage: true },
    });
    expect(mockPrisma.workspace.updateMany).not.toHaveBeenCalled();
  });

  it("resets the offer texts alone with ?section=offer", async () => {
    signIn("OWNER", saved);

    await remove("?section=offer");

    expect(savedData()).toEqual({ ...saved, offer: german.offer });
  });

  it("empties the section in a language without a built-in set and keeps the other", async () => {
    const ownOffer = {
      ...EMPTY_MESSAGE_DEFAULTS.offer,
      offerMessages: ["My own offer"],
      offerDelaysSeconds: [1],
      offerButtonLabel: "Sure!",
    };
    signIn("OWNER", {
      ...EMPTY_MESSAGE_DEFAULTS,
      campaign: { ...EMPTY_MESSAGE_DEFAULTS.campaign, dmMessage: "Here you go" },
      offer: ownOffer,
    });
    mockI18n.mockResolvedValue({ locale: "en" });

    const response = await remove("?section=campaign");

    expect(savedData()).toEqual({ ...EMPTY_MESSAGE_DEFAULTS, offer: ownOffer });
    expect((await response.json()).data.defaults).toEqual({
      ...EMPTY_MESSAGE_DEFAULTS,
      offer: ownOffer,
    });
  });

  it("goes back to DbNull when nothing saved is left to keep", async () => {
    // Only the campaign texts were the admin's own.
    for (const stored of [
      { ...german, campaign: saved.campaign },
      null,
      { version: 2, campaign: {} },
    ]) {
      vi.clearAllMocks();
      signIn("ADMIN", stored);

      const response = await remove("?section=campaign");

      expect(mockPrisma.workspace.update).toHaveBeenCalledExactlyOnceWith({
        where: { id: WORKSPACE },
        data: { messageDefaults: Prisma.DbNull },
      });
      expect(mockPrisma.workspace.update.mock.calls[0][0].data.messageDefaults).toBe(Prisma.DbNull);
      expect((await response.json()).data.defaults).toEqual(german);
    }
  });

  it.each(["?section=campaigns", "?section=", "?section=version"])(
    "answers 400 to %s and resets nothing",
    async (query) => {
      signIn("OWNER", saved);

      const response = await remove(query);

      expect(response.status).toBe(400);
      expect((await response.json()).success).toBe(false);
      expectNoWrites();
    }
  );
});
