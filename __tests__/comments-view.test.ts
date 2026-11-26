/**
 * The Kommentare page (M1): what a comment row renders in German, the rules
 * behind it (lib/comments/view.ts), the menu entry for owners and admins, and
 * the page's texts in every catalog.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/comments" }));

import { CommentCard, blockText, refusalText, type CommentCardProps } from "../components/comments-view";
import { navItemsFor } from "../components/sidebar";
import { MANUAL_SEND_RATE_LIMIT, manualSendJobId, PRIVATE_REPLY_WINDOW_MS } from "../lib/comments/manual";
import type { ManualSendReason } from "../lib/comments/server";
import {
  defaultCampaignId,
  defaultPublicReply,
  lastAttempt,
  manualSendSettled,
  pauseReloadDelay,
  relativeTime,
  sendBlock,
  sendDelayed,
  sendPollBudget,
  withStatus,
  type CampaignOption,
  type CommentRow,
} from "../lib/comments/view";
import AccountSelect from "../components/account-select";
import { createI18n } from "../lib/i18n";
import de from "../lib/i18n/de.json";
import ptBR from "../lib/i18n/pt-BR.json";
import ru from "../lib/i18n/ru.json";
import zhTW from "../lib/i18n/zh-TW.json";
import { I18nProvider } from "../lib/i18n/provider";

const NOW = new Date("2026-11-25T18:00:00.000Z").getTime();
const MINUTE = 60_000;

const CAMPAIGNS: CampaignOption[] = [
  { id: "c_guide", name: "Guide", isActive: true, hasPublicReply: true },
  { id: "c_old", name: "Alter Guide", isActive: false, hasPublicReply: false },
];

function row(overrides: Partial<CommentRow> = {}): CommentRow {
  return {
    id: "17900000000000001",
    text: "kallt",
    timestamp: new Date(NOW - 5 * MINUTE).toISOString(),
    username: "anna.k",
    mediaId: "media_1",
    permalink: "https://www.instagram.com/reel/abc/",
    ownerReplied: false,
    question: false,
    match: null,
    delivery: null,
    logs: [],
    ...overrides,
  };
}

function render(props: Partial<CommentCardProps> & { row: CommentRow }) {
  const card = createElement(CommentCard, {
    campaigns: CAMPAIGNS,
    campaignId: defaultCampaignId(props.row, CAMPAIGNS),
    publicReply: defaultPublicReply(props.row),
    sending: false,
    notice: null,
    pausedUntil: null,
    now: NOW,
    onCampaignChange: () => {},
    onPublicReplyChange: () => {},
    onSend: () => {},
    ...props,
  });
  return renderToStaticMarkup(
    // A .ts test has no JSX, and the provider's props require children.
    // eslint-disable-next-line react/no-children-prop
    createElement(I18nProvider, { locale: "de", children: card })
  );
}

describe("a comment row on the Kommentare page", () => {
  it("shows who, what, when, the post and the send in German", () => {
    const html = render({
      row: row({ match: { id: "c_guide", name: "Guide" }, text: "GUIDE <bitte>" }),
    });
    expect(html).toContain("@anna.k");
    // User content is escaped, never markup.
    expect(html).toContain("GUIDE &lt;bitte&gt;");
    expect(html).toContain("vor 5 Minuten");
    expect(html).toContain('href="https://www.instagram.com/reel/abc/"');
    expect(html).toContain("Beitrag ansehen");
    expect(html).toContain("Keine DM");
    expect(html).toContain("Passt zu: Guide");
    expect(html).toContain("DM senden");
    expect(html).toContain("Öffentlich antworten");
    // The campaign the keywords would pick is chosen, the paused one named so.
    expect(html).toMatch(/<option value="c_guide" selected="">Guide<\/option>/);
    expect(html).toContain("Alter Guide (pausiert)");
    // Public reply on by default; the button can be pressed.
    expect(html).toMatch(/<input id="public-reply-[^"]+" type="checkbox"[^>]*checked=""/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>DM senden/);
  });

  it("starts without a campaign or a public reply where the owner answered in public", () => {
    const html = render({ row: row({ ownerReplied: true, question: true }) });
    expect(html).toContain("Du hast geantwortet");
    expect(html).toContain("Frage");
    expect(html).toMatch(/<option value="" selected="">Kampagne wählen<\/option>/);
    expect(html).not.toMatch(/type="checkbox"[^>]*checked=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>DM senden/);
  });

  it("says when a DM already went out, and offers no second one", () => {
    const html = render({
      row: row({
        delivery: { state: "sent", campaignId: "c_guide", campaignName: "Guide", manual: true },
      }),
    });
    expect(html).toContain("DM von Hand gesendet · Guide");
    expect(html).toContain(
      "Zu diesem Kommentar ging schon eine DM raus. Instagram erlaubt nur eine pro Kommentar."
    );
    expect(html).not.toContain("DM senden");
    expect(html).not.toContain("<select");
  });

  it("explains a paused account, the end of the 7 days and a campaign without a public reply", () => {
    const paused = render({
      row: row({ match: { id: "c_guide", name: "Guide" } }),
      pausedUntil: new Date(NOW + 20 * MINUTE).toISOString(),
    });
    expect(paused).toMatch(/Senden pausiert bis \d\d:\d\d: Instagram-Limit erreicht\./);
    expect(paused).toMatch(/<button[^>]*disabled=""[^>]*>DM senden/);

    const old = render({
      row: row({ timestamp: new Date(NOW - PRIVATE_REPLY_WINDOW_MS - MINUTE).toISOString() }),
    });
    expect(old).toContain("Älter als 7 Tage: Instagram erlaubt keine DM mehr.");
    expect(old).not.toContain("DM senden");

    const inactive = render({ row: row(), campaignId: "c_old" });
    expect(inactive).toContain("Diese Kampagne ist pausiert. Von Hand senden geht trotzdem.");
    expect(inactive).toContain("Diese Kampagne hat keine öffentliche Antwort.");
    expect(inactive).toMatch(/type="checkbox"[^>]*disabled=""/);
  });

  // A1: no DM can go out while the connection is lost.
  it("blocks the send while the connection is lost, with Neu verbinden", () => {
    const html = render({
      row: row({ match: { id: "c_guide", name: "Guide" } }),
      connectionLostAt: new Date(NOW - 60 * MINUTE).toISOString(),
    });
    expect(html).toContain("Die Verbindung zu Instagram ist unterbrochen. Verbinde zuerst neu.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>DM senden/);
    expect(html).toMatch(/<a href="\/api\/instagram\/connect"[^>]*>Neu verbinden<\/a>/);

    // A DM that went out still says so, and needs no reconnect.
    const sent = render({
      row: row({
        delivery: { state: "sent", campaignId: "c_guide", campaignName: "Guide", manual: false },
      }),
      connectionLostAt: new Date(NOW - 60 * MINUTE).toISOString(),
    });
    expect(sent).toContain("DM gesendet · Guide");
    expect(sent).not.toContain("Neu verbinden");
  });

  it("shows a send under way and the outcome of an earlier try", () => {
    const sending = render({ row: row(), campaignId: "c_guide", sending: true });
    expect(sending).toContain("Wird gesendet …");
    expect(sending).not.toContain("Geht gegen");
    // A send that waits behind others of the account says when it goes out.
    const later = render({
      row: row(),
      campaignId: "c_guide",
      sending: true,
      scheduledAt: new Date(NOW + 40_000).toISOString(),
    });
    expect(later).toMatch(
      /Geht gegen \d\d:\d\d raus, damit Instagram nicht zu viele DMs auf einmal bekommt\./
    );

    const failed = render({
      row: row({
        logs: [
          {
            automationId: "c_guide",
            campaignName: "Guide",
            status: "FAILED",
            exhausted: true,
            errorMessage: "MetaApiError 100: The comment is invalid for a private reply",
            updatedAt: new Date(NOW - MINUTE).toISOString(),
            manual: true,
          },
        ],
      }),
      campaignId: "c_guide",
      notice: "Zu viele DMs in kurzer Zeit. Warte eine Minute.",
    });
    expect(failed).toContain("Mit „Guide“ nicht gesendet: Instagram hat abgelehnt.");
    expect(failed).toContain(
      "Instagram hat die DM dieser Kampagne schon dreimal abgelehnt. Wähl eine andere Kampagne."
    );
    expect(failed).toContain("Zu viele DMs in kurzer Zeit. Warte eine Minute.");
  });
});

describe("the rules behind a row", () => {
  it("blocks a send in order: sent, too old, paused, sending, no campaign, attempts", () => {
    const base = { campaignId: "c_guide", pausedUntil: null, sending: false, now: NOW };
    const sent = row({ delivery: { state: "unconfirmed", campaignId: "x", campaignName: "X", manual: false } });
    expect(sendBlock({ ...base, row: sent })).toEqual({ kind: "sent" });
    expect(
      sendBlock({
        ...base,
        row: row({ delivery: { state: "sending", campaignId: "x", campaignName: "X", manual: false } }),
      })
    ).toEqual({ kind: "sending" });
    const old = row({ timestamp: new Date(NOW - PRIVATE_REPLY_WINDOW_MS).toISOString() });
    expect(sendBlock({ ...base, row: old, pausedUntil: new Date(NOW + MINUTE).toISOString() })).toEqual({
      kind: "too-old",
    });
    expect(sendBlock({ ...base, row: row(), pausedUntil: new Date(NOW + MINUTE).toISOString() })).toEqual({
      kind: "paused",
      until: new Date(NOW + MINUTE).toISOString(),
    });
    // A pause that is over blocks nothing.
    expect(sendBlock({ ...base, row: row(), pausedUntil: new Date(NOW - MINUTE).toISOString() })).toBeNull();
    // A1: a lost connection after the 7 days and before the pause.
    const lostAt = new Date(NOW - 60 * MINUTE).toISOString();
    expect(sendBlock({ ...base, row: old, connectionLostAt: lostAt })).toEqual({ kind: "too-old" });
    expect(
      sendBlock({ ...base, row: row(), connectionLostAt: lostAt, pausedUntil: new Date(NOW + MINUTE).toISOString() })
    ).toEqual({ kind: "connection-lost" });
    expect(sendBlock({ ...base, row: row(), campaignId: "", connectionLostAt: lostAt })).toEqual({
      kind: "connection-lost",
    });
    expect(sendBlock({ ...base, row: sent, connectionLostAt: lostAt })).toEqual({ kind: "sent" });
    expect(sendBlock({ ...base, row: row(), connectionLostAt: null })).toBeNull();
    expect(sendBlock({ ...base, row: row(), sending: true })).toEqual({ kind: "sending" });
    expect(sendBlock({ ...base, row: row(), campaignId: "" })).toEqual({ kind: "no-campaign" });
    const exhausted = row({
      logs: [
        {
          automationId: "c_guide",
          campaignName: "Guide",
          status: "FAILED",
          exhausted: true,
          errorMessage: null,
          updatedAt: new Date(NOW).toISOString(),
          manual: false,
        },
      ],
    });
    expect(sendBlock({ ...base, row: exhausted })).toEqual({ kind: "attempts" });
    // Another campaign still has its attempts.
    expect(sendBlock({ ...base, row: exhausted, campaignId: "c_old" })).toBeNull();
  });

  it("preselects only a campaign the page offers", () => {
    expect(defaultCampaignId(row({ match: { id: "c_guide", name: "Guide" } }), CAMPAIGNS)).toBe("c_guide");
    expect(defaultCampaignId(row({ match: { id: "c_gone", name: "Weg" } }), CAMPAIGNS)).toBe("");
    expect(defaultPublicReply(row())).toBe(true);
    expect(defaultPublicReply(row({ ownerReplied: true }))).toBe(false);
  });

  it("knows when a manual send has its outcome, by the row's own time", () => {
    const pending = { automationId: "c_guide", previousUpdatedAt: null, polls: 0 };
    const log = (status: string, errorMessage: string | null = null, updatedAt = "2026-11-25T18:00:05.000Z") => ({
      automationId: "c_guide",
      campaignName: "Guide",
      status,
      exhausted: false,
      errorMessage,
      updatedAt,
      manual: true,
    });
    expect(manualSendSettled(undefined, pending)).toBe(false);
    expect(manualSendSettled({ delivery: null, logs: [] }, pending)).toBe(false);
    // Queued or claimed: still on its way.
    expect(manualSendSettled({ delivery: null, logs: [log("PENDING")] }, pending)).toBe(false);
    expect(
      manualSendSettled(
        { delivery: { state: "sending", campaignId: "c_guide", campaignName: "Guide", manual: true }, logs: [log("PENDING")] },
        pending
      )
    ).toBe(false);
    expect(
      manualSendSettled(
        { delivery: { state: "sent", campaignId: "c_guide", campaignName: "Guide", manual: true }, logs: [log("SENT")] },
        pending
      )
    ).toBe(true);
    expect(manualSendSettled({ delivery: null, logs: [log("FAILED", "refused")] }, pending)).toBe(true);
    // Waiting for the account's pause, with its reason: an outcome to show.
    expect(
      manualSendSettled({ delivery: null, logs: [log("PENDING", "Instagram request limit; next try at 18:20 UTC")] }, pending)
    ).toBe(true);
    // The row as it was before the send is no outcome of it.
    const before = { ...pending, previousUpdatedAt: "2026-11-25T17:00:00.000Z" };
    expect(
      manualSendSettled({ delivery: null, logs: [log("FAILED", "old", "2026-11-25T17:00:00.000Z")] }, before)
    ).toBe(false);
  });

  it("shows the newer status of a poll and the last try without a DM", () => {
    const logs = [
      { automationId: "a", campaignName: "A", status: "FAILED", exhausted: false, errorMessage: null, updatedAt: "2026-11-25T17:00:00.000Z", manual: false },
      { automationId: "b", campaignName: "B", status: "SKIPPED_DEDUP", exhausted: false, errorMessage: null, updatedAt: "2026-11-25T17:30:00.000Z", manual: true },
    ];
    expect(lastAttempt(row({ logs }))?.automationId).toBe("b");
    const sent = { delivery: { state: "sent" as const, campaignId: "a", campaignName: "A", manual: false }, logs };
    expect(withStatus(row(), sent).delivery).toEqual(sent.delivery);
    expect(lastAttempt(withStatus(row(), sent))).toBeNull();
    expect(withStatus(row({ text: "x" }), undefined).text).toBe("x");
  });

  it("says how old a comment is in the reader's language", () => {
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW, "de")).toBe("vor 30 Sekunden");
    expect(relativeTime(new Date(NOW - 5 * MINUTE).toISOString(), NOW, "de")).toBe("vor 5 Minuten");
    expect(relativeTime(new Date(NOW - 3 * 60 * MINUTE).toISOString(), NOW, "de")).toBe("vor 3 Stunden");
    expect(relativeTime(new Date(NOW - 24 * 60 * MINUTE).toISOString(), NOW, "de")).toBe("gestern");
    expect(relativeTime(new Date(NOW - 3 * 24 * 60 * MINUTE).toISOString(), NOW, "en")).toBe("3 days ago");
  });

  it("gives every refusal of the send its own words", () => {
    const i18n = createI18n("de");
    const reasons: ManualSendReason[] = [
      "campaign_not_found",
      "not_comment_campaign",
      "provider",
      "connection_lost",
      "worker_outdated",
      "paused",
      "already_sent",
      "attempts_used",
      "comment_not_found",
      "own_comment",
      "too_old",
      "foreign_media",
      "account_limit",
      "instagram_limit",
    ];
    const generic = refusalText("instagram_error", undefined, i18n);
    expect(generic).toBe("Die DM konnte nicht gesendet werden. Versuch es noch mal.");
    for (const reason of reasons) {
      expect(refusalText(reason, undefined, i18n), reason).not.toBe(generic);
    }
    expect(refusalText("own_comment", undefined, i18n)).toBe("Das ist dein eigener Kommentar.");
    expect(refusalText("rate_limited", undefined, i18n)).toBe(
      "Zu viele DMs in kurzer Zeit. Warte eine Minute."
    );
    expect(refusalText("account_limit", undefined, i18n)).toBe(
      "Für dieses Konto gingen in der letzten Stunde schon viele DMs von Hand raus. Versuch es später noch mal."
    );
    expect(refusalText("paused", new Date(NOW + MINUTE).toISOString(), i18n)).toMatch(
      /^Senden pausiert bis \d\d:\d\d: Instagram-Limit erreicht\.$/
    );
    expect(blockText({ kind: "no-campaign" }, i18n)).toBeNull();
    expect(refusalText("connection_lost", undefined, i18n)).toBe(
      "Die Verbindung zu Instagram ist unterbrochen. Verbinde zuerst neu."
    );
    expect(blockText({ kind: "connection-lost" }, i18n)).toBe(
      "Die Verbindung zu Instagram ist unterbrochen. Verbinde zuerst neu."
    );
  });

  it("asks for a send's outcome until a minute after it is due", () => {
    const queuedAt = new Date(NOW).toISOString();
    // Right away: a minute of polls, every 3 seconds.
    expect(sendPollBudget(queuedAt, queuedAt)).toBe(20);
    expect(sendPollBudget(null, null)).toBe(20);
    // Behind two others: 40 seconds more.
    expect(sendPollBudget(queuedAt, new Date(NOW + 40_000).toISOString())).toBe(34);
    expect(sendDelayed(queuedAt, new Date(NOW + 2_000).toISOString())).toBe(false);
    expect(sendDelayed(queuedAt, new Date(NOW + 20_000).toISOString())).toBe(true);
  });

  it("loads the comments again by itself a few seconds after the pause", () => {
    const answeredAt = new Date(NOW).toISOString();
    expect(pauseReloadDelay(null, answeredAt)).toBeNull();
    expect(pauseReloadDelay(new Date(NOW + 10 * MINUTE).toISOString(), answeredAt)).toBe(
      10 * MINUTE + 5_000
    );
    expect(pauseReloadDelay(new Date(NOW + MINUTE).toISOString(), answeredAt, 7_000)).toBe(
      MINUTE + 12_000
    );
    // A pause that is over by the answer's time: soon.
    expect(pauseReloadDelay(new Date(NOW - MINUTE).toISOString(), answeredAt)).toBe(5_000);
  });

  it("offers every account in the selector, also when the chosen one cannot be read", () => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop
      createElement(I18nProvider, {
        locale: "de",
        children: createElement(AccountSelect, {
          accounts: [
            { id: "a1", username: "studio", instagramId: "1" },
            { id: "a2", username: "shop", instagramId: "2" },
          ],
          value: "zernio_account",
          onChange: () => {},
          includeAll: false,
          placeholder: "Konto wählen",
        }),
      })
    );
    // The first option is the placeholder, so choosing @studio changes the value.
    expect(html.indexOf("Konto wählen")).toBeLessThan(html.indexOf("@studio"));
    expect(html).toContain("@shop");
  });

  it("names the job after the comment, the campaign and its attempts, without a colon", () => {
    const id = manualSendJobId({ instagramId: "1784", commentId: "1790", automationId: "cm1", attempts: 2 });
    expect(id).toBe("manual_1784_1790_cm1_2");
    expect(id).not.toContain(":");
    expect(MANUAL_SEND_RATE_LIMIT).toBe(30);
  });
});

describe("the menu", () => {
  it("shows Kommentare to owners and admins only", () => {
    expect(navItemsFor(true).map((item) => item.href)).toContain("/comments");
    expect(navItemsFor(false).map((item) => item.href)).not.toContain("/comments");
    // Everything else stays for members.
    expect(navItemsFor(false)).toHaveLength(navItemsFor(true).length - 1);
    expect(createI18n("de").t("Comments")).toBe("Kommentare");
  });
});

describe("the page's texts", () => {
  const keys = [
    "Without DM",
    "Load more",
    "Send DM",
    "Reply publicly",
    "No DM",
    "You replied",
    "Question",
    "Matches: {campaign}",
    "DM sent · {campaign}",
    "DM sent by hand · {campaign}",
    "DM sent, not confirmed · {campaign}",
    "Choose a campaign",
    "{name} (paused)",
    "View post",
    "A DM for this comment already went out. Instagram allows only one per comment.",
    "Older than 7 days: Instagram no longer allows a DM.",
    "Sending paused until {time}: Instagram limit reached.",
    "Only owners and admins can see the comments here and send DMs.",
    "Send a campaign's DM by hand, for example for a comment without the exact keyword. Instagram allows one DM per comment, up to 7 days after the comment.",
    "No comments without a DM in the last 7 days.",
    "No result yet. Reload the page in a moment.",
    "The connection to Instagram is lost. Reconnect first.",
    "The connection to Instagram has been lost since {time}. Reconnect, then you can send DMs here again.",
    "Reconnect",
    "Too many DMs sent by hand for this account in the last hour. Try again later.",
    "Goes out at about {time}, so Instagram does not get too many DMs at once.",
    "Choose an account",
    "Catch-up for @{account} done: 1 comment gets its DM, {answered} you had answered yourself.",
  ] as const;

  it("exist in every language", () => {
    for (const catalog of [zhTW, ptBR, ru, de]) {
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
    }
  });

  it("read as the page in German, informally", () => {
    const { t } = createI18n("de");
    expect(t("Comments")).toBe("Kommentare");
    expect(t("Without DM")).toBe("Ohne DM");
    expect(t("All")).toBe("Alle");
    expect(t("Send DM")).toBe("DM senden");
    expect(t("Reply publicly")).toBe("Öffentlich antworten");
    expect(t("Sending…")).toBe("Wird gesendet …");
    expect(t("No DM")).toBe("Keine DM");
    expect(t("You replied")).toBe("Du hast geantwortet");
    expect(t("Question")).toBe("Frage");
    expect(t("Load more")).toBe("Mehr laden");
    expect(t("DM sent · {campaign}", { campaign: "Guide" })).toBe("DM gesendet · Guide");
    // R17: "du", never the formal address, in every new text.
    for (const key of keys) {
      expect(de[key], key).not.toMatch(/\b(?:Sie|Ihnen|Ihr|Ihre[mnrs]?)\b/);
    }
    expect(
      t(
        "Send a campaign's DM by hand, for example for a comment without the exact keyword. Instagram allows one DM per comment, up to 7 days after the comment."
      )
    ).toBe(
      "Hier schickst du die DM einer Kampagne von Hand, etwa für einen Kommentar ohne das genaue Keyword. Instagram erlaubt eine DM pro Kommentar, bis 7 Tage nach dem Kommentar."
    );
  });
});
