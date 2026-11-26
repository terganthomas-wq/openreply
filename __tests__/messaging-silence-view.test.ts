/**
 * A messaging silence (A2) on the dashboard: an account row read as a
 * silence (and not while its connection is lost), the banner above every page
 * and the account's notice on the settings page in German, what members see
 * instead of "Neu verbinden", the last silence for Diagnostics, and the texts
 * in every catalog.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

import DashboardShell from "../components/dashboard-shell";
import {
  MESSAGING_SILENCE_TEXT,
  MessagingSilenceBanner,
  MessagingSilenceNotice,
} from "../components/messaging-silence";
import { createI18n } from "../lib/i18n";
import de from "../lib/i18n/de.json";
import ptBR from "../lib/i18n/pt-BR.json";
import ru from "../lib/i18n/ru.json";
import zhTW from "../lib/i18n/zh-TW.json";
import { I18nProvider } from "../lib/i18n/provider";
import {
  messagingSilenceOf,
  messagingSilenceReports,
  readMessagingSilenceResult,
  type MessagingSilenceIncident,
} from "../lib/instagram/messaging-silence-incident";

const SILENCE: MessagingSilenceIncident = {
  accountId: "account_1",
  username: "thomas.tergan",
  since: "2026-11-25T13:15:16.000Z",
};
const FORMAL = /\b(?:Sie|Ihnen|Ihr|Ihre[mnrs]?)\b/;

function inGerman(element: ReactElement) {
  return renderToStaticMarkup(
    // A .ts test has no JSX, and the provider's props require children.
    // eslint-disable-next-line react/no-children-prop
    createElement(I18nProvider, { locale: "de", children: element })
  );
}

describe("an account row", () => {
  it("is a silence while messagingSilentSince is set", () => {
    expect(
      messagingSilenceOf({
        id: "account_1",
        username: "thomas.tergan",
        messagingSilentSince: new Date(SILENCE.since),
      })
    ).toEqual(SILENCE);
    expect(
      messagingSilenceOf({ id: "a", username: "u", messagingSilentSince: SILENCE.since })
    ).toEqual({ ...SILENCE, accountId: "a", username: "u" });
    expect(messagingSilenceOf({ id: "a", username: "u", messagingSilentSince: null })).toBeNull();
    expect(messagingSilenceOf({ id: "a", username: "u", messagingSilentSince: "soon" })).toBeNull();
  });

  it("is no silence to show while its connection is lost: that banner covers it", () => {
    expect(
      messagingSilenceOf({
        id: "a",
        username: "u",
        messagingSilentSince: new Date(SILENCE.since),
        connectionLostAt: new Date("2026-11-25T16:45:00.000Z"),
      })
    ).toBeNull();
  });

  it("keeps its last silence for Diagnostics for 7 days, and only one this version can read", () => {
    const result = { v: 1, since: SILENCE.since, endedAt: "2026-11-26T10:30:57.000Z", via: "webhook" };
    expect(readMessagingSilenceResult(result)).toEqual(result);
    expect(readMessagingSilenceResult({ ...result, via: "other" })?.via).toBe("check");
    for (const odd of [null, [], { v: 2 }, { ...result, since: "x" }, { ...result, endedAt: null }]) {
      expect(readMessagingSilenceResult(odd)).toBeNull();
    }
    const now = Date.parse("2026-12-03T10:30:00.000Z");
    expect(
      messagingSilenceReports(
        [
          { id: "a", username: "recent", messagingSilentSince: null, messagingSilenceResult: result },
          {
            id: "b",
            username: "old",
            messagingSilentSince: null,
            messagingSilenceResult: { ...result, endedAt: "2026-11-26T10:29:00.000Z" },
          },
        ],
        now
      )
    ).toEqual([
      { accountId: "a", username: "recent", since: SILENCE.since, endedAt: result.endedAt },
    ]);
  });
});

describe("the banner above every page", () => {
  it("says what is wrong, the likely causes, and offers Neu verbinden", () => {
    const html = inGerman(createElement(MessagingSilenceBanner, { silences: [SILENCE], canManage: true }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Instagram gibt keine Button-Tipps weiter");
    // The server knows no time zone: the time comes with the browser.
    expect(html).toContain("@thomas.tergan: keine Button-Tipps, DMs und Lesebestätigungen");
    expect(html).toContain(
      "Instagram gibt gerade keine Button-Tipps, DMs und Lesebestätigungen an OpenReply weiter. Kommentare kommen an, aber nach der ersten DM passiert nichts."
    );
    expect(html).toContain(
      "Meistens steckt eins davon dahinter: Instagram wurde mit einer Facebook-Seite verknüpft oder davon getrennt (dann beim Neu verbinden die Seite mit auswählen), in Instagram ist „Zugriff auf Nachrichten erlauben“ ausgeschaltet, oder in der Business Suite ist unter „Weiterleiten von Unterhaltungen“ eine andere App als Standard für Instagram eingetragen."
    );
    expect(html).toMatch(/<a href="\/api\/instagram\/connect"[^>]*>Neu verbinden<\/a>/);
  });

  it("asks a member to have an owner or admin reconnect, without the button", () => {
    const html = inGerman(createElement(MessagingSilenceBanner, { silences: [SILENCE], canManage: false }));
    expect(html).toContain("Bitte den Inhaber oder einen Admin deines Workspaces, Instagram neu zu verbinden.");
    expect(html).not.toContain("/api/instagram/connect");
  });

  it("shows nothing while messaging events arrive", () => {
    expect(inGerman(createElement(MessagingSilenceBanner, { silences: [], canManage: true }))).toBe(
      '<div lang="de" class="contents"></div>'
    );
  });

  it("is part of every dashboard page, below the top bar and above the page", () => {
    const shell = (silences: MessagingSilenceIncident[]) =>
      inGerman(
        // As for the provider: the shell's props require children.
        // eslint-disable-next-line react/no-children-prop
        createElement(DashboardShell, {
          workspaceName: "Studio",
          instagramUsername: "thomas.tergan",
          instagramAccountCount: 1,
          canManage: true,
          messagingSilences: silences,
          children: createElement("p", null, "page-content"),
        })
      );
    const html = shell([SILENCE]);
    const title = "Instagram gibt keine Button-Tipps weiter";
    expect(html.indexOf("</header>")).toBeLessThan(html.indexOf("<main"));
    expect(html.indexOf("<main")).toBeLessThan(html.indexOf(title));
    expect(html.indexOf(title)).toBeLessThan(html.indexOf("page-content"));
    expect(shell([])).not.toContain(title);
  });
});

describe("the account on the settings page", () => {
  it("shows since when, what it means, the causes, what to do and Neu verbinden", () => {
    const html = inGerman(createElement(MessagingSilenceNotice, { silence: SILENCE, canManage: true }));
    expect(html).toMatch(/Seit 25\.11\.2026, \d\d:\d\d keine Button-Tipps, DMs und Lesebestätigungen/);
    expect(html).toContain("Kommentare kommen an, aber nach der ersten DM passiert nichts.");
    expect(html).toContain("„Weiterleiten von Unterhaltungen“");
    expect(html).toContain(
      "So behebst du es: Tippe auf „Neu verbinden“, melde dich bei Meta an, wähle dein Instagram-Konto und, falls es mit einer Facebook-Seite verknüpft ist, auch diese Seite, und erlaube alle Berechtigungen. Der Hinweis verschwindet von selbst, sobald wieder ein Button-Tipp, eine DM oder eine Lesebestätigung ankommt."
    );
    expect(html).toMatch(/<a href="\/api\/instagram\/connect"[^>]*>Neu verbinden<\/a>/);
  });

  it("asks a member to have it done", () => {
    const html = inGerman(createElement(MessagingSilenceNotice, { silence: SILENCE, canManage: false }));
    expect(html).toContain("Bitte den Inhaber oder einen Admin deines Workspaces, Instagram neu zu verbinden.");
    expect(html).not.toContain("So behebst du es");
    expect(html).not.toContain("/api/instagram/connect");
  });
});

describe("the texts", () => {
  const keys = [
    ...Object.values(MESSAGING_SILENCE_TEXT),
    "@{account}: no button taps, DMs or read receipts since {time}",
    "@{account}: no button taps, DMs or read receipts",
    "Messages not arriving",
    "No button taps, DMs or read receipts since {time}",
    "After the missing button taps",
    "@{account}: button taps arrive again since {time}",
    "No button taps, DMs or read receipts arrived from {from} to {to}.",
    "Whoever tapped the button in your first DM in that time got nothing: the tap did not reach OpenReply. In Instagram such a tap shows in the conversation as a message with the button's text.",
    "Instagram passes on no button taps, DMs or read receipts for @{account} since {time}.",
    "Button taps, DMs and read receipts for @{account} arrive again.",
    "Alert e-mail about the missing button taps of @{account} sent. Recipients: {count}",
    "Reminder about the missing button taps of @{account} sent. Recipients: {count}",
    "All-clear e-mail about the button taps of @{account} sent. Recipients: {count}",
  ] as const;

  it("exist in every language", () => {
    for (const catalog of [zhTW, ptBR, ru, de]) {
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
    }
  });

  it("name the button as it is labeled, in every language", () => {
    for (const catalog of [zhTW, ptBR, ru, de]) {
      expect(catalog[MESSAGING_SILENCE_TEXT.fix]).toContain(catalog["Reconnect"]);
    }
  });

  it("read as the dashboard in German, informally", () => {
    const { t } = createI18n("de");
    expect(t("Messages not arriving")).toBe("Nachrichten kommen nicht an");
    expect(t(MESSAGING_SILENCE_TEXT.title)).toBe("Instagram gibt keine Button-Tipps weiter");
    expect(t("No button taps, DMs or read receipts since {time}", { time: "25.11.2026, 14:15" })).toBe(
      "Seit 25.11.2026, 14:15 keine Button-Tipps, DMs und Lesebestätigungen"
    );
    for (const key of keys) expect(de[key], key).not.toMatch(FORMAL);
  });
});
