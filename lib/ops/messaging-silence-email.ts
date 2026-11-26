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
 * with the link to the settings page. The all-clear says how long it lasted
 * (and any earlier silence it reports as well) and what the search for lost
 * taps after it found (lib/instagram/lost-tap-search.ts): how many taps go on
 * now, who could not be helped any more (name, campaign, time, why), how many
 * people got the first DM without tapping, and whom it could not look at.
 * Nothing else: no tracking (no image, no tracked or tagged link), no token,
 * no id.
 *
 * Pure: no database, no clock, no environment.
 */

import type { ListedReason, LostTapResult } from "@/lib/instagram/lost-tap-state";
import { LOST_TAP_SPACING_MS } from "@/lib/instagram/lost-tap-state";
import { catchUpSpacingWords, formatDowntime } from "@/lib/ops/connection-all-clear-email";
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
  /** Earlier silences reported with it, oldest first (their search's result is in `taps`). */
  earlier?: readonly { since: Date; endedAt: Date }[];
  /** What the search for lost taps found; absent for a silence without one. */
  taps?: LostTapResult | null;
}

/** People the all-clear lists by name; the rest are counted (Diagnostics has them all). */
export const LOST_TAPS_MAX_LISTED = 50;

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
  lasted: (values: Lasted) => string;
  /** An earlier silence reported as well. */
  earlier: (values: Lasted) => string;
  /** "In that time", for one silence or several (`many`). */
  when: (many: boolean) => string;
  lostTaps: (when: string) => string;
  continued: (count: number, spacing: string, when: string) => string;
  noneLost: (complete: boolean, when: string) => string;
  listedIntro: (count: number, when: string) => string;
  listedItem: (values: {
    person: string;
    campaign: string;
    date: string;
    time: string;
    reason: ListedReason;
  }) => string;
  noName: string;
  listedMore: (count: number) => string;
  writeYourself: (count: number) => string;
  answered: (count: number) => string;
  noTap: (count: number, when: string) => string;
  notChecked: (count: number) => string;
  gaveUp: string;
  allClearFooter: string;
}

interface Lasted {
  duration: string;
  from: { date: string; time: string };
  to: { date: string; time: string };
}

/** Why a tap is listed, in the all-clear's words. */
const LISTED_REASON_WORDS: Record<AlertLocale, Record<ListedReason, string>> = {
  de: {
    window: "Instagram erlaubt eine Antwort nur bis 24 Stunden nach dem Tipp.",
    campaign: "Die Kampagne ist pausiert.",
    replied:
      "Danach kam von deinem Konto eine Nachricht, die nicht OpenReply geschickt hat. Damit nichts doppelt ankommt, macht OpenReply hier nicht weiter.",
    unclear:
      "Mehrere deiner Kampagnen haben einen Button mit diesem Text, und OpenReply kann nicht erkennen, ob der Tipp dieser Kampagne galt.",
  },
  en: {
    window: "Instagram allows an answer only within 24 hours of the tap.",
    campaign: "the campaign is paused.",
    replied:
      "after it, a message came from your account that OpenReply did not send. So that nothing arrives twice, OpenReply does not continue here.",
    unclear:
      "several of your campaigns have a button with this text, and OpenReply cannot tell whether the tap was meant for this campaign.",
  },
};

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
    earlier: ({ duration, from, to }) =>
      from.date === to.date
        ? `Schon davor kam einmal nichts an: am ${from.date} von ${from.time} bis ${to.time} Uhr, etwa ${duration}.`
        : `Schon davor kam einmal nichts an: vom ${from.date} um ${from.time} Uhr bis zum ${to.date} um ${to.time} Uhr, etwa ${duration}.`,
    when: (many) => (many ? "in diesen Zeiten" : "in dieser Zeit"),
    lostTaps: (when) =>
      `Wer ${when} in deiner ersten DM auf den Button getippt hat, hat nichts bekommen: Der Tipp kam nicht bei OpenReply an. In Instagram siehst du so einen Tipp in der Unterhaltung als Nachricht mit dem Text des Buttons.`,
    continued: (count, spacing, when) =>
      count === 1
        ? `1 Person hat ${when} auf den Button in deiner ersten DM getippt, ohne dass der Tipp ankam. OpenReply hat das in der Unterhaltung gefunden und macht bei ihr jetzt weiter, als wäre der Tipp gleich angekommen.`
        : `${count} Leute haben ${when} auf den Button in deiner ersten DM getippt, ohne dass der Tipp ankam. OpenReply hat das in den Unterhaltungen gefunden und macht bei ihnen jetzt nach und nach weiter, als wäre der Tipp gleich angekommen, etwa bei einer Person alle ${spacing}.`,
    noneLost: (complete, when) =>
      complete
        ? `OpenReply hat in den Unterhaltungen nachgesehen: ${capitalize(when)} ist kein Button-Tipp verloren gegangen.`
        : `In den Unterhaltungen, in die OpenReply schauen konnte, ist ${when} kein Button-Tipp verloren gegangen.`,
    // Stands on its own: no tap may have been continued before it.
    listedIntro: (count, when) =>
      count === 1
        ? `Bei 1 Person, die ${when} getippt hat, konnte OpenReply nicht mehr weitermachen:`
        : `Bei ${count} Leuten, die ${when} getippt haben, konnte OpenReply nicht mehr weitermachen:`,
    listedItem: ({ person, campaign, date, time, reason }) =>
      `${person}, Kampagne „${campaign}“, getippt am ${date} um ${time} Uhr: ${LISTED_REASON_WORDS.de[reason]}`,
    noName: "(ohne Namen)",
    listedMore: (count) =>
      count === 1
        ? "… und 1 weitere Person, die du in der Diagnose von OpenReply findest."
        : `… und ${count} weitere, die du in der Diagnose von OpenReply findest.`,
    writeYourself: (count) =>
      count === 1
        ? "Schau dir die Unterhaltung am besten selbst in Instagram an und schick der Person, worum sie gebeten hat, falls sie es noch nicht hat."
        : "Schau dir die Unterhaltungen am besten selbst in Instagram an und schick den Leuten, worum sie gebeten haben, falls sie es noch nicht haben.",
    answered: (count) =>
      count === 1
        ? "Bei 1 Person ging es nach der Störung von selbst weiter, zum Beispiel weil sie noch einmal getippt hat."
        : `Bei ${count} Leuten ging es nach der Störung von selbst weiter, zum Beispiel weil sie noch einmal getippt haben.`,
    noTap: (count, when) =>
      count === 1
        ? `1 Person hat ${when} deine erste DM bekommen, aber nicht auf den Button getippt.`
        : `${count} Leute haben ${when} deine erste DM bekommen, aber nicht auf den Button getippt.`,
    notChecked: (count) =>
      count === 1
        ? "Bei 1 Person konnte OpenReply nicht nachsehen. Schau dort selbst in Instagram in die Unterhaltung."
        : `Bei ${count} Leuten konnte OpenReply nicht nachsehen. Schau dort selbst in Instagram in die Unterhaltungen.`,
    gaveUp: "Die Suche hat zu lange gedauert: OpenReply hat sie nach 24 Stunden beendet.",
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
    earlier: ({ duration, from, to }) =>
      from.date === to.date
        ? `Before that, nothing arrived either on ${from.date} from ${from.time} to ${to.time} UTC, about ${duration}.`
        : `Before that, nothing arrived either from ${from.date}, ${from.time} UTC to ${to.date}, ${to.time} UTC, about ${duration}.`,
    when: (many) => (many ? "during those times" : "in that time"),
    lostTaps: (when) =>
      `Whoever tapped the button in your first DM ${when} got nothing: the tap did not reach OpenReply. In Instagram such a tap shows in the conversation as a message with the button's text.`,
    continued: (count, spacing, when) =>
      count === 1
        ? `1 person tapped the button in your first DM ${when}, and the tap got lost. OpenReply found it in the conversation and continues with them now as if the tap had arrived.`
        : `${count} people tapped the button in your first DM ${when}, and the taps got lost. OpenReply found them in the conversations and continues with them now as if the taps had arrived, one after the other, about one person every ${spacing}.`,
    noneLost: (complete, when) =>
      complete
        ? `OpenReply looked through the conversations: no button tap got lost ${when}.`
        : `In the conversations OpenReply could look at, no button tap got lost ${when}.`,
    // Stands on its own: no tap may have been continued before it.
    listedIntro: (count, when) =>
      count === 1
        ? `1 person tapped the button ${when}, but OpenReply could no longer continue with them:`
        : `${count} people tapped the button ${when}, but OpenReply could no longer continue with them:`,
    listedItem: ({ person, campaign, date, time, reason }) =>
      `${person}, campaign “${campaign}”, tapped on ${date}, ${time} UTC: ${LISTED_REASON_WORDS.en[reason]}`,
    noName: "(no name)",
    listedMore: (count) =>
      count === 1
        ? "… and 1 more person, whom you find in OpenReply's Diagnostics."
        : `… and ${count} more, whom you find in OpenReply's Diagnostics.`,
    writeYourself: (count) =>
      count === 1
        ? "Best look at the conversation yourself in Instagram and send the person what they asked for, if they do not have it yet."
        : "Best look at these conversations yourself in Instagram and send each person what they asked for, if they do not have it yet.",
    answered: (count) =>
      count === 1
        ? "For 1 person it went on by itself after the silence, for example because they tapped again."
        : `For ${count} people it went on by itself after the silence, for example because they tapped again.`,
    noTap: (count, when) =>
      count === 1
        ? `1 person got your first DM ${when} but did not tap the button.`
        : `${count} people got your first DM ${when} but did not tap the button.`,
    notChecked: (count) =>
      count === 1
        ? "OpenReply could not look at the conversation of 1 person. Check it yourself in Instagram."
        : `OpenReply could not look at the conversations of ${count} people. Check them yourself in Instagram.`,
    gaveUp: "The search took too long: OpenReply ended it after 24 hours.",
    allClearFooter:
      "This e-mail was sent automatically by your OpenReply installation. Diagnostics shows it as well.",
  },
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

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

// One line of user content (a name, a campaign), at most this long.
const NAME_MAX = 80;

function oneLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1).trimEnd()}…` : line;
}

/** One paragraph of the all-clear, or a list with its lines. */
type Block =
  | { kind: "p"; text: string }
  | { kind: "list"; intro: string; items: string[]; more: string | null };

/**
 * What the search for lost taps found: the taps that go on, the people it
 * could not help any more (too late, the campaign paused, written to by
 * hand, the tap unclear), with the advice to look after them, how many did
 * not tap, and whom it could not look at. `when` says "in that time", for
 * one silence or several.
 */
function tapsPart(copy: Copy, locale: AlertLocale, taps: LostTapResult, when: string): Block[] {
  const part: Block[] = [];
  const listed = taps.listed;
  if (taps.continued > 0) {
    part.push({
      kind: "p",
      text: copy.continued(taps.continued, catchUpSpacingWords(locale, LOST_TAP_SPACING_MS), when),
    });
  } else if (listed.length === 0 && taps.answered === 0) {
    part.push({ kind: "p", text: copy.noneLost(taps.complete, when) });
  }
  if (listed.length > 0) {
    const shown = listed.slice(0, LOST_TAPS_MAX_LISTED);
    part.push({
      kind: "list",
      intro: copy.listedIntro(listed.length, when),
      items: shown.map((entry) => {
        const { date, time } = formatAlertTime(new Date(entry.tappedAt), locale);
        return copy.listedItem({
          person: entry.username ? `@${oneLine(entry.username)}` : copy.noName,
          campaign: oneLine(entry.campaign),
          date,
          time,
          reason: entry.reason,
        });
      }),
      more: listed.length > shown.length ? copy.listedMore(listed.length - shown.length) : null,
    });
    part.push({ kind: "p", text: copy.writeYourself(listed.length) });
  }
  if (taps.answered > 0) part.push({ kind: "p", text: copy.answered(taps.answered) });
  if (taps.noTap > 0) part.push({ kind: "p", text: copy.noTap(taps.noTap, when) });
  if (taps.notChecked > 0) part.push({ kind: "p", text: copy.notChecked(taps.notChecked) });
  if (taps.gaveUp) part.push({ kind: "p", text: copy.gaveUp });
  return part;
}

/** The all-clear after a silence: subject, plain text and simple HTML. */
export function buildMessagingSilenceAllClearEmail(
  input: MessagingSilenceAllClearInput
): EmailContent {
  const copy = COPY[input.locale];
  const back = copy.back(`@${input.username}`);
  const span = (silence: { since: Date; endedAt: Date }): Lasted => ({
    duration: formatDowntime(silence.endedAt.getTime() - silence.since.getTime(), input.locale),
    from: formatAlertTime(silence.since, input.locale),
    to: formatAlertTime(silence.endedAt, input.locale),
  });
  const lasted = copy.lasted(span(input));
  // The silences before it that it reports as well: each with its own time,
  // never one span over the hours in between, when taps arrived.
  const earlier = (input.earlier ?? []).map((silence) => copy.earlier(span(silence)));
  const when = copy.when(earlier.length > 0);
  const subject = copy.allClearSubject;
  // Without a search (a silence from before it existed), what a tap in that
  // time meant.
  const part: Block[] = input.taps
    ? tapsPart(copy, input.locale, input.taps, when)
    : [{ kind: "p", text: copy.lostTaps(when) }];

  const text = [
    copy.greeting,
    "",
    back,
    lasted,
    ...earlier,
    ...part.flatMap((entry) =>
      entry.kind === "p"
        ? ["", entry.text]
        : ["", entry.intro, ...entry.items.map((item) => `- ${item}`), ...(entry.more ? [entry.more] : [])]
    ),
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
      ...earlier.map((line) => paragraph(line)),
      ...part.flatMap((entry) =>
        entry.kind === "p"
          ? [paragraph(entry.text)]
          : [
              paragraph(entry.intro, ";font-weight:600"),
              `<ul style="margin:0 0 16px;padding-left:20px">${entry.items
                .map((item) => `<li style="margin:0 0 8px;overflow-wrap:anywhere">${escapeHtml(item)}</li>`)
                .join("")}</ul>`,
              entry.more ? paragraph(entry.more) : "",
            ]
      ),
    ],
    copy.allClearFooter
  );
  return { subject, text, html };
}
