import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateCtr,
  countUniqueClicks,
  countUniqueClicksBy,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "../lib/tracking/analytics";
import { hashRecipientId, parseRecipientToken } from "../lib/tracking/server";
import {
  buildOfferUrl,
  buildTrackedUrl,
  extractFirstUrl,
  renderMessageWithoutLink,
  renderMessageWithTracking,
  replaceUrlWithTrackedPlaceholder,
} from "../lib/tracking/message";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tracked link messages", () => {
  it("extracts a destination URL and replaces it with the tracked placeholder", () => {
    const message =
      "Hey {username}, here is your guide: https://example.com/guide.";
    const url = extractFirstUrl(message);

    expect(url).toBe("https://example.com/guide");
    expect(replaceUrlWithTrackedPlaceholder(message, url)).toBe(
      "Hey {username}, here is your guide: {link}."
    );
  });

  it("renders tracked URLs with username personalization", () => {
    expect(
      renderMessageWithTracking({
        message: "Hey {username}, grab it here: {link}",
        commenterName: "Maya",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/guide",
          },
        ],
        baseUrl: "https://manychat-alternative.com",
      })
    ).toBe("Hey Maya, grab it here: https://manychat-alternative.com/r/abc123");
  });

  it("can replace a raw destination URL when the placeholder is missing", () => {
    expect(
      renderMessageWithTracking({
        message: "Link: https://example.com/guide",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/guide",
          },
        ],
        baseUrl: "https://manychat-alternative.com/",
      })
    ).toBe("Link: https://manychat-alternative.com/r/abc123");
  });

  it("matches normalized root URLs with or without trailing slash", () => {
    expect(
      replaceUrlWithTrackedPlaceholder("Link: https://example.com", "https://example.com/")
    ).toBe("Link: {link}");
    expect(
      renderMessageWithTracking({
        message: "Link: https://example.com",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/",
          },
        ],
        baseUrl: "https://manychat-alternative.com",
      })
    ).toBe("Link: https://manychat-alternative.com/r/abc123");
  });

  it("builds redirect URLs from a base URL", () => {
    expect(buildTrackedUrl("abc123", "https://manychat-alternative.com/")).toBe(
      "https://manychat-alternative.com/r/abc123"
    );
  });
});

describe("messages sent next to a link button", () => {
  // The function as it was before fallbackName existed. Campaign DMs call it
  // without the option, so for them nothing may change, not even a space.
  function renderedBefore({
    message,
    commenterName,
  }: {
    message: string;
    commenterName?: string | null;
  }) {
    return message
      .replace(/\{username\}/gi, commenterName ?? "there")
      .replace(/\s*\{link\}\s*/gi, " ")
      .trim();
  }

  it.each([
    ["Hey {username}! Here is the link: {link}", "Maya"],
    ["Hey {username}! Here is the link: {link}", null],
    ["Hey {username}, tap below {link} now", undefined],
    ["Hey {username} schau", ""],
    ["Hey {username}, schau", ""],
    ["  {USERNAME}  ", null],
    ["{username}\n\n{link}\n{Username}", "maya"],
    ["Line one\n\nLine  two {link}", null],
  ])(
    "renders %j for the name %j exactly as before by default",
    (message, commenterName) => {
      expect(renderMessageWithoutLink({ message, commenterName })).toBe(
        renderedBefore({ message, commenterName })
      );
    }
  );

  it("drops {username} and its extra space without a name or a fallback", () => {
    expect(
      renderMessageWithoutLink({
        message: "Hey {username} schau",
        fallbackName: "",
      })
    ).toBe("Hey schau");
    expect(
      renderMessageWithoutLink({
        message: "Hey {username} schau",
        commenterName: null,
        fallbackName: "",
      })
    ).toBe("Hey schau");
    expect(
      renderMessageWithoutLink({
        message: "Hey {username} schau",
        commenterName: "",
        fallbackName: "",
      })
    ).toBe("Hey schau");
  });

  it("leaves no space before punctuation and keeps the rest of the text as written", () => {
    const render = (message: string) =>
      renderMessageWithoutLink({ message, fallbackName: "" });

    expect(render("Hey {username}, schau mal")).toBe("Hey, schau mal");
    expect(render("Danke {username}!")).toBe("Danke!");
    expect(render("{username} schau mal")).toBe("schau mal");
    expect(render("Hallo {username}\n\nHier  ist er {link}")).toBe(
      "Hallo\n\nHier  ist er"
    );
  });

  it("still puts in the name when there is one", () => {
    expect(
      renderMessageWithoutLink({
        message: "Hey {username} schau",
        commenterName: "maya",
        fallbackName: "",
      })
    ).toBe("Hey maya schau");
  });
});

describe("offer links", () => {
  it("points at the offer's redirect with the recipient token", () => {
    const token = hashRecipientId("17841400000000001");

    expect(buildOfferUrl("abc", token, "https://x.test")).toBe(
      "https://x.test/o/abc?r=" + token
    );
  });

  it("resolves the base like campaign links do", () => {
    expect(buildOfferUrl("abc", undefined, "https://x.test/")).toBe(
      "https://x.test/o/abc"
    );

    vi.stubEnv("NEXTAUTH_URL", "https://app.example.com/");
    expect(buildOfferUrl("abc", "tok")).toBe(
      "https://app.example.com/o/abc?r=tok"
    );
    expect(buildTrackedUrl("abc", undefined, "tok")).toBe(
      "https://app.example.com/r/abc?r=tok"
    );
  });
});

describe("campaign analytics helpers", () => {
  it("summarizes DM status rows", () => {
    expect(
      summarizeDmStatuses([
        { status: "SENT", _count: 20 },
        { status: "FAILED", _count: 2 },
        { status: "SKIPPED_RATE_LIMIT", _count: 3 },
        { status: "SKIPPED_PLAN_LIMIT", _count: 1 },
      ])
    ).toEqual({ sent: 20, skipped: 4, failed: 2 });
  });

  it("calculates CTR and handles empty send volume", () => {
    expect(calculateCtr(5, 20)).toBe(25);
    expect(calculateCtr(2, 3)).toBe(66.7);
    expect(calculateCtr(5, 0)).toBe(0);
  });

  it("normalizes top keywords by count", () => {
    expect(
      normalizeTopKeywords([
        { matchedKeyword: "PRICE", _count: 3 },
        { matchedKeyword: null, _count: 9 },
        { matchedKeyword: "LINK", _count: 7 },
      ])
    ).toEqual([
      { keyword: "LINK", count: 7 },
      { keyword: "PRICE", count: 3 },
    ]);
  });
});

describe("per-recipient click tracking", () => {
  it("adds a recipient token to tracked URLs and messages", () => {
    expect(
      buildTrackedUrl("abc123", "https://manychat-alternative.com", "tok")
    ).toBe("https://manychat-alternative.com/r/abc123?r=tok");
    expect(
      renderMessageWithTracking({
        message: "Grab it here: {link}",
        trackedLinks: [
          { slug: "abc123", destinationUrl: "https://example.com/guide" },
        ],
        baseUrl: "https://manychat-alternative.com",
        recipientToken: "tok",
      })
    ).toBe("Grab it here: https://manychat-alternative.com/r/abc123?r=tok");
  });

  it("derives a stable, URL-safe token that hides the recipient ID", () => {
    const token = hashRecipientId("17841400000000001");

    expect(token).toBe(hashRecipientId("17841400000000001"));
    expect(token).not.toBe(hashRecipientId("17841400000000002"));
    expect(token).not.toContain("17841400000000001");
    expect(parseRecipientToken(token)).toBe(token);
  });

  it("ignores missing or malformed tokens", () => {
    expect(parseRecipientToken(null)).toBeNull();
    expect(parseRecipientToken("")).toBeNull();
    expect(parseRecipientToken("too-short")).toBeNull();
    expect(parseRecipientToken("x".repeat(500))).toBeNull();
    expect(parseRecipientToken("<script>alert(1)</script>xxxxx")).toBeNull();
  });

  it("counts each person once per campaign", () => {
    const row = (
      id: string,
      automationId: string,
      recipientHash: string | null,
      ipHash: string | null
    ) => ({ id, automationId, recipientHash, ipHash });

    const rows = [
      // One recipient tapping twice, from two networks, counts once.
      row("c1", "campaign_a", "person_1", "wifi_ip"),
      row("c2", "campaign_a", "person_1", "mobile_ip"),
      // Older clicks without a token fall back to the IP hash.
      row("c3", "campaign_a", null, "ip_x"),
      row("c4", "campaign_a", null, "ip_x"),
      // With neither, every click counts.
      row("c5", "campaign_a", null, null),
      row("c6", "campaign_a", null, null),
      // The same person in another campaign counts there too.
      row("c7", "campaign_b", "person_1", "wifi_ip"),
    ];

    expect(countUniqueClicks(rows)).toBe(5);
    expect(countUniqueClicksBy(rows, (r) => r.automationId)).toEqual(
      new Map([
        ["campaign_a", 4],
        ["campaign_b", 1],
      ])
    );
  });
});
