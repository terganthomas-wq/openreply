/**
 * A lost Instagram connection (A1) on the dashboard: the stored reason read
 * back, the banner above every page and the account's notice on the settings
 * page in German, what members see instead of "Neu verbinden", and the texts
 * in every catalog.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

import {
  ConnectionIncidentBanner,
  ConnectionIncidentNotice,
} from "../components/connection-incident";
import DashboardShell from "../components/dashboard-shell";
import { createI18n } from "../lib/i18n";
import de from "../lib/i18n/de.json";
import ptBR from "../lib/i18n/pt-BR.json";
import ru from "../lib/i18n/ru.json";
import zhTW from "../lib/i18n/zh-TW.json";
import { I18nProvider } from "../lib/i18n/provider";
import {
  CONNECTION_LOST_REASON_TEXT,
  connectionIncidentOf,
  connectionLostCode,
  connectionLostKind,
  formatConnectionLostReason,
  formatIncidentTime,
  RECONNECT_URL,
  type ConnectionIncident,
} from "../lib/instagram/connection-incident";
import { eventDetail } from "../lib/ops/event-details";

const INCIDENT: ConnectionIncident = {
  accountId: "account_1",
  username: "thomas.tergan",
  since: "2026-11-25T16:45:00.000Z",
  reason: "missing",
};

function inGerman(element: ReactElement) {
  return renderToStaticMarkup(
    // A .ts test has no JSX, and the provider's props require children.
    // eslint-disable-next-line react/no-children-prop
    createElement(I18nProvider, { locale: "de", children: element })
  );
}

describe("the stored reason", () => {
  it("is short, without a token, and reads back as its kind and code", () => {
    expect(formatConnectionLostReason("missing", 100, 33)).toBe("missing (Meta 100/33)");
    expect(formatConnectionLostReason("token", 190)).toBe("token (Meta 190)");
    expect(connectionLostKind("missing (Meta 100/33)")).toBe("missing");
    expect(connectionLostKind("permission (Meta 10)")).toBe("permission");
    expect(connectionLostKind("token (Meta 190/460)")).toBe("token");
    for (const other of [null, undefined, "", "scopes (debug_token)", "tokenized"]) {
      expect(connectionLostKind(other)).toBe("unknown");
    }
    expect(connectionLostCode("missing (Meta 100/33)")).toBe("Meta 100/33");
    expect(connectionLostCode("token (Meta 190)")).toBe("Meta 190");
    expect(connectionLostCode("token")).toBeNull();
  });

  it("makes an incident only of an account whose connection is lost", () => {
    expect(
      connectionIncidentOf({ id: "a", username: "shop", connectionLostAt: null })
    ).toBeNull();
    expect(connectionIncidentOf({ id: "a", username: "shop" })).toBeNull();
    expect(
      connectionIncidentOf({
        id: "a",
        username: "shop",
        connectionLostAt: new Date("2026-11-25T16:45:00.000Z"),
        connectionLostReason: "token (Meta 190)",
      })
    ).toEqual({ accountId: "a", username: "shop", since: "2026-11-25T16:45:00.000Z", reason: "token" });
    // As JSON from the stats route.
    expect(
      connectionIncidentOf({
        id: "a",
        username: "shop",
        connectionLostAt: "2026-11-25T16:45:00.000Z",
        connectionLostReason: "something new",
      })?.reason
    ).toBe("unknown");
  });

  it("formats when it began in the reader's language", () => {
    expect(formatIncidentTime(INCIDENT.since, "de")).toMatch(/^25\.11\.2026, \d\d:\d\d$/);
    expect(formatIncidentTime(INCIDENT.since, "en")).toMatch(/^Nov 25, 2026, \d{1,2}:\d\d\s?[AP]M$/);
  });
});

describe("the banner above every page", () => {
  it("says the connection is lost, why, what that means, with Neu verbinden", () => {
    const html = inGerman(
      createElement(ConnectionIncidentBanner, { incidents: [INCIDENT], canManage: true })
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Instagram-Verbindung unterbrochen");
    // The server knows no time zone: the time comes with the browser.
    expect(html).toContain("@thomas.tergan: Verbindung unterbrochen");
    expect(html).toContain(
      "Meta gibt OpenReply keinen Zugriff mehr auf dieses Konto, zum Beispiel nachdem Instagram mit Facebook verknüpft oder davon getrennt wurde oder sich in deinem Unternehmensportfolio etwas geändert hat."
    );
    expect(html).toContain(
      "OpenReply sendet gerade keine DMs: keine DMs zu Kommentaren, keine Antworten auf Button-Klicks, keine öffentlichen Antworten."
    );
    expect(html).toMatch(/<a href="\/api\/instagram\/connect"[^>]*>Neu verbinden<\/a>/);
    expect(RECONNECT_URL).toBe("/api/instagram/connect");
  });

  it("asks a member to have an owner or admin reconnect, without the button", () => {
    const html = inGerman(
      createElement(ConnectionIncidentBanner, { incidents: [INCIDENT], canManage: false })
    );
    expect(html).toContain(
      "Bitte den Inhaber oder einen Admin deines Workspaces, Instagram neu zu verbinden."
    );
    expect(html).not.toContain("/api/instagram/connect");
  });

  it("shows nothing while every connection works", () => {
    // Only the language provider's own wrapper.
    expect(
      inGerman(createElement(ConnectionIncidentBanner, { incidents: [], canManage: true }))
    ).toBe('<div lang="de" class="contents"></div>');
  });

  it("is part of every dashboard page", () => {
    const shell = (incidents: ConnectionIncident[]) =>
      inGerman(
        // As for the provider: the shell's props require children.
        // eslint-disable-next-line react/no-children-prop
        createElement(DashboardShell, {
          workspaceName: "Studio",
          instagramUsername: "thomas.tergan",
          instagramAccountCount: 1,
          canManage: true,
          connectionIncidents: incidents,
          children: createElement("p", null, "page-content"),
        })
      );
    const html = shell([INCIDENT]);
    expect(html).toContain("Instagram-Verbindung unterbrochen");
    // Below the top bar, at the top of the scrolling page, above its content.
    expect(html.indexOf("</header>")).toBeLessThan(html.indexOf("<main"));
    expect(html.indexOf("<main")).toBeLessThan(html.indexOf("Instagram-Verbindung unterbrochen"));
    expect(html.indexOf("Instagram-Verbindung unterbrochen")).toBeLessThan(html.indexOf("page-content"));
    expect(shell([])).not.toContain("Instagram-Verbindung unterbrochen");
  });
});

describe("the account on the settings page", () => {
  it("shows since when, why, what to do and Neu verbinden instead of Verbunden", () => {
    const html = inGerman(
      createElement(ConnectionIncidentNotice, {
        incident: { ...INCIDENT, reason: "token" },
        canManage: true,
      })
    );
    expect(html).toMatch(/Verbindung unterbrochen seit 25\.11\.2026, \d\d:\d\d/);
    expect(html).toContain(
      "Meta akzeptiert den Zugang von OpenReply zu diesem Konto nicht mehr, zum Beispiel nach einer Passwort- oder Sicherheitsänderung."
    );
    expect(html).toContain(
      "So behebst du es: Tippe auf „Neu verbinden“, melde dich bei Meta an, wähle dein Instagram-Konto und erlaube alle Berechtigungen. Danach holt OpenReply die Kommentare aus der Zwischenzeit nach."
    );
    expect(html).toMatch(/<a href="\/api\/instagram\/connect"[^>]*>Neu verbinden<\/a>/);
    expect(html).not.toContain(">Verbunden<");
  });

  it("asks a member to have it done", () => {
    const html = inGerman(
      createElement(ConnectionIncidentNotice, { incident: INCIDENT, canManage: false })
    );
    expect(html).toContain("Bitte den Inhaber oder einen Admin deines Workspaces, Instagram neu zu verbinden.");
    expect(html).not.toContain("/api/instagram/connect");
    expect(html).not.toContain("So behebst du es");
  });
});

describe("the events in Diagnostics", () => {
  it("hand the page only what it needs to name them", () => {
    expect(
      eventDetail({
        kind: "connection-lost",
        account: "shop",
        lostAt: "2026-11-25T16:45:00.000Z",
        reason: "missing (Meta 100/33)",
        instagramAccountId: "ig_1",
      })
    ).toEqual({ kind: "connection-lost", account: "shop", lostAt: "2026-11-25T16:45:00.000Z" });
    expect(eventDetail({ kind: "connection-lost", account: "shop", lostAt: "soon" })).toBeNull();
    expect(
      eventDetail({ kind: "connection-back", account: "shop", catchUpFrom: "2026-11-25T16:45:00.000Z" })
    ).toEqual({ kind: "connection-back", account: "shop" });
    expect(
      eventDetail({ kind: "connection-alert", account: "shop", recipients: 2, reminder: true })
    ).toEqual({ kind: "connection-alert", account: "shop", recipients: 2, reminder: true });
    expect(eventDetail({ kind: "connection-alert", account: "shop", recipients: 0 })).toBeNull();
    expect(eventDetail({ kind: "mail-unconfigured" })).toEqual({ kind: "mail-unconfigured" });
  });
});

describe("the texts", () => {
  const keys = [
    "Instagram connection lost",
    "@{account}: connection lost since {time}",
    "@{account}: connection lost",
    "OpenReply is not sending DMs right now: no DMs for comments, no replies to button taps, no public replies.",
    "Reconnect",
    "Ask your workspace owner or an admin to reconnect Instagram.",
    "Connection lost since {time}",
    "Connection lost",
    ...Object.values(CONNECTION_LOST_REASON_TEXT),
    "To fix it: tap “Reconnect”, log in with Meta, choose your Instagram account and allow all permissions. OpenReply then catches up on the comments of the meantime.",
    "The connection to Instagram has been lost since {time}. Reconnect, then you can send DMs here again.",
    "The connection to Instagram is lost. Reconnect first.",
    "Alert e-mail sent: {time}",
    "No alert e-mail sent yet",
    "Instagram connection of @{account} lost since {time}. No DMs go out until it is reconnected.",
    "Instagram connection of @{account} is back.",
    "Alert e-mail about the lost connection of @{account} sent. Recipients: {count}",
    "Reminder about the lost connection of @{account} sent. Recipients: {count}",
    "Warning e-mails about Instagram problems cannot go out: the sending service has no e-mail settings (RESEND_API_KEY and EMAIL_FROM).",
  ] as const;

  it("exist in every language", () => {
    for (const catalog of [zhTW, ptBR, ru, de]) {
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
    }
  });

  it("name the button as it is labeled, in every language", () => {
    const fix = keys[12];
    expect(fix).toContain("To fix it");
    for (const catalog of [zhTW, ptBR, ru, de]) {
      expect(catalog[fix], fix).toContain(catalog["Reconnect"]);
    }
  });

  it("read as the dashboard in German, informally", () => {
    const { t } = createI18n("de");
    expect(t("Reconnect")).toBe("Neu verbinden");
    expect(t("Connection lost")).toBe("Verbindung unterbrochen");
    expect(t("Connection lost since {time}", { time: "25.11.2026, 17:45" })).toBe(
      "Verbindung unterbrochen seit 25.11.2026, 17:45"
    );
    expect(t("Instagram connection lost")).toBe("Instagram-Verbindung unterbrochen");
    expect(t("The connection to Instagram is lost. Reconnect first.")).toBe(
      "Die Verbindung zu Instagram ist unterbrochen. Verbinde zuerst neu."
    );
    for (const key of keys) {
      expect(de[key], key).not.toMatch(/\b(?:Sie|Ihnen|Ihr|Ihre[mnrs]?)\b/);
    }
  });
});
