/**
 * The offer card and its fallbacks.
 *
 * No generic template has been sent from this install yet, so a refused card
 * must still get its link to the person: as a button message and, when the
 * button template is refused too, as plain text. A refusal of the
 * conversation itself (closed window, rate limit, expired token) must not
 * lead to another send, and a fallback with an unknown outcome must never be
 * sent again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockSendCard, mockSendLinkButton, mockSendText } =
  vi.hoisted(() => ({
    mockPrisma: {
      operationalEvent: { create: vi.fn() },
      zernioConnection: { findUnique: vi.fn() },
    },
    mockSendCard: vi.fn(),
    mockSendLinkButton: vi.fn(),
    mockSendText: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

// Only the three senders the chain uses are replaced. The error classes stay
// the real ones, so the checks see exactly what handleResponse throws.
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  sendDirectMessageWithCard: mockSendCard,
  sendDirectMessageWithLinkButton: mockSendLinkButton,
  sendDirectMessage: mockSendText,
}));

import { DeliveryUnconfirmedError } from "@/lib/instagram/delivery-errors";
import type { CardMessage, InstagramContext } from "@/lib/instagram/provider";
import {
  MetaApiError,
  PermissionError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";
import { isCardRejection, sendOfferCard } from "@/lib/offers/send";
import {
  ZernioApiError,
  ZernioDeliveryUnconfirmedError,
} from "@/lib/zernio/client";

const META: InstagramContext = {
  provider: "META",
  accessToken: "token",
  instagramId: "ig_1",
  unifiedLogin: true,
};
const ZERNIO: InstagramContext = {
  provider: "ZERNIO",
  apiKey: "key",
  accountId: "zernio_account",
  instagramId: "ig_1",
  operationId: "offer-card-op",
};
const CARD: CardMessage = {
  title: "Prompting Guide",
  subtitle: "In 7 Schritten zu besseren Antworten",
  imageUrl: "https://cdn.example.com/cover.jpg",
  button: { title: "Jetzt holen", url: "https://app.example.com/o/abc?r=tok" },
};
const CARD_TEXT = "Prompting Guide\nIn 7 Schritten zu besseren Antworten";
const INPUT = {
  context: META,
  instagramAccountId: "ig_1",
  userId: "igsid_1",
  card: CARD,
  workspaceId: "workspace_1",
};
const SENT = { recipient_id: "igsid_1", message_id: "mid_1" };

const metaError = (code: number, message: string) =>
  new MetaApiError(code, undefined, undefined, message);
const refusedCard = () => metaError(100, "Invalid image_url");
const refusedTemplate = () => metaError(100, "Unsupported template");

beforeEach(() => {
  vi.clearAllMocks();
  mockSendCard.mockReset().mockResolvedValue(SENT);
  mockSendLinkButton.mockReset().mockResolvedValue(SENT);
  mockSendText.mockReset().mockResolvedValue(SENT);
  mockPrisma.operationalEvent.create.mockReset().mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sendOfferCard", () => {
  it("sends the card and reports CARD", async () => {
    await expect(sendOfferCard(INPUT)).resolves.toBe("CARD");

    expect(mockSendCard).toHaveBeenCalledTimes(1);
    expect(mockSendCard).toHaveBeenCalledWith(META, "ig_1", "igsid_1", CARD);
    expect(mockSendLinkButton).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it("sends the card's text with its button once when Meta refuses the card", async () => {
    mockSendCard.mockRejectedValue(refusedCard());

    await expect(sendOfferCard(INPUT)).resolves.toBe("BUTTON");

    expect(mockSendLinkButton).toHaveBeenCalledTimes(1);
    expect(mockSendLinkButton).toHaveBeenCalledWith(
      META,
      "ig_1",
      "igsid_1",
      CARD_TEXT,
      [CARD.button]
    );
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_1",
        source: "WORKER",
        level: "WARNING",
        message: "Offer card fell back to a button message",
        payload: {
          userId: "igsid_1",
          imageUrl: "https://cdn.example.com/cover.jpg",
          error: "MetaApiError 100: Invalid image_url",
        },
      },
    });
  });

  it("falls back on the error handleResponse raises for a refused element", async () => {
    // What a real code-100 answer becomes: a PermissionError whose text names
    // the element, not the template.
    mockSendCard.mockRejectedValue(
      new PermissionError(
        "(#100) Param elements[0][image_url] must be a valid URL (/v25.0/ig_1/messages) [code=100 sub=- type=OAuthException trace=t]",
        "t",
        undefined,
        100
      )
    );

    await expect(sendOfferCard(INPUT)).resolves.toBe("BUTTON");
    expect(mockSendLinkButton).toHaveBeenCalledTimes(1);
  });

  it("sends plain text with the link when the button template is refused as well", async () => {
    mockSendCard.mockRejectedValue(refusedCard());
    mockSendLinkButton.mockRejectedValue(refusedTemplate());

    await expect(sendOfferCard(INPUT)).resolves.toBe("TEXT");

    expect(mockSendLinkButton).toHaveBeenCalledTimes(1);
    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(mockSendText).toHaveBeenCalledWith(
      META,
      "ig_1",
      "igsid_1",
      `${CARD_TEXT}\nhttps://app.example.com/o/abc?r=tok`
    );
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(1);
  });

  it("uses the title alone when the card has no subtitle", async () => {
    mockSendCard.mockRejectedValue(refusedCard());
    mockSendLinkButton.mockRejectedValue(refusedTemplate());

    await sendOfferCard({ ...INPUT, card: { ...CARD, subtitle: null } });

    expect(mockSendText).toHaveBeenCalledWith(
      META,
      "ig_1",
      "igsid_1",
      "Prompting Guide\nhttps://app.example.com/o/abc?r=tok"
    );
  });

  it.each([
    ["a closed messaging window", metaError(10, "outside of allowed window")],
    [
      "a closed window reported as code 100",
      metaError(100, "(#100) Message sent outside of allowed window"),
    ],
    [
      "a person Instagram cannot find",
      metaError(100, "The requested user cannot be found"),
    ],
    // What handleResponse raises when Meta has no such recipient: a code 100
    // that refuses the person, not the card.
    [
      "no matching user",
      new PermissionError(
        "(#100) No matching user found (/v25.0/ig_1/messages) [code=100 sub=2534014 type=OAuthException trace=t]",
        "t",
        2534014,
        100
      ),
    ],
    [
      "a person who cannot be messaged right now",
      metaError(100, "This person isn't available right now"),
    ],
    ["a rate limit", new RateLimitError("Too many calls")],
    ["an expired token", new TokenExpiredError("Session has expired")],
    ["code 200", metaError(200, "Requires instagram_manage_messages")],
    ["an unknown outcome", new Error("socket hang up")],
  ])("sends nothing else after %s", async (_case, error) => {
    mockSendCard.mockRejectedValue(error);

    await expect(sendOfferCard(INPUT)).rejects.toBe(error);

    expect(mockSendCard).toHaveBeenCalledTimes(1);
    expect(mockSendLinkButton).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the button message",
      () => mockSendLinkButton.mockRejectedValue(new Error("socket hang up")),
    ],
    [
      "the plain text",
      () => {
        mockSendLinkButton.mockRejectedValue(refusedTemplate());
        mockSendText.mockRejectedValue(new Error("socket hang up"));
      },
    ],
  ])(
    "reports an unknown outcome of %s as unconfirmed, so it is never sent again",
    async (_step, failFallback) => {
      mockSendCard.mockRejectedValue(refusedCard());
      failFallback();

      const sending = sendOfferCard(INPUT);

      await expect(sending).rejects.toBeInstanceOf(DeliveryUnconfirmedError);
      await expect(sending).rejects.toThrow("socket hang up");
      // The refused card is on record even though the fallback failed.
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ["a closed messaging window", metaError(10, "outside of allowed window")],
    ["a rate limit", new RateLimitError("Too many calls")],
  ])(
    "reports the fallback's own rejection, %s, instead of the refused card",
    async (_case, error) => {
      mockSendCard.mockRejectedValue(refusedCard());
      mockSendLinkButton.mockRejectedValue(error);

      await expect(sendOfferCard(INPUT)).rejects.toBe(error);
      expect(mockSendText).not.toHaveBeenCalled();
    }
  );

  it("still falls back when the event cannot be written", async () => {
    mockSendCard.mockRejectedValue(refusedCard());
    mockPrisma.operationalEvent.create.mockRejectedValue(
      new Error("database unavailable")
    );

    await expect(sendOfferCard(INPUT)).resolves.toBe("BUTTON");
    expect(mockSendLinkButton).toHaveBeenCalledTimes(1);
  });

  it("sends the card through Zernio as its text and button in one request and reports BUTTON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { messageId: "zm_1" } }))
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendOfferCard({ ...INPUT, context: ZERNIO })).resolves.toBe(
      "BUTTON"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      accountId: "zernio_account",
      message: CARD_TEXT,
      buttons: [
        {
          type: "url",
          title: "Jetzt holen",
          url: "https://app.example.com/o/abc?r=tok",
        },
      ],
    });
    expect(mockSendCard).not.toHaveBeenCalled();
    expect(mockSendLinkButton).not.toHaveBeenCalled();
  });

  it("never falls back after a Zernio error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendOfferCard({ ...INPUT, context: ZERNIO })
    ).rejects.toBeInstanceOf(ZernioApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockSendLinkButton).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });
});

describe("isCardRejection", () => {
  it.each([
    ["names the image", metaError(100, "Invalid image_url")],
    ["names the element", metaError(100, "(#100) Param elements[0] is invalid")],
    ["names the attachment", metaError(100, "Unsupported attachment type")],
    ["names the template", metaError(100, "Unsupported template")],
    [
      "comes from handleResponse",
      new PermissionError("(#100) Invalid parameter", "t", undefined, 100),
    ],
  ])("lets the card fall back when a code-100 refusal %s", (_case, error) => {
    expect(isCardRejection(error)).toBe(true);
  });

  it.each([
    ["code 10", metaError(10, "Invalid image_url")],
    ["code 200", metaError(200, "Invalid image_url")],
    ["code 551", metaError(551, "This person isn't available right now")],
    ["Meta error 1", metaError(1, "An unknown error occurred")],
    ["a closed window", metaError(100, "Message outside of allowed window")],
    [
      "an invalid private reply",
      metaError(100, "This message is invalid for a private reply"),
    ],
    ["an unknown person", metaError(100, "The requested user cannot be found")],
    // Refusals of the recipient: a button message would be refused the same
    // way, so the chain ends with the card.
    ["no matching user", metaError(100, "(#100) No matching user found")],
    [
      "no matching user as handleResponse words it",
      new PermissionError(
        "(#100) No matching user found (/v25.0/ig_1/messages) [code=100 sub=2534014 type=OAuthException trace=t]",
        "t",
        2534014,
        100
      ),
    ],
    [
      "a closed window as handleResponse words it",
      new PermissionError(
        "(#100) This message is sent outside of allowed window. (/v25.0/ig_1/messages) [code=100 sub=2534022 type=OAuthException trace=t]",
        "t",
        2534022,
        100
      ),
    ],
    [
      "a person who isn't available",
      metaError(100, "This person isn't available right now."),
    ],
    [
      "a person who isn’t available (typographic apostrophe)",
      metaError(100, "This person isn’t available right now."),
    ],
    ["an unavailable user", metaError(100, "User is unavailable")],
    [
      "a person who is not receiving messages",
      metaError(100, "This person isn't receiving messages from you right now."),
    ],
    // Excluded by class, whatever code they carry.
    [
      "a rate limit",
      new RateLimitError("Invalid image_url", undefined, undefined, 100),
    ],
    ["an expired token", new TokenExpiredError("Invalid image_url")],
    ["a Zernio rejection", new ZernioApiError(100)],
    ["an unconfirmed Zernio send", new ZernioDeliveryUnconfirmedError()],
    ["a network error", new Error("Invalid image_url")],
    ["a non-error", "Invalid image_url"],
  ])("never lets the card fall back after %s", (_case, error) => {
    expect(isCardRejection(error)).toBe(false);
  });
});
