/**
 * What the search for lost taps after a messaging silence (A2 requirement
 * 5) shows: Diagnostics (how long the silence lasted, and an earlier one
 * reported with it, how many taps it continued, who could not be helped any
 * more with name, campaign, time and why, how many got the first DM without
 * tapping, whom it could not look at; while it runs, that it runs), the
 * timeline's line, the all-clear e-mail's part (German with du, English,
 * escaping, the cap of the list, a list that stands on its own, one person
 * or several), and the texts in every catalog.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MessagingSilenceReports, {
  LISTED_REASON_TEXT,
  LOOK_YOURSELF_TEXT,
} from "../components/messaging-silence-report";
import { createI18n } from "../lib/i18n";
import de from "../lib/i18n/de.json";
import ptBR from "../lib/i18n/pt-BR.json";
import ru from "../lib/i18n/ru.json";
import zhTW from "../lib/i18n/zh-TW.json";
import { I18nProvider } from "../lib/i18n/provider";
import type { LostTapResult } from "../lib/instagram/lost-tap-state";
import {
  messagingSilenceReports,
  readMessagingSilenceResult,
  type MessagingSilenceReport,
} from "../lib/instagram/messaging-silence-incident";
import { eventDetail } from "../lib/ops/event-details";
import { buildMessagingSilenceAllClearEmail } from "../lib/ops/messaging-silence-email";

const FORMAL = /\b(?:Sie|Ihnen|Ihr|Ihre[mnrs]?)\b/;
const SINCE = "2026-11-25T13:15:16.000Z";
const ENDED = "2026-11-26T10:30:57.000Z";

const TAPS: LostTapResult = {
  v: 1,
  finishedAt: "2026-11-26T10:40:00.000Z",
  people: 6,
  continued: 2,
  firstJobAt: "2026-11-26T10:40:00.000Z",
  lastJobAt: "2026-11-26T10:42:30.000Z",
  listed: [
    { username: "gerd", campaign: "Guide Schimmel", tappedAt: "2026-11-25T13:21:00.000Z", reason: "window" },
    { username: null, campaign: "Checkliste <Dach>", tappedAt: "2026-11-25T14:00:00.000Z", reason: "campaign" },
  ],
  noTap: 2,
  answered: 1,
  notChecked: 1,
  reads: 5,
  gaveUp: false,
  complete: false,
};

function report(overrides: Partial<MessagingSilenceReport> = {}): MessagingSilenceReport {
  return {
    accountId: "account_1",
    username: "thomas.tergan",
    since: SINCE,
    endedAt: ENDED,
    earlier: [],
    searching: false,
    taps: TAPS,
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

describe("Diagnostics after a silence", () => {
  it("shows how long it lasted and what the search found, in German", () => {
    const html = inGerman(createElement(MessagingSilenceReports, { reports: [report()] }));
    expect(html).toContain("Nach den fehlenden Button-Tipps");
    expect(html).toContain("Das waren etwa 21 Stunden.");
    expect(html).toContain("Verlorene Tipps gefunden und weitergeführt: 2");
    expect(html).toContain("Diese Tipps konnten nicht mehr weitergeführt werden:");
    expect(html).toContain("@gerd");
    expect(html).toContain("Kampagne „Guide Schimmel“");
    expect(html).toContain("Instagram erlaubt eine Antwort nur bis 24 Stunden nach dem Tipp.");
    // User content is escaped, and a person without a name gets a dash.
    expect(html).toContain("Kampagne „Checkliste &lt;Dach&gt;“");
    expect(html).toContain("Die Kampagne ist pausiert.");
    expect(html).toContain("—");
    expect(html).toMatch(/Getippt: 25\.11\.2026, \d\d:\d\d/);
    expect(html).toContain(
      "Schau dir die Unterhaltungen am besten selbst in Instagram an und schick den Leuten, worum sie gebeten haben, falls sie es noch nicht haben."
    );
    expect(html).toContain("Nach der Störung von selbst weitergegangen: 1");
    expect(html).toContain("Haben in dieser Zeit deine erste DM bekommen, aber nicht getippt: 2");
    expect(html).toContain("Nicht nachgesehen: 1. Schau dir diese Unterhaltungen selbst in Instagram an.");
    // Long names wrap instead of widening a phone screen.
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).not.toMatch(FORMAL);
  });

  it("says when nothing got lost, and while the search runs that it runs", () => {
    const none = inGerman(
      createElement(MessagingSilenceReports, {
        reports: [
          report({
            taps: { ...TAPS, continued: 0, listed: [], answered: 0, notChecked: 0, complete: true },
          }),
        ],
      })
    );
    expect(none).toContain("In dieser Zeit ist kein Button-Tipp verloren gegangen.");
    expect(none).not.toContain("Nicht nachgesehen");

    const running = inGerman(
      createElement(MessagingSilenceReports, { reports: [report({ searching: true, taps: null })] })
    );
    expect(running).toContain(
      "@thomas.tergan: OpenReply sucht gerade nach Button-Tipps, die in dieser Zeit verloren gegangen sind …"
    );
    expect(running).not.toContain("Verlorene Tipps");
  });

  it("explains a tap in that time for a silence without a search", () => {
    const html = inGerman(createElement(MessagingSilenceReports, { reports: [report({ taps: null })] }));
    expect(html).toContain("In Instagram siehst du so einen Tipp in der Unterhaltung als Nachricht mit dem Text des Buttons.");
  });

  it("says why a tap after which someone wrote, or one another campaign's button shares, was not continued, and what to do for one person", () => {
    const html = inGerman(
      createElement(MessagingSilenceReports, {
        reports: [
          report({
            taps: {
              ...TAPS,
              listed: [
                { username: "anna", campaign: "Guide Schimmel", tappedAt: "2026-11-25T20:51:10.000Z", reason: "replied" },
              ],
            },
          }),
        ],
      })
    );
    expect(html).toContain(
      "Nach dem Tipp kam von deinem Konto eine Nachricht, die nicht OpenReply geschickt hat. Damit nichts doppelt ankommt, macht OpenReply hier nicht weiter."
    );
    // One person: not "them".
    expect(html).toContain(
      "Schau dir die Unterhaltung am besten selbst in Instagram an und schick der Person, worum sie gebeten hat, falls sie es noch nicht hat."
    );
    const unclear = inGerman(
      createElement(MessagingSilenceReports, {
        reports: [
          report({
            taps: {
              ...TAPS,
              listed: [
                { username: "ben", campaign: "Guide Dach", tappedAt: "2026-11-26T07:31:00.000Z", reason: "unclear" },
              ],
            },
          }),
        ],
      })
    );
    expect(unclear).toContain(
      "Mehrere deiner Kampagnen haben einen Button mit diesem Text. OpenReply kann nicht erkennen, ob der Tipp dieser Kampagne galt."
    );
  });

  it("names an earlier silence reported with it by its own time, not one span over the hours in between", () => {
    const html = inGerman(
      createElement(MessagingSilenceReports, {
        reports: [
          report({
            since: "2026-11-26T20:00:00.000Z",
            endedAt: "2026-11-27T09:00:00.000Z",
            earlier: [{ since: SINCE, endedAt: ENDED }],
          }),
        ],
      })
    );
    expect(html).toContain("Das waren etwa 13 Stunden.");
    expect(html).toMatch(/Schon davor kam von 25\.11\.2026, \d\d:\d\d bis 26\.11\.2026, \d\d:\d\d nichts an: etwa 21 Stunden\./);
  });

  it("reads the search with the silence from the row, and while it is owed", () => {
    const result = { v: 1, since: SINCE, endedAt: ENDED, via: "webhook", taps: TAPS };
    expect(readMessagingSilenceResult(result)?.taps).toEqual(TAPS);
    expect(readMessagingSilenceResult({ ...result, taps: { v: 2 } })).not.toHaveProperty("taps");
    // Earlier silences reported with it, and what one of them carried, kept
    // as written; anything else left out.
    const earlier = [{ since: "2026-11-24T08:00:00.000Z", endedAt: "2026-11-24T20:00:00.000Z" }];
    expect(
      readMessagingSilenceResult({
        ...result,
        earlier: [...earlier, { since: "x", endedAt: ENDED }, null],
        carried: TAPS,
      })
    ).toEqual({ ...result, earlier, carried: TAPS });
    expect(readMessagingSilenceResult({ ...result, earlier: "x", carried: { v: 2 } })).toEqual(result);
    const now = Date.parse("2026-11-26T12:00:00.000Z");
    expect(
      messagingSilenceReports(
        [
          { id: "a", username: "done", messagingSilentSince: null, messagingSilenceResult: result },
          {
            id: "b",
            username: "running",
            messagingSilentSince: null,
            messagingSilenceResult: { ...result, taps: undefined },
            messagingTapSearchFrom: new Date(SINCE),
          },
        ],
        now
      ).map((item) => [item.username, item.searching, item.taps?.continued ?? null])
    ).toEqual([
      ["done", false, 2],
      ["running", true, null],
    ]);
  });

  it("names the search in the timeline in the reader's language", () => {
    expect(
      eventDetail({ kind: "messaging-tap-search", account: "studio", continued: 2, listed: 1, noTap: 3, notChecked: 0 })
    ).toEqual({ kind: "messaging-tap-search", account: "studio", continued: 2, listed: 1, noTap: 3 });
    expect(eventDetail({ kind: "messaging-tap-search", account: "studio", continued: -1, listed: 1, noTap: 3 })).toBeNull();
    const { t } = createI18n("de");
    expect(
      t(
        "Search for lost button taps of @{account} done: {continued} continued, {listed} could not be continued, {noTap} without a tap.",
        { account: "studio", continued: 2, listed: 1, noTap: 3 }
      )
    ).toBe("Suche nach verlorenen Button-Tipps für @studio fertig: 2 weitergeführt, 1 nicht mehr möglich, 3 ohne Tipp.");
  });
});

describe("the all-clear's part about the search", () => {
  const input = {
    username: "thomas.tergan",
    since: new Date(SINCE),
    endedAt: new Date(ENDED),
    taps: TAPS,
  };

  it("lists who could not be helped with name, campaign and time, in German with du", () => {
    const { text, html } = buildMessagingSilenceAllClearEmail({ ...input, locale: "de" });
    for (const line of [
      "Die Störung dauerte etwa 21 Stunden und 15 Minuten: vom 25.11.2026 um 14:15 Uhr bis zum 26.11.2026 um 11:30 Uhr.",
      "Bei 2 Leuten, die in dieser Zeit getippt haben, konnte OpenReply nicht mehr weitermachen:",
      "- @gerd, Kampagne „Guide Schimmel“, getippt am 25.11.2026 um 14:21 Uhr: Instagram erlaubt eine Antwort nur bis 24 Stunden nach dem Tipp.",
      "- (ohne Namen), Kampagne „Checkliste <Dach>“, getippt am 25.11.2026 um 15:00 Uhr: Die Kampagne ist pausiert.",
      "Schau dir die Unterhaltungen am besten selbst in Instagram an und schick den Leuten, worum sie gebeten haben, falls sie es noch nicht haben.",
      "Bei 1 Person konnte OpenReply nicht nachsehen. Schau dort selbst in Instagram in die Unterhaltung.",
    ]) {
      expect(text).toContain(line);
    }
    expect(html).toContain("Checkliste &lt;Dach&gt;");
    expect(html).not.toContain("<Dach>");
    expect(text).not.toMatch(FORMAL);
  });

  it("in English with UTC, and lists at most 50 by name", () => {
    const many = Array.from({ length: 53 }, (_, n) => ({
      username: `person_${n}`,
      campaign: "Guide",
      tappedAt: "2026-11-25T13:21:00.000Z",
      reason: "window" as const,
    }));
    const { text } = buildMessagingSilenceAllClearEmail({
      ...input,
      locale: "en",
      taps: { ...TAPS, continued: 1, listed: many, notChecked: 0, gaveUp: true },
    });
    expect(text).toContain(
      "1 person tapped the button in your first DM in that time, and the tap got lost. OpenReply found it in the conversation and continues with them now as if the tap had arrived."
    );
    expect(text).toContain("53 people tapped the button in that time, but OpenReply could no longer continue with them:");
    expect(text).toContain("- @person_0, campaign “Guide”, tapped on 25 November 2026, 13:21 UTC: Instagram allows an answer only within 24 hours of the tap.");
    expect(text).toContain("- @person_49,");
    expect(text).not.toContain("@person_50,");
    expect(text).toContain("… and 3 more, whom you find in OpenReply's Diagnostics.");
    expect(text).toContain("The search took too long: OpenReply ended it after 24 hours.");
  });

  // No tap was continued (all of them too late, say): the list follows the
  // duration right away and must say itself who these people are.
  const alone = {
    ...TAPS,
    continued: 0,
    firstJobAt: null,
    lastJobAt: null,
    answered: 0,
    noTap: 0,
    notChecked: 0,
    complete: true,
    listed: [{ username: "anna", campaign: "Schimmel-Guide", tappedAt: "2026-11-25T08:00:00.000Z", reason: "window" as const }],
  };

  it("introduces a list that stands on its own, for one person in the singular, in German", () => {
    const { text } = buildMessagingSilenceAllClearEmail({ ...input, locale: "de", taps: alone });
    const lines = text.split("\n").filter(Boolean);
    const lasted = lines.findIndex((line) => line.startsWith("Die Störung dauerte"));
    expect(lines.slice(lasted + 1, lasted + 4)).toEqual([
      "Bei 1 Person, die in dieser Zeit getippt hat, konnte OpenReply nicht mehr weitermachen:",
      "- @anna, Kampagne „Schimmel-Guide“, getippt am 25.11.2026 um 09:00 Uhr: Instagram erlaubt eine Antwort nur bis 24 Stunden nach dem Tipp.",
      "Schau dir die Unterhaltung am besten selbst in Instagram an und schick der Person, worum sie gebeten hat, falls sie es noch nicht hat.",
    ]);
    expect(text).not.toContain("ging das nicht mehr");
    expect(text).not.toMatch(FORMAL);
  });

  it("and in English", () => {
    const { text } = buildMessagingSilenceAllClearEmail({ ...input, locale: "en", taps: alone });
    expect(text).toContain("1 person tapped the button in that time, but OpenReply could no longer continue with them:");
    expect(text).toContain(
      "Best look at the conversation yourself in Instagram and send the person what they asked for, if they do not have it yet."
    );
    expect(text).not.toContain("that was no longer possible");
  });

  it("says why a tap after which someone wrote, or one another campaign's button shares, is not continued", () => {
    const { text } = buildMessagingSilenceAllClearEmail({
      ...input,
      locale: "de",
      taps: {
        ...alone,
        listed: [
          { username: "anna", campaign: "Guide Schimmel", tappedAt: "2026-11-25T20:51:10.000Z", reason: "replied" },
          { username: "ben", campaign: "Guide Dach", tappedAt: "2026-11-26T07:31:00.000Z", reason: "unclear" },
        ],
      },
    });
    expect(text).toContain(
      "- @anna, Kampagne „Guide Schimmel“, getippt am 25.11.2026 um 21:51 Uhr: Danach kam von deinem Konto eine Nachricht, die nicht OpenReply geschickt hat. Damit nichts doppelt ankommt, macht OpenReply hier nicht weiter."
    );
    expect(text).toContain(
      "- @ben, Kampagne „Guide Dach“, getippt am 26.11.2026 um 08:31 Uhr: Mehrere deiner Kampagnen haben einen Button mit diesem Text, und OpenReply kann nicht erkennen, ob der Tipp dieser Kampagne galt."
    );
    expect(text).not.toMatch(FORMAL);
  });

  it("names every silence it reports by its own time, and its numbers as of those times", () => {
    const { text, html } = buildMessagingSilenceAllClearEmail({
      ...input,
      locale: "de",
      since: new Date("2026-11-26T20:00:00.000Z"),
      endedAt: new Date("2026-11-27T09:00:00.000Z"),
      earlier: [{ since: new Date(SINCE), endedAt: new Date(ENDED) }],
    });
    for (const line of [
      "Die Störung dauerte etwa 13 Stunden: vom 26.11.2026 um 21:00 Uhr bis zum 27.11.2026 um 10:00 Uhr.",
      "Schon davor kam einmal nichts an: vom 25.11.2026 um 14:15 Uhr bis zum 26.11.2026 um 11:30 Uhr, etwa 21 Stunden und 15 Minuten.",
      "2 Leute haben in diesen Zeiten auf den Button in deiner ersten DM getippt",
      "Bei 2 Leuten, die in diesen Zeiten getippt haben, konnte OpenReply nicht mehr weitermachen:",
      "2 Leute haben in diesen Zeiten deine erste DM bekommen, aber nicht auf den Button getippt.",
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toContain("in dieser Zeit");
    expect(html).toContain("Schon davor kam einmal nichts an");
    const english = buildMessagingSilenceAllClearEmail({
      ...input,
      locale: "en",
      earlier: [{ since: new Date("2026-11-24T08:00:00.000Z"), endedAt: new Date("2026-11-24T20:00:00.000Z") }],
    }).text;
    expect(english).toContain(
      "Before that, nothing arrived either on 24 November 2026 from 08:00 to 20:00 UTC, about 12 hours."
    );
    expect(english).toContain("2 people got your first DM during those times but did not tap the button.");
  });
});

describe("the texts", () => {
  const keys = [
    ...Object.values(LISTED_REASON_TEXT),
    "That was about {hours} hours.",
    "@{account}: looking for button taps that got lost in that time …",
    "Lost taps found and continued: {count}",
    "No button tap got lost in that time.",
    "These taps could not be continued:",
    "Tapped: {time}",
    "Campaign “{campaign}”",
    ...Object.values(LOOK_YOURSELF_TEXT),
    "Before that, nothing arrived either from {from} to {to}: about {hours} hours.",
    "Went on by itself after the silence: {count}",
    "Got your first DM in that time without tapping: {count}",
    "Could not be checked: {count}. Look at their conversations in Instagram yourself.",
    "Search for lost button taps of @{account} done: {continued} continued, {listed} could not be continued, {noTap} without a tap.",
  ] as const;

  it("exist in every language, informally in German", () => {
    for (const catalog of [zhTW, ptBR, ru, de]) {
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
      // The advice that said "them" for one person too is gone.
      expect(catalog, "old advice").not.toHaveProperty(["Best write to them yourself in Instagram."]);
    }
    for (const key of keys) expect(de[key], key).not.toMatch(FORMAL);
  });
});
