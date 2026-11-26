/**
 * The words of the e-mails about a messaging silence (A2,
 * lib/ops/messaging-silence-alert.ts): the alert, its one reminder and the
 * all-clear. German with "du" when the installation's DEFAULT_LOCALE is de,
 * English otherwise, like A1's (lib/ops/connection-alert-email.ts), whose
 * time and duration formats they share. Plain text plus simple HTML of the
 * same content.
 *
 * The alert says what is wrong in plain words, since when (Berlin time in
 * German, UTC in English), what that means, the likely causes and the fix
 * with the link to the settings page. Nothing else: no tracking (no image,
 * no tracked or tagged link), no token, no id.
 *
 * Pure: no database, no clock, no environment.
 */

import { formatDowntime } from "@/lib/ops/connection-all-clear-email";
import {
  formatAlertTime,
  type AlertLocale,
  type ConnectionAlertKind,
  type EmailContent,
} from "@/lib/ops/connection-alert-email";

export interface MessagingSilenceAlertInput {
  locale: AlertLocale;
  kind: ConnectionAlertKind;
  /** The Instagram handle, without "@". */
  username: string;
  /** Since when nothing arrived. */
  since: Date;
  /** `{NEXTAUTH_URL}/settings`; null when the worker does not know the app's address. */
  settingsUrl: string | null;
}

export interface MessagingSilenceAllClearInput {
  locale: AlertLocale;
  username: string;
  since: Date;
  endedAt: Date;
}

interface Copy {
  subject: Record<ConnectionAlertKind, string>;
  allClearSubject: string;
  greeting: string;
  what: string;
  since: (values: { date: string; time: string; account: string }) => string;
  reminderLead: string;
  meaningTitle: string;
  meaning: string[];
  causesTitle: string;
  causes: string[];
  fixTitle: string;
  fixOpen: (url: string | null) => string;
  fixSteps: [string, string];
  fixElse: string;
  openSettings: string;
  ends: string;
  footer: Record<ConnectionAlertKind, string>;
  back: (account: string) => string;
  lasted: (values: {
    duration: string;
    from: { date: string; time: string };
    to: { date: string; time: string };
  }) => string;
  lostTaps: string;
  allClearFooter: string;
}

const COPY: Record<AlertLocale, Copy> = {
  de: {
    subject: {
      alert: "Instagram gibt keine Button-Tipps weiter: Nach der ersten DM passiert nichts",
      reminder: "Erinnerung: Instagram gibt noch immer keine Button-Tipps an OpenReply weiter",
    },
    allClearSubject: "Entwarnung: Instagram gibt wieder Button-Tipps an OpenReply weiter",
    greeting: "Hallo,",
    what: "Instagram gibt gerade keine Button-Tipps, DMs und Lesebestätigungen an OpenReply weiter. Kommentare kommen an, aber nach der ersten DM passiert nichts.",
    since: ({ date, time, account }) =>
      `Seit dem ${date} um ${time} Uhr ist für dein Instagram-Konto ${account} nichts davon angekommen, obwohl seitdem mehrere Leute deine erste DM bekommen haben.`,
    reminderLead: "Das ist die Erinnerung: Seit über 24 Stunden ist nichts davon angekommen.",
    meaningTitle: "Was das heißt:",
    meaning: [
      "Auf Kommentare mit deinen Keywords geht die erste DM wie gewohnt raus.",
      "Tippt jemand darin auf den Button, kommt nichts: kein Link, keine weitere Nachricht.",
      "Schreibt dir jemand eine DM mit einem deiner Keywords, kommt keine automatische Antwort.",
    ],
    causesTitle: "Meistens steckt eine dieser Ursachen dahinter:",
    causes: [
      "Instagram wurde mit einer Facebook-Seite verknüpft oder davon getrennt. Dann beim Neu verbinden die Seite mit auswählen.",
      "In Instagram ist „Zugriff auf Nachrichten erlauben“ ausgeschaltet.",
      "In der Meta Business Suite ist unter „Weiterleiten von Unterhaltungen“ eine andere App als Standard für Instagram eingetragen.",
    ],
    fixTitle: "So behebst du es (dauert etwa zwei Minuten):",
    fixOpen: (url) =>
      url
        ? `Öffne die Einstellungen von OpenReply: ${url}`
        : "Öffne in OpenReply die Einstellungen.",
    fixSteps: [
      "Tippe auf „Neu verbinden“ und melde dich bei Meta an.",
      "Wähle dein Instagram-Konto und, falls es mit einer Facebook-Seite verknüpft ist, auch diese Seite. Erlaube alle Berechtigungen.",
    ],
    fixElse:
      "Hilft das nicht, schalte in Instagram „Zugriff auf Nachrichten erlauben“ ein und prüfe in der Business Suite unter „Weiterleiten von Unterhaltungen“, dass dort keine andere App als Standard für Instagram eingetragen ist.",
    openSettings: "Einstellungen öffnen",
    ends: "Sobald wieder ein Button-Tipp, eine DM oder eine Lesebestätigung ankommt, ist die Warnung von selbst weg, und du bekommst eine kurze Entwarnung.",
    footer: {
      alert:
        "Diese E-Mail hat deine OpenReply-Installation automatisch geschickt. Kommt in 24 Stunden immer noch nichts an, bekommst du einmal eine Erinnerung.",
      reminder:
        "Diese E-Mail hat deine OpenReply-Installation automatisch geschickt. Weitere Erinnerungen kommen nicht. Sobald wieder etwas ankommt, bekommst du eine kurze Entwarnung; wie es steht, siehst du jederzeit im Dashboard.",
    },
    back: (account) =>
      `Instagram gibt wieder Button-Tipps, DMs und Lesebestätigungen an OpenReply weiter (dein Konto ${account}).`,
    lasted: ({ duration, from, to }) =>
      from.date === to.date
        ? `Die Störung dauerte etwa ${duration}: am ${from.date} von ${from.time} bis ${to.time} Uhr.`
        : `Die Störung dauerte etwa ${duration}: vom ${from.date} um ${from.time} Uhr bis zum ${to.date} um ${to.time} Uhr.`,
    lostTaps:
      "Wer in dieser Zeit in deiner ersten DM auf den Button getippt hat, hat nichts bekommen: Der Tipp kam nicht bei OpenReply an. In Instagram siehst du so einen Tipp in der Unterhaltung als Nachricht mit dem Text des Buttons.",
    allClearFooter:
      "Diese E-Mail hat deine OpenReply-Installation automatisch geschickt. Die Störung siehst du auch in der Diagnose.",
  },
  en: {
    subject: {
      alert: "Instagram is not passing on button taps: nothing happens after the first DM",
      reminder: "Reminder: Instagram is still not passing button taps on to OpenReply",
    },
    allClearSubject: "All-clear: Instagram passes button taps on to OpenReply again",
    greeting: "Hello,",
    what: "Instagram is not passing button taps, DMs and read receipts on to OpenReply right now. Comments arrive, but nothing happens after the first DM.",
    since: ({ date, time, account }) =>
      `Since ${date}, ${time} UTC none of them has arrived for your Instagram account ${account}, although several people have got your first DM since.`,
    reminderLead: "This is the reminder: none of them has arrived for more than 24 hours.",
    meaningTitle: "What this means:",
    meaning: [
      "Comments with your keywords get their first DM as usual.",
      "When someone taps its button, nothing comes: no link, no further message.",
      "When someone sends you a DM with one of your keywords, they get no automatic answer.",
    ],
    causesTitle: "Usually one of these is behind it:",
    causes: [
      "Instagram was linked to or unlinked from a Facebook Page. Then select that Page too when you reconnect.",
      "“Allow access to messages” is switched off in Instagram.",
      "In Meta Business Suite, another app is set as the default for Instagram under “Conversation routing”.",
    ],
    fixTitle: "To fix it (takes about two minutes):",
    fixOpen: (url) =>
      url ? `Open OpenReply's settings: ${url}` : "Open the settings in OpenReply.",
    fixSteps: [
      "Tap “Reconnect” and log in with Meta.",
      "Choose your Instagram account and, if it is linked to a Facebook Page, that Page too. Allow all permissions.",
    ],
    fixElse:
      "If that does not help, switch on “Allow access to messages” in Instagram and check under “Conversation routing” in Business Suite that no other app is set as the default for Instagram.",
    openSettings: "Open settings",
    ends: "As soon as a button tap, a DM or a read receipt arrives again, the warning goes away by itself and you get a short all-clear.",
    footer: {
      alert:
        "This e-mail was sent automatically by your OpenReply installation. If nothing has arrived in 24 hours, you get one reminder.",
      reminder:
        "This e-mail was sent automatically by your OpenReply installation. No further reminders follow. As soon as something arrives again, you get a short all-clear; the dashboard always shows where it stands.",
    },
    back: (account) =>
      `Instagram passes button taps, DMs and read receipts on to OpenReply again (your account ${account}).`,
    lasted: ({ duration, from, to }) =>
      from.date === to.date
        ? `It lasted about ${duration}: on ${from.date} from ${from.time} to ${to.time} UTC.`
        : `It lasted about ${duration}: from ${from.date}, ${from.time} UTC to ${to.date}, ${to.time} UTC.`,
    lostTaps:
      "Whoever tapped the button in your first DM in that time got nothing: the tap did not reach OpenReply. In Instagram such a tap shows in the conversation as a message with the button's text.",
    allClearFooter:
      "This e-mail was sent automatically by your OpenReply installation. Diagnostics shows it as well.",
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const paragraph = (value: string, style = "") =>
  `<p style="margin:0 0 16px${style}">${escapeHtml(value)}</p>`;
const list = (items: string[], tag: "ul" | "ol") =>
  `<${tag} style="margin:0 0 16px;padding-left:20px">${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</${tag}>`;

function page(locale: AlertLocale, subject: string, body: string[], footer: string): string {
  return [
    "<!doctype html>",
    `<html lang="${locale}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:24px 16px;background:#ffffff;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5">',
    '<div style="max-width:560px;margin:0 auto">',
    ...body,
    `<p style="margin:24px 0 0;color:#71717a;font-size:13px">${escapeHtml(footer)}</p>`,
    "</div>",
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The alert (or its reminder): subject, plain text and simple HTML. */
export function buildMessagingSilenceAlertEmail(
  input: MessagingSilenceAlertInput
): EmailContent {
  const copy = COPY[input.locale];
  const { date, time } = formatAlertTime(input.since, input.locale);
  const since = copy.since({ date, time, account: `@${input.username}` });
  const steps = [copy.fixOpen(input.settingsUrl), ...copy.fixSteps];
  const reminder = input.kind === "reminder";
  const subject = copy.subject[input.kind];

  const text = [
    copy.greeting,
    "",
    copy.what,
    "",
    since,
    ...(reminder ? ["", copy.reminderLead] : []),
    "",
    copy.meaningTitle,
    ...copy.meaning.map((line) => `- ${line}`),
    "",
    copy.causesTitle,
    ...copy.causes.map((line) => `- ${line}`),
    "",
    copy.fixTitle,
    ...steps.map((line, index) => `${index + 1}. ${line}`),
    copy.fixElse,
    "",
    copy.ends,
    "",
    "--",
    copy.footer[input.kind],
    "",
  ].join("\n");

  const button = input.settingsUrl
    ? `<p style="margin:0 0 16px"><a href="${escapeHtml(input.settingsUrl)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#f97316;color:#ffffff;font-weight:600;text-decoration:none">${escapeHtml(copy.openSettings)}</a></p>`
    : "";
  const html = page(
    input.locale,
    subject,
    [
      paragraph(copy.greeting),
      `<p style="margin:0 0 16px;font-weight:600">${escapeHtml(copy.what)}</p>`,
      paragraph(since),
      reminder ? paragraph(copy.reminderLead) : "",
      paragraph(copy.meaningTitle, ";font-weight:600"),
      list(copy.meaning, "ul"),
      paragraph(copy.causesTitle, ";font-weight:600"),
      list(copy.causes, "ul"),
      paragraph(copy.fixTitle, ";font-weight:600"),
      list(steps, "ol"),
      paragraph(copy.fixElse),
      button,
      paragraph(copy.ends),
    ],
    copy.footer[input.kind]
  );

  return { subject, text, html };
}

/** The all-clear after a silence: subject, plain text and simple HTML. */
export function buildMessagingSilenceAllClearEmail(
  input: MessagingSilenceAllClearInput
): EmailContent {
  const copy = COPY[input.locale];
  const back = copy.back(`@${input.username}`);
  const lasted = copy.lasted({
    duration: formatDowntime(input.endedAt.getTime() - input.since.getTime(), input.locale),
    from: formatAlertTime(input.since, input.locale),
    to: formatAlertTime(input.endedAt, input.locale),
  });
  const subject = copy.allClearSubject;

  const text = [
    copy.greeting,
    "",
    back,
    lasted,
    "",
    copy.lostTaps,
    "",
    "--",
    copy.allClearFooter,
    "",
  ].join("\n");
  const html = page(
    input.locale,
    subject,
    [
      paragraph(copy.greeting),
      `<p style="margin:0 0 16px;font-weight:600">${escapeHtml(back)}</p>`,
      paragraph(lasted),
      paragraph(copy.lostTaps),
    ],
    copy.allClearFooter
  );
  return { subject, text, html };
}
