import { describe, expect, it } from "vitest";
import { createI18n, type Locale } from "../lib/i18n";
import {
  buildContactTimeline,
  messageKind,
  offerSentAt,
  type HistoryClick,
  type HistoryMessage,
  type HistoryOffer,
  type HistoryTag,
} from "../lib/contacts/history";

// Seconds after 10:00 on one day, as a Date.
function at(seconds: number) {
  return new Date(Date.UTC(2026, 10, 20, 10, 0, seconds));
}

const CAMPAIGN = { automationId: "campaign_1", automation: { name: "Reel 12" } };

function message(overrides: Partial<HistoryMessage> & Pick<HistoryMessage, "id">): HistoryMessage {
  return {
    commentId: "18000000000000001",
    commentText: "Prompt bitte",
    status: "SENT",
    createdAt: at(0),
    ...CAMPAIGN,
    ...overrides,
  };
}

function offerRow(overrides: Partial<HistoryOffer> = {}): HistoryOffer {
  return {
    id: "co_1",
    offerId: "offer_1",
    offeredAt: at(10),
    pitchSentAt: null,
    interestedAt: null,
    sentAt: null,
    sentVia: null,
    reminderSentAt: null,
    clickedAt: null,
    stoppedAt: null,
    stopReason: null,
    offer: { name: "Guide", archivedAt: null },
    ...CAMPAIGN,
    ...overrides,
  };
}

function timeline({
  messages = [],
  offers = [],
  tags = [],
  clicks = [],
}: {
  messages?: HistoryMessage[];
  offers?: HistoryOffer[];
  tags?: HistoryTag[];
  clicks?: HistoryClick[];
}) {
  return buildContactTimeline({ messages, offers, tags, clicks });
}

const keys = (events: { key: string }[]) => events.map((event) => event.key);

describe("a contact's timeline", () => {
  it("merges DM log rows, offer stages, tags and clicks, newest first", () => {
    const events = timeline({
      messages: [
        message({ id: "comment", createdAt: at(0) }),
        message({ id: "tap", commentId: "reveal:17841400000000001", commentText: "(button tap)", createdAt: at(4) }),
        message({ id: "dm", commentId: "dm:mid_1", commentText: "PROMPT", createdAt: at(30) }),
      ],
      offers: [
        offerRow({
          offeredAt: at(6),
          pitchSentAt: at(16),
          interestedAt: at(40),
          sentAt: at(47),
          sentVia: "CARD",
          clickedAt: at(55),
        }),
      ],
      tags: [
        { id: "tag_delivery", tag: "[LM] Prompt gesendet", createdAt: at(5) },
        { id: "tag_offered", tag: "Guide angeboten", createdAt: at(7) },
      ],
      clicks: [
        {
          id: "click_1",
          createdAt: at(20),
          ...CAMPAIGN,
          trackedLink: { destinationUrl: "https://drive.google.com/file/d/abc/view" },
        },
      ],
    });

    expect(keys(events)).toEqual([
      "offer:co_1:clicked",
      "offer:co_1:sent",
      "offer:co_1:interested",
      "message:dm",
      "click:click_1",
      "offer:co_1:pitched",
      "tag:tag_offered",
      "offer:co_1:offered",
      "tag:tag_delivery",
      "message:tap",
      "message:comment",
    ]);
    expect(events.map((event) => event.at)).toEqual(
      [55, 47, 40, 30, 20, 16, 7, 6, 5, 4, 0].map((s) => at(s).toISOString())
    );
  });

  it("labels the rows of a deleted campaign and names the others", () => {
    const events = timeline({
      messages: [message({ id: "comment" })],
      offers: [offerRow({ automationId: null, automation: null })],
      clicks: [
        { id: "click_1", createdAt: at(20), automationId: null, automation: null, trackedLink: null },
      ],
    });

    const byKey = new Map(events.map((event) => [event.key, event]));
    expect(byKey.get("message:comment")).toMatchObject({
      campaignId: "campaign_1",
      campaign: "Reel 12",
      campaignDeleted: false,
    });
    expect(byKey.get("offer:co_1:offered")).toMatchObject({
      campaignId: null,
      campaign: null,
      campaignDeleted: true,
      offer: "Guide",
    });
    expect(byKey.get("click:click_1")).toMatchObject({
      campaignDeleted: true,
      url: null,
    });
  });

  it("tells comments, button taps and DMs apart by their DM log id", () => {
    expect(messageKind("18000000000000001")).toBe("comment");
    expect(messageKind("reveal:17841400000000001")).toBe("tap");
    expect(messageKind("dm:aWdfZAG1faWQ")).toBe("dm");

    const events = timeline({
      messages: [
        message({ id: "comment", commentText: "Prompt bitte", createdAt: at(2) }),
        message({ id: "tap", commentId: "reveal:17841400000000001", commentText: "(button tap)", createdAt: at(1) }),
        message({ id: "dm", commentId: "dm:mid_1", commentText: "PROMPT", status: "FAILED", createdAt: at(0) }),
      ],
    });

    expect(events).toEqual([
      expect.objectContaining({ kind: "comment", text: "Prompt bitte", status: "SENT" }),
      // A tap's row holds a placeholder, not the person's words.
      expect.objectContaining({ kind: "tap", text: null, status: "SENT" }),
      expect.objectContaining({ kind: "dm", text: "PROMPT", status: "FAILED" }),
    ]);
  });

  it("gives every stage of an offer its own entry with what it adds", () => {
    const events = timeline({
      offers: [
        offerRow({
          offeredAt: at(1),
          pitchSentAt: at(11),
          interestedAt: at(20),
          sentAt: at(27),
          sentVia: "BUTTON",
          stoppedAt: at(30),
          stopReason: "WINDOW_CLOSED",
          offer: { name: "Guide", archivedAt: at(40) },
        }),
      ],
    });

    expect(events.map((event) => event.kind === "offer" && event.stage)).toEqual([
      "stopped",
      "sent",
      "interested",
      "pitched",
      "offered",
    ]);
    expect(events[0]).toMatchObject({ stopReason: "WINDOW_CLOSED", sentVia: null, offerArchived: true });
    expect(events[1]).toMatchObject({ sentVia: "BUTTON", stopReason: null });
  });

  it("lets the reminder stand for the delivery it made", () => {
    const events = timeline({
      offers: [
        offerRow({
          pitchSentAt: at(11),
          reminderSentAt: at(50),
          sentAt: at(50),
          sentVia: "REMINDER",
        }),
      ],
    });

    expect(keys(events)).toEqual([
      "offer:co_1:reminded",
      "offer:co_1:pitched",
      "offer:co_1:offered",
    ]);
  });

  it("places a card that followed the reminder at the tap that asked for it", () => {
    const events = timeline({
      offers: [
        offerRow({
          pitchSentAt: at(11),
          reminderSentAt: at(50),
          // The card keeps the time the link first went out.
          sentAt: at(50),
          sentVia: "CARD",
          interestedAt: at(58),
        }),
      ],
    });

    expect(keys(events)).toEqual([
      "offer:co_1:sent",
      "offer:co_1:interested",
      "offer:co_1:reminded",
      "offer:co_1:pitched",
      "offer:co_1:offered",
    ]);
    expect(events[0].at).toBe(at(58).toISOString());
  });

  it("puts the later step first when two things happened in the same instant", () => {
    const events = timeline({
      messages: [message({ id: "tap", commentId: "reveal:1", createdAt: at(5) })],
      offers: [offerRow({ offeredAt: at(5) })],
      tags: [
        { id: "tag_b", tag: "Guide angeboten", createdAt: at(5) },
        { id: "tag_a", tag: "[LM] Prompt gesendet", createdAt: at(5) },
      ],
      clicks: [{ id: "click_1", createdAt: at(5), ...CAMPAIGN, trackedLink: null }],
    });

    expect(keys(events)).toEqual([
      "tag:tag_a",
      "tag:tag_b",
      "offer:co_1:offered",
      "click:click_1",
      "message:tap",
    ]);
  });

  it("reads timestamps given as ISO strings, as the API sends them", () => {
    const events = timeline({
      messages: [message({ id: "comment", createdAt: "2026-11-20T10:00:00.000Z" })],
      tags: [{ id: "tag_1", tag: "Guide angeboten", createdAt: "2026-11-21T08:30:00.000Z" }],
    });

    expect(events.map((event) => [event.key, event.at])).toEqual([
      ["tag:tag_1", "2026-11-21T08:30:00.000Z"],
      ["message:comment", "2026-11-20T10:00:00.000Z"],
    ]);
  });

  it("is empty for a contact with no history", () => {
    expect(timeline({})).toEqual([]);
  });
});

describe("when an offer's lead magnet went out", () => {
  it("is the card's time when there was no reminder", () => {
    expect(
      offerSentAt({ sentAt: at(27), sentVia: "CARD", reminderSentAt: null, interestedAt: at(20) })
    ).toEqual(at(27));
  });

  it("is not a separate entry while only the reminder delivered the link", () => {
    expect(
      offerSentAt({ sentAt: at(50), sentVia: "REMINDER", reminderSentAt: at(50), interestedAt: null })
    ).toBeNull();
    // Tapped after the reminder, but the card has not gone out (yet).
    expect(
      offerSentAt({ sentAt: at(50), sentVia: "REMINDER", reminderSentAt: at(50), interestedAt: at(58) })
    ).toBeNull();
  });

  it("is the tap's time for a card after the reminder", () => {
    expect(
      offerSentAt({ sentAt: at(50), sentVia: "TEXT", reminderSentAt: at(50), interestedAt: at(58) })
    ).toEqual(at(58));
  });

  it("is nothing before anything went out", () => {
    expect(
      offerSentAt({ sentAt: null, sentVia: null, reminderSentAt: null, interestedAt: at(20) })
    ).toBeNull();
  });
});

describe("why an offer stopped, as the contact page shows it", () => {
  // The values lib/offers/worker.ts writes to ContactOffer.stopReason.
  const STOP_REASONS = [
    "WINDOW_CLOSED",
    "REJECTED",
    "RATE_LIMITED",
    "PLAN_LIMIT",
    "OFFER_ARCHIVED",
    "ACCOUNT_UNAVAILABLE",
  ];

  it.each(["en", "de", "zh-TW", "pt-BR", "ru"] as Locale[])(
    "has a label for every reason in %s",
    (locale) => {
      const { label } = createI18n(locale);
      const labels = STOP_REASONS.map(label);

      for (const [index, code] of STOP_REASONS.entries()) {
        expect(labels[index], code).not.toBe(code);
      }
    }
  );

  it("reads them in German", () => {
    expect(STOP_REASONS.map(createI18n("de").label)).toEqual([
      "Nachrichtenfenster geschlossen",
      "Von Instagram abgelehnt",
      "Rate-Limit",
      "Planlimit",
      "Angebot gelöscht",
      "Konto nicht verfügbar",
    ]);
  });
});
