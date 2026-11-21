import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, afterCallbacks } = vi.hoisted(() => ({
  mockPrisma: {
    offer: {
      findUnique: vi.fn(),
    },
    contactOffer: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    contactTag: {
      createMany: vi.fn(),
    },
    linkClick: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  afterCallbacks: [] as (() => unknown)[],
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

// after() runs its callback once the response is out. Collected here, so a
// test sees what the response did before it and runs the callbacks itself.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => {
    afterCallbacks.push(callback);
  },
}));

import { GET } from "../app/o/[slug]/route";

const SLUG = "AbCdEfGhIj";
// Shaped like hashRecipientId output: 22 base64url characters.
const TOKEN = "AbCdEfGhIjKlMnOpQrSt_-";
const INSTAGRAM_BROWSER =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101 (iPhone15,3; iOS 18_1; de_DE; de; scale=3.00; 1290x2796; 654321)";
const DESTINATION =
  "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing";

const offerRow = {
  id: "offer_1",
  workspaceId: "workspace_123",
  destinationUrl: DESTINATION,
  tagClicked: "Guide geklickt",
  signupTrackingEnabled: false,
};
// A person's sign-up code: 24 base64url characters.
const CODE = "SgNuPcOdE_0123456789-xyz";

function open(
  query = `?r=${TOKEN}`,
  { method = "GET", agent = INSTAGRAM_BROWSER }: { method?: string; agent?: string | null } = {}
) {
  return GET(
    new NextRequest(`https://app.example.com/o/${SLUG}${query}`, {
      method,
      headers: agent === null ? {} : { "user-agent": agent },
    }),
    { params: Promise.resolve({ slug: SLUG }) }
  );
}

async function runAfterCallbacks() {
  for (const callback of afterCallbacks.splice(0)) await callback();
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  mockPrisma.offer.findUnique.mockResolvedValue(offerRow);
  mockPrisma.contactOffer.findMany.mockResolvedValue([
    { id: "contact_offer_1", contactId: "contact_1" },
  ]);
  mockPrisma.contactOffer.findFirst.mockResolvedValue({
    id: "contact_offer_1",
    signupToken: CODE,
  });
  mockPrisma.contactOffer.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.contactTag.createMany.mockResolvedValue({ count: 1 });
  // An interactive transaction, run on the same mocks.
  mockPrisma.$transaction.mockImplementation(
    async (run: (tx: typeof mockPrisma) => unknown) => run(mockPrisma)
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("offer redirect /o/<slug>", () => {
  it("sends an unknown slug to the start page without looking for a click", async () => {
    mockPrisma.offer.findUnique.mockResolvedValue(null);

    const response = await open();
    await runAfterCallbacks();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.example.com/");
    expect(mockPrisma.contactOffer.findMany).not.toHaveBeenCalled();
  });

  it("sends a known slug to the offer's destination", async () => {
    const response = await open("");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(DESTINATION);
    expect(mockPrisma.offer.findUnique).toHaveBeenCalledWith({
      where: { linkSlug: SLUG },
      select: {
        id: true,
        workspaceId: true,
        destinationUrl: true,
        tagClicked: true,
        signupTrackingEnabled: true,
      },
    });
  });

  it("records a person's click after the response: the offer's clickedAt and its clicked tag, once", async () => {
    const response = await open();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(DESTINATION);
    // Nothing waits for the database before the redirect.
    expect(afterCallbacks).toHaveLength(1);
    expect(mockPrisma.contactOffer.findMany).not.toHaveBeenCalled();

    await runAfterCallbacks();

    expect(mockPrisma.contactOffer.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_123",
        offerId: "offer_1",
        clickedAt: null,
        contact: { recipientHash: TOKEN },
      },
      select: { id: true, contactId: true },
    });
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: {
        id: "contact_offer_1",
        workspaceId: "workspace_123",
        clickedAt: null,
      },
      data: { clickedAt: expect.any(Date) },
    });
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: "workspace_123", contactId: "contact_1", tag: "Guide geklickt" },
      ],
      skipDuplicates: true,
    });
    // Campaign click rates count campaign links only.
    expect(mockPrisma.linkClick.create).not.toHaveBeenCalled();
  });

  // Once clickedAt is set, later clicks no longer find the row: a tag that
  // failed after it would never be written. So both go in one transaction,
  // and a failed tag write takes clickedAt back with it.
  it("writes clickedAt and the clicked tag in one transaction", async () => {
    const steps: string[] = [];
    const tx = {
      contactOffer: {
        updateMany: vi.fn(async () => {
          steps.push("clickedAt");
          return { count: 1 };
        }),
      },
      contactTag: {
        createMany: vi.fn(async () => {
          steps.push("tag");
          return { count: 1 };
        }),
      },
    };
    mockPrisma.$transaction.mockImplementation(
      async (run: (client: typeof tx) => unknown) => {
        steps.push("begin");
        const result = await run(tx);
        steps.push("commit");
        return result;
      }
    );

    await open();
    await runAfterCallbacks();

    expect(steps).toEqual(["begin", "clickedAt", "tag", "commit"]);
    expect(tx.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "contact_offer_1", workspaceId: "workspace_123", clickedAt: null },
      data: { clickedAt: expect.any(Date) },
    });
    expect(tx.contactTag.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: "workspace_123", contactId: "contact_1", tag: "Guide geklickt" },
      ],
      skipDuplicates: true,
    });
    // Nothing outside the transaction.
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
  });

  it("adds no tag when a click at the same moment already set clickedAt", async () => {
    mockPrisma.contactOffer.updateMany.mockResolvedValue({ count: 0 });

    await open();
    await runAfterCallbacks();

    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
  });

  it("changes nothing on a later click", async () => {
    // clickedAt is set, so the lookup finds no row.
    mockPrisma.contactOffer.findMany.mockResolvedValue([]);

    const response = await open();
    await runAfterCallbacks();

    expect(response.headers.get("location")).toBe(DESTINATION);
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a HEAD request", { method: "HEAD" }],
    ["facebookexternalhit", { agent: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" }],
    ["meta-externalagent", { agent: "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)" }],
    ["meta-externalfetcher", { agent: "meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)" }],
    ["Facebot", { agent: "Facebot" }],
    ["a search crawler", { agent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }],
    ["a request without a user agent", { agent: null }],
  ])("redirects %s without looking for a click", async (_case, options) => {
    const response = await open(`?r=${TOKEN}`, options);
    await runAfterCallbacks();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(DESTINATION);
    expect(mockPrisma.contactOffer.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ["without ?r=", ""],
    ["with an empty ?r=", "?r="],
    ["with a malformed ?r=", "?r=not-a-token"],
    ["with a token one character too long", `?r=${TOKEN}x`],
  ])("redirects a link %s without looking for a click", async (_case, query) => {
    const response = await open(query);
    await runAfterCallbacks();

    expect(response.headers.get("location")).toBe(DESTINATION);
    expect(mockPrisma.contactOffer.findMany).not.toHaveBeenCalled();
  });

  it("still redirects an archived offer, and counts its click", async () => {
    // Deleting an offer someone got archives it: cards already sent must
    // keep working, so the lookup does not filter on archivedAt.
    mockPrisma.offer.findUnique.mockResolvedValue({
      ...offerRow,
      archivedAt: new Date("2026-11-19T12:00:00.000Z"),
      isActive: false,
    });

    const response = await open();
    await runAfterCallbacks();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(DESTINATION);
    expect(mockPrisma.offer.findUnique.mock.calls[0][0].where).toEqual({
      linkSlug: SLUG,
    });
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.linkClick.create).not.toHaveBeenCalled();
  });

  it("keeps the redirect when recording the click fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockPrisma.contactOffer.findMany.mockRejectedValue(new Error("database asleep"));

    const response = await open();
    await expect(runAfterCallbacks()).resolves.toBeUndefined();

    expect(response.headers.get("location")).toBe(DESTINATION);
    expect(consoleError).toHaveBeenCalledWith(
      "[Offer redirect] Click not recorded:",
      expect.any(Error)
    );
  });
});

// The landing page learns who signed up from a personal code (ig=) the
// redirect adds, but only for an offer that reports sign-ups.
describe("offer redirect with sign-up feedback", () => {
  const tracked = { ...offerRow, signupTrackingEnabled: true };

  beforeEach(() => {
    mockPrisma.offer.findUnique.mockResolvedValue(tracked);
  });

  it("adds the person's code to the destination as ig, looked up before the redirect", async () => {
    const response = await open();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${DESTINATION}&ig=${CODE}`);
    // This offer and the link's recipient, in the offer's workspace.
    expect(mockPrisma.contactOffer.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_123",
        offerId: "offer_1",
        contact: { recipientHash: TOKEN },
      },
      orderBy: [{ offeredAt: "desc" }, { id: "desc" }],
      select: { id: true, signupToken: true },
    });
    // The click is still recorded after the response, as before.
    expect(afterCallbacks).toHaveLength(1);
    expect(mockPrisma.contactOffer.findMany).not.toHaveBeenCalled();
    await runAfterCallbacks();
    expect(mockPrisma.contactOffer.findMany).toHaveBeenCalledTimes(1);
  });

  it("creates the code on the person's first click and keeps it in the row", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue({
      id: "contact_offer_1",
      signupToken: null,
    });

    const response = await open();

    const location = new URL(response.headers.get("location")!);
    const code = location.searchParams.get("ig");
    expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(location.searchParams.get("usp")).toBe("sharing");
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "contact_offer_1", workspaceId: "workspace_123", signupToken: null },
      data: { signupToken: code },
    });
  });

  it("keeps the destination's own query and fragment and replaces an ig it carried", async () => {
    mockPrisma.offer.findUnique.mockResolvedValue({
      ...tracked,
      destinationUrl: "https://landing.example/guide?utm_source=instagram&ig=old&q=a%20b#formular",
    });

    const response = await open();

    expect(response.headers.get("location")).toBe(
      `https://landing.example/guide?utm_source=instagram&q=a%20b&ig=${CODE}#formular`
    );
  });

  it("sends the destination as typed when the link's recipient did not get the offer", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(null);

    const response = await open();

    expect(response.headers.get("location")).toBe(DESTINATION);
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["without ?r=", ""],
    ["with a malformed ?r=", "?r=not-a-token"],
  ])("sends the destination as typed for a link %s, without a lookup", async (_case, query) => {
    const response = await open(query);

    expect(response.headers.get("location")).toBe(DESTINATION);
    expect(mockPrisma.contactOffer.findFirst).not.toHaveBeenCalled();
  });

  it("never fails the redirect: a failed lookup sends the destination as typed, and the log names no code", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockPrisma.contactOffer.findFirst.mockRejectedValue(
      Object.assign(new Error(`query failed for ${TOKEN} ${CODE}`), { code: "P1001" })
    );

    const response = await open();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(DESTINATION);
    expect(consoleError).toHaveBeenCalledWith(
      "[Offer redirect] Sign-up code not added:",
      "Error P1001"
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(CODE);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(TOKEN);
  });

  it("sends the destination as typed when writing the new code fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockPrisma.contactOffer.findFirst.mockResolvedValue({
      id: "contact_offer_1",
      signupToken: null,
    });
    mockPrisma.contactOffer.updateMany.mockRejectedValue(new Error("database asleep"));

    const response = await open();

    expect(response.headers.get("location")).toBe(DESTINATION);
  });
});

describe("offer redirect without sign-up feedback", () => {
  it("adds nothing and looks no code up, whatever the link carries", async () => {
    for (const destinationUrl of [DESTINATION, "https://landing.example/guide?ig=typed#formular"]) {
      mockPrisma.offer.findUnique.mockResolvedValue({ ...offerRow, destinationUrl });

      const response = await open();

      expect(response.headers.get("location")).toBe(destinationUrl);
    }
    expect(mockPrisma.contactOffer.findFirst).not.toHaveBeenCalled();
  });
});
