/**
 * The catch-up after a lost Instagram connection (A1) in Diagnostics: which
 * accounts show it (while it runs, and for 7 days after), the comments the
 * owner answered by hand with author, text, time and the post, the way to the
 * Kommentare page for owners and admins only, the events in the timeline, and
 * the texts in every catalog, German with "du".
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/diagnostics" }));

import ConnectionCatchUpReport from "../components/connection-catch-up";
import { createI18n } from "../lib/i18n";
import de from "../lib/i18n/de.json";
import ptBR from "../lib/i18n/pt-BR.json";
import ru from "../lib/i18n/ru.json";
import zhTW from "../lib/i18n/zh-TW.json";
import { I18nProvider } from "../lib/i18n/provider";
import {
  connectionCatchUpReports,
  type CatchUpReport,
} from "../lib/instagram/catch-up-report";
import { EMPTY_SKIPPED } from "../lib/instagram/catch-up-state";
import { eventDetail } from "../lib/ops/event-details";

const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-11-26T08:00:00.000Z").getTime();

const RESULT = {
  v: 1,
  lostAt: "2026-11-25T16:45:00.000Z",
  recoveredAt: "2026-11-25T20:50:00.000Z",
  finishedAt: "2026-11-25T21:05:00.000Z",
  since: "2026-11-25T16:00:00.000Z",
  queued: 3,
  firstJobAt: "2026-11-25T21:05:00.000Z",
  lastJobAt: "2026-11-25T21:05:40.000Z",
  ownerAnswered: [
    {
      commentId: "c_anna",
      username: "anna",
      text: "Guide bitte",
      timestamp: "2026-11-25T17:02:00.000Z",
      permalink: "https://www.instagram.com/p/p1/",
    },
  ],
  ownerAnsweredTotal: 3,
  posts: 30,
  pages: 31,
  skipped: { ...EMPTY_SKIPPED },
  complete: true,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "account_1",
    username: "thomas.tergan",
    connectionLostAt: null,
    connectionCatchUpFrom: null,
    connectionCatchUpResult: RESULT,
    ...overrides,
  };
}

function inGerman(element: ReactElement) {
  return renderToStaticMarkup(
    // A .ts test has no JSX, and the provider's props require children.
    // eslint-disable-next-line react/no-children-prop
    createElement(I18nProvider, { locale: "de", children: element })
  );
}

describe("which accounts Diagnostics shows", () => {
  it("the last catch-up for 7 days after it finished, and one that runs", () => {
    expect(connectionCatchUpReports([row()], NOW)).toEqual([
      {
        accountId: "account_1",
        username: "thomas.tergan",
        running: false,
        last: {
          lostAt: RESULT.lostAt,
          recoveredAt: RESULT.recoveredAt,
          finishedAt: RESULT.finishedAt,
          queued: 3,
          ownerAnswered: RESULT.ownerAnswered,
          ownerAnsweredTotal: 3,
          complete: true,
        },
      },
    ]);
    expect(connectionCatchUpReports([row()], Date.parse(RESULT.finishedAt) + 8 * DAY)).toEqual([]);
    expect(
      connectionCatchUpReports(
        [row({ connectionCatchUpResult: null, connectionCatchUpFrom: new Date(NOW - DAY) })],
        NOW
      )
    ).toEqual([{ accountId: "account_1", username: "thomas.tergan", running: true, last: null }]);
    // While a new incident is open, the incident is what Diagnostics shows.
    expect(
      connectionCatchUpReports(
        [
          row({
            connectionCatchUpResult: null,
            connectionCatchUpFrom: new Date(NOW - DAY),
            connectionLostAt: new Date(NOW - 60_000),
          }),
        ],
        NOW
      )
    ).toEqual([]);
    expect(connectionCatchUpReports([row({ connectionCatchUpResult: { v: 2 } })], NOW)).toEqual([]);
  });
});

describe("the catch-up in Diagnostics", () => {
  const report = connectionCatchUpReports([row()], NOW)[0];

  it("lists the comments the owner answered by hand, with author, text, time and the post", () => {
    const html = inGerman(createElement(ConnectionCatchUpReport, { reports: [report], canManage: true }));
    expect(html).toContain("Nach der Unterbrechung");
    expect(html).toMatch(/@thomas\.tergan: Verbindung wieder da seit 25\.11\.2026, \d\d:\d\d/);
    expect(html).toMatch(/Unterbrochen von 25\.11\.2026, \d\d:\d\d bis 25\.11\.2026, \d\d:\d\d\./);
    expect(html).toContain("Kommentare, die ihre DM jetzt nachgeholt bekommen: 3");
    expect(html).toContain(
      "Diese Kommentare hast du in der Zwischenzeit selbst beantwortet. Deshalb hat OpenReply ihnen keine automatische DM geschickt:"
    );
    expect(html).toContain("@anna");
    expect(html).toContain("Guide bitte");
    expect(html).toMatch(/25\.11\.2026, \d\d:\d\d/);
    expect(html).toMatch(
      /<a href="https:\/\/www\.instagram\.com\/p\/p1\/" target="_blank" rel="noopener noreferrer"[^>]*>Beitrag ansehen<\/a>/
    );
    // Three in all, one with its text.
    expect(html).toContain("und 2 weitere");
    expect(html).toContain(
      "Soll jemand davon die DM doch noch bekommen, schick sie auf der Seite „Kommentare“ mit „DM senden“."
    );
    expect(html).toMatch(/<a [^>]*href="\/comments"[^>]*>Kommentare öffnen<\/a>/);
    expect(html).not.toContain("Nicht alle Beiträge");
  });

  it("gives a member no way to a page that refuses them", () => {
    const html = inGerman(createElement(ConnectionCatchUpReport, { reports: [report], canManage: false }));
    expect(html).toContain("@anna");
    expect(html).not.toContain("/comments");
    expect(html).not.toContain("Soll jemand davon");
  });

  it("says when not every post could be read, and when nobody had an answer", () => {
    const partial: CatchUpReport = {
      ...report,
      last: { ...report.last!, complete: false, ownerAnswered: [], ownerAnsweredTotal: 0 },
    };
    const html = inGerman(createElement(ConnectionCatchUpReport, { reports: [partial], canManage: true }));
    expect(html).toContain(
      "Nicht alle Beiträge ließen sich durchsehen. Schau auf der Seite „Kommentare“ nach, ob noch jemand auf eine DM wartet."
    );
    expect(html).toContain("Keiner der Kommentare aus dieser Zeit hatte schon eine Antwort von dir.");
  });

  it("says that a catch-up runs, and shows nothing without one", () => {
    const html = inGerman(
      createElement(ConnectionCatchUpReport, {
        reports: [{ accountId: "a", username: "studio", running: true, last: null }],
        canManage: true,
      })
    );
    expect(html).toContain("@studio: Die Kommentare aus der Unterbrechung werden gerade nachgeholt …");
    expect(inGerman(createElement(ConnectionCatchUpReport, { reports: [], canManage: true }))).toBe(
      '<div lang="de" class="contents"></div>'
    );
  });

  it("names the timeline's events, with nothing but counts from their payload", () => {
    expect(
      eventDetail({
        kind: "connection-catch-up",
        account: "shop",
        queued: 3,
        answered: 1,
        complete: true,
        skipped: { postsFailed: 0 },
      })
    ).toEqual({ kind: "connection-catch-up", account: "shop", queued: 3, answered: 1 });
    expect(eventDetail({ kind: "connection-catch-up", account: "shop", queued: -1, answered: 0 })).toBeNull();
    expect(eventDetail({ kind: "connection-all-clear", account: "shop", recipients: 2 })).toEqual({
      kind: "connection-all-clear",
      account: "shop",
      recipients: 2,
    });
    expect(eventDetail({ kind: "connection-all-clear", account: "shop", recipients: 0 })).toBeNull();
  });
});

describe("the texts", () => {
  const keys = [
    "After the lost connection",
    "@{account}: catching up on the comments of the lost connection …",
    "@{account}: connection back since {time}",
    "Lost from {from} to {to}.",
    "Comments that get their DM now: {count}",
    "Not every post could be checked. Look on the Comments page whether anyone is still waiting for a DM.",
    "You answered these comments yourself in the meantime, so OpenReply sent them no automatic DM:",
    "If one of them should still get the DM, send it on the Comments page with “Send DM”.",
    "None of the comments of that time had an answer from you.",
    "and {count} more",
    "Open comments",
    "Catch-up for @{account} done: {queued} comments get their DM, {answered} you had answered yourself.",
    "All-clear e-mail for @{account} sent. Recipients: {count}",
  ] as const;

  it("exist in every language", () => {
    for (const catalog of [zhTW, ptBR, ru, de]) {
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
    }
  });

  it("name the page and the button as they are labeled, in every language", () => {
    for (const catalog of [zhTW, ptBR, ru, de]) {
      expect(catalog[keys[7]], keys[7]).toContain(catalog["Send DM"]);
      expect(catalog[keys[7]], keys[7]).toContain(catalog["Comments"]);
      expect(catalog[keys[5]], keys[5]).toContain(catalog["Comments"]);
    }
  });

  it("read as the dashboard in German, informally", () => {
    const { t } = createI18n("de");
    expect(t("After the lost connection")).toBe("Nach der Unterbrechung");
    expect(t("Open comments")).toBe("Kommentare öffnen");
    expect(t("@{account}: connection back since {time}", { account: "shop", time: "21:50" })).toBe(
      "@shop: Verbindung wieder da seit 21:50"
    );
    for (const key of keys) {
      expect(de[key], key).not.toMatch(/\b(?:Sie|Ihnen|Ihr|Ihre[mnrs]?)\b/);
    }
  });
});
