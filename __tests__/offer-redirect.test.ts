import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, afterCallbacks } = vi.hoisted(() => ({
  mockPrisma: {
    offer: {
      findUnique: vi.fn(),
    },
    contactOffer: {
      findMany: vi.fn(),
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
};

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
