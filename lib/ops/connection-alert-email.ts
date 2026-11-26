/**
 * The words of the alert e-mail about a lost Instagram connection (A1,
 * lib/ops/connection-alert.ts): German with "du" when the installation's
 * DEFAULT_LOCALE is de, English otherwise. Plain text plus simple HTML of the
 * same content.
 *
 * What it says: since when (Europe/Berlin time in German, UTC in English),
 * what that means, the usual causes, the fix in three steps with a link to
 * the settings page, and that the comments of the meantime are caught up
 * afterwards. Nothing else: no tracking (no image, no tracked or tagged
 * link), no token, no account id, no Meta error text.
 *
 * Pure: no database, no clock, no environment.
 */

import type { ConnectionLostKind } from "@/lib/instagram/connection-incident";

export type AlertLocale = "de" | "en";
/** The first e-mail of an incident, or its one reminder after 24 hours. */
export type ConnectionAlertKind = "alert" | "reminder";

export interface ConnectionAlertEmailInput {
  locale: AlertLocale;
  kind: ConnectionAlertKind;
  /** The Instagram handle, without "@". */
  username: string;
  /** Since when the connection is lost. */
  lostAt: Date;
  reason: ConnectionLostKind;
  /** `{NEXTAUTH_URL}/settings`; null when the worker does not know the app's address. */
  settingsUrl: string | null;
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

interface Copy {
  subject: Record<ConnectionAlertKind, string>;
  greeting: string;
  lead: (values: { date: string; time: string; account: string }) => string;
  reminderLead: string;
  meaningTitle: string;
  meaning: string[];
  reasonLabel: string;
  reasons: Record<ConnectionLostKind, string>;
  causesTitle: string;
  causes: string[];
  fixTitle: string;
  fixOpen: (url: string | null) => string;
  fixSteps: [string, string];
  openSettings: string;
  catchUp: string;
  footer: Record<ConnectionAlertKind, string>;
}

const COPY: Record<AlertLocale, Copy> = {
  de: {
    subject: {
      alert: "Instagram-Verbindung unterbrochen: OpenReply sendet gerade keine DMs",
      reminder:
        "Erinnerung: Instagram-Verbindung noch unterbrochen, OpenReply sendet weiter keine DMs",
    },
    greeting: "Hallo,",
    lead: ({ date, time, account }) =>
      `seit dem ${date} um ${time} Uhr erreicht OpenReply dein Instagram-Konto ${account} nicht mehr.`,
    reminderLead:
      "Das ist die Erinnerung: Die Verbindung ist seit über 24 Stunden unterbrochen.",
    meaningTitle: "Was das heißt:",
    meaning: [
      "Auf Kommentare mit deinen Keywords geht keine DM raus.",
      "Tippt jemand in einer DM auf einen Button, passiert nichts.",
      "Unter Kommentaren erscheinen keine öffentlichen Antworten.",
    ],
    reasonLabel: "Meta meldet:",
    reasons: {
      token: "Der Zugang von OpenReply zu deinem Konto ist abgelaufen oder wurde widerrufen.",
      permission: "OpenReply fehlen Berechtigungen für dein Konto.",
      missing: "OpenReply hat keinen Zugriff mehr auf dein Instagram-Konto.",
      unknown: "Meta lehnt den Zugriff auf dein Konto ab.",
    },
    causesTitle: "Meistens steckt eine dieser Änderungen dahinter:",
    causes: [
      "Instagram wurde mit Facebook verknüpft oder davon getrennt.",
      "Im Unternehmensportfolio (Meta Business Suite) hat sich etwas geändert.",
      "Die App wurde in Instagram unter „Apps und Websites“ entfernt.",
      "Das Passwort oder die Sicherheitseinstellungen wurden geändert.",
    ],
    fixTitle: "So verbindest du neu (dauert etwa zwei Minuten):",
    fixOpen: (url) =>
      url
        ? `Öffne die Einstellungen von OpenReply: ${url}`
        : "Öffne in OpenReply die Einstellungen.",
    fixSteps: [
      "Tippe auf „Neu verbinden“ oder „Mit eigener Meta-App verbinden“ und melde dich bei Meta an.",
      "Wähle dein Instagram-Konto und erlaube alle Berechtigungen.",
    ],
    openSettings: "Einstellungen öffnen",
    catchUp:
      "Danach holt OpenReply die Kommentare aus der Zwischenzeit von selbst nach.",
    footer: {
      alert:
        "Diese E-Mail hat deine OpenReply-Installation automatisch geschickt. Ist die Verbindung in 24 Stunden noch unterbrochen, bekommst du einmal eine Erinnerung.",
      reminder:
        "Diese E-Mail hat deine OpenReply-Installation automatisch geschickt. Weitere Erinnerungen kommen nicht. Sobald die Verbindung wieder steht, bekommst du eine kurze Entwarnung; wie es steht, siehst du jederzeit im Dashboard.",
    },
  },
  en: {
    subject: {
      alert: "Instagram connection lost: OpenReply is not sending DMs right now",
      reminder:
        "Reminder: Instagram connection still lost, OpenReply is still not sending DMs",
    },
    greeting: "Hello,",
    lead: ({ date, time, account }) =>
      `Since ${date}, ${time} UTC, OpenReply can no longer reach your Instagram account ${account}.`,
    reminderLead: "This is the reminder: the connection has been lost for more than 24 hours.",
    meaningTitle: "What this means:",
    meaning: [
      "Comments with your keywords get no DM.",
      "When someone taps a button in a DM, nothing happens.",
      "No public replies appear under comments.",
    ],
    reasonLabel: "Meta says:",
    reasons: {
      token: "OpenReply's access to your account has expired or was revoked.",
      permission: "OpenReply is missing permissions for your account.",
      missing: "OpenReply no longer has access to your Instagram account.",
      unknown: "Meta refuses access to your account.",
    },
    causesTitle: "Usually one of these changes is behind it:",
    causes: [
      "Instagram was linked to or unlinked from Facebook.",
      "Something changed in your business portfolio (Meta Business Suite).",
      "The app was removed in Instagram under “Apps and websites”.",
      "The password or the security settings were changed.",
    ],
    fixTitle: "To reconnect (takes about two minutes):",
    fixOpen: (url) =>
      url ? `Open OpenReply's settings: ${url}` : "Open the settings in OpenReply.",
    fixSteps: [
      "Tap “Reconnect” or “Connect using your own Meta app” and log in with Meta.",
      "Choose your Instagram account and allow all permissions.",
    ],
    openSettings: "Open settings",
    catchUp: "Afterwards OpenReply catches up on the comments of the meantime by itself.",
    footer: {
      alert:
        "This e-mail was sent automatically by your OpenReply installation. If the connection is still lost in 24 hours, you get one reminder.",
      reminder:
        "This e-mail was sent automatically by your OpenReply installation. No further reminders follow. Once the connection is back, you get a short all-clear; the dashboard always shows where it stands.",
    },
  },
};

/** The date and the time of `at` as the e-mail names them. */
export function formatAlertTime(
  at: Date,
  locale: AlertLocale
): { date: string; time: string } {
  if (locale === "de") {
    const zone = "Europe/Berlin";
    return {
      date: new Intl.DateTimeFormat("de-DE", {
        timeZone: zone,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(at),
      time: new Intl.DateTimeFormat("de-DE", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(at),
    };
  }
  return {
    date: new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(at),
    time: new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The alert e-mail: subject, plain text and simple HTML. */
export function buildConnectionAlertEmail(
  input: ConnectionAlertEmailInput
): EmailContent {
  const copy = COPY[input.locale];
  const { date, time } = formatAlertTime(input.lostAt, input.locale);
  const account = `@${input.username}`;
  const lead = copy.lead({ date, time, account });
  const reason = copy.reasons[input.reason];
  const steps = [copy.fixOpen(input.settingsUrl), ...copy.fixSteps];
  const reminder = input.kind === "reminder";

  const text = [
    copy.greeting,
    "",
    lead,
    ...(reminder ? ["", copy.reminderLead] : []),
    "",
    copy.meaningTitle,
    ...copy.meaning.map((line) => `- ${line}`),
    "",
    `${copy.reasonLabel} ${reason}`,
    "",
    copy.causesTitle,
    ...copy.causes.map((line) => `- ${line}`),
    "",
    copy.fixTitle,
    ...steps.map((line, index) => `${index + 1}. ${line}`),
    "",
    copy.catchUp,
    "",
    "--",
    copy.footer[input.kind],
    "",
  ].join("\n");

  const list = (items: string[], tag: "ul" | "ol") =>
    `<${tag} style="margin:0 0 16px;padding-left:20px">${items
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("")}</${tag}>`;
  const paragraph = (value: string, style = "") =>
    `<p style="margin:0 0 16px${style}">${escapeHtml(value)}</p>`;
  const button = input.settingsUrl
    ? `<p style="margin:0 0 16px"><a href="${escapeHtml(input.settingsUrl)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#f97316;color:#ffffff;font-weight:600;text-decoration:none">${escapeHtml(copy.openSettings)}</a></p>`
    : "";

  const html = [
    "<!doctype html>",
    `<html lang="${input.locale}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(copy.subject[input.kind])}</title></head>`,
    '<body style="margin:0;padding:24px 16px;background:#ffffff;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5">',
    '<div style="max-width:560px;margin:0 auto">',
    paragraph(copy.greeting),
    `<p style="margin:0 0 16px;font-weight:600">${escapeHtml(lead)}</p>`,
    reminder ? paragraph(copy.reminderLead) : "",
    paragraph(copy.meaningTitle, ";font-weight:600"),
    list(copy.meaning, "ul"),
    paragraph(`${copy.reasonLabel} ${reason}`),
    paragraph(copy.causesTitle, ";font-weight:600"),
    list(copy.causes, "ul"),
    paragraph(copy.fixTitle, ";font-weight:600"),
    list(steps, "ol"),
    button,
    paragraph(copy.catchUp),
    `<p style="margin:24px 0 0;color:#71717a;font-size:13px">${escapeHtml(copy.footer[input.kind])}</p>`,
    "</div>",
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject: copy.subject[input.kind], text, html };
}
