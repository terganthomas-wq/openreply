/**
 * The words of the all-clear e-mail after a lost Instagram connection (A1,
 * lib/ops/connection-all-clear.ts): German with "du" when the installation's
 * DEFAULT_LOCALE is de, English otherwise, like the alert
 * (lib/ops/connection-alert-email.ts). Plain text plus simple HTML of the
 * same content.
 *
 * What it says: that the connection is back, how long it was lost (Berlin
 * time in German, UTC in English), how many comments of the meantime get
 * their DM now, the comments the owner answered by hand (author, text, time,
 * link to the post), which get none automatically, with a link to the
 * Kommentare page where "DM senden" sends it, and what the catch-up could not
 * look at. No tracking (no image, no tracked or tagged link), no token, no id.
 *
 * Pure: no database, no clock, no environment.
 */

import type { CatchUpSkipped, OwnerAnsweredComment } from "@/lib/instagram/catch-up-state";
import {
  CATCH_UP_MAX_POSTS,
  CATCH_UP_SPACING_MS,
  skippedPosts,
} from "@/lib/instagram/catch-up-state";
import {
  formatAlertTime,
  type AlertLocale,
  type EmailContent,
} from "@/lib/ops/connection-alert-email";

/** Comments the e-mail lists by name; the rest are counted (Diagnostics has more). */
export const ALL_CLEAR_MAX_LISTED = 50;
// A comment's text in the e-mail, at most.
const TEXT_MAX = 200;

export interface AllClearEmailInput {
  locale: AlertLocale;
  /** The Instagram handle, without "@". */
  username: string;
  /** Since when the connection was lost, and when it was back. */
  lostAt: Date;
  recoveredAt: Date;
  /** Comments whose DM the catch-up queued. */
  queued: number;
  /** The comments the owner answered by hand, and how many in all. */
  ownerAnswered: readonly OwnerAnsweredComment[];
  ownerAnsweredTotal: number;
  skipped: CatchUpSkipped;
  /** `{NEXTAUTH_URL}/comments`; null when the worker does not know the app's address. */
  commentsUrl: string | null;
}

interface Copy {
  subject: string;
  greeting: string;
  lead: (account: string) => string;
  downtime: (values: {
    duration: string;
    from: { date: string; time: string };
    to: { date: string; time: string };
  }) => string;
  queued: (count: number) => string;
  answeredIntro: (count: number) => string;
  noName: string;
  answeredItem: (values: { author: string; date: string; time: string; text: string }) => string;
  post: string;
  more: (count: number) => string;
  sendByHand: (url: string | null) => string;
  openComments: string;
  olderPosts: string;
  postsSkipped: (count: number) => string;
  gaveUp: string;
  tooOld: (count: number) => string;
  notQueued: (count: number) => string;
  checkByHand: (url: string | null) => string;
  footer: string;
  duration: {
    minutes: (count: number) => string;
    hours: (count: number) => string;
    days: (count: number) => string;
    and: string;
  };
}

const COPY: Record<AlertLocale, Copy> = {
  de: {
    subject: "Instagram-Verbindung wieder da: OpenReply sendet wieder DMs",
    greeting: "Hallo,",
    lead: (account) => `die Verbindung zu deinem Instagram-Konto ${account} ist wieder da.`,
    downtime: ({ duration, from, to }) =>
      from.date === to.date
        ? `Die Unterbrechung dauerte etwa ${duration}: am ${from.date} von ${from.time} bis ${to.time} Uhr.`
        : `Die Unterbrechung dauerte etwa ${duration}: vom ${from.date} um ${from.time} Uhr bis zum ${to.date} um ${to.time} Uhr.`,
    queued: (count) =>
      count === 0
        ? "OpenReply hat die Kommentare aus dieser Zeit durchgesehen: Für keinen davon musste eine DM nachgeholt werden."
        : count === 1
          ? "OpenReply hat die Kommentare aus dieser Zeit durchgesehen: 1 Kommentar mit deinen Keywords bekommt seine DM jetzt."
          : `OpenReply hat die Kommentare aus dieser Zeit durchgesehen: ${count} Kommentare mit deinen Keywords bekommen ihre DM jetzt nach und nach, etwa eine alle ${CATCH_UP_SPACING_MS / 1000} Sekunden.`,
    answeredIntro: (count) =>
      count === 1
        ? "Auf einen Kommentar hast du in der Zwischenzeit selbst geantwortet. OpenReply schickt ihm keine automatische DM, falls du den Guide schon von Hand geschickt hast:"
        : `Auf diese ${count} Kommentare hast du in der Zwischenzeit selbst geantwortet. OpenReply schickt ihnen keine automatische DM, falls du den Guide schon von Hand geschickt hast:`,
    noName: "(ohne Namen)",
    answeredItem: ({ author, date, time, text }) =>
      `${author} am ${date} um ${time} Uhr: „${text}“`,
    post: "Beitrag ansehen",
    more: (count) =>
      count === 1
        ? "… und 1 weiterer, den du in der Diagnose von OpenReply findest."
        : `… und ${count} weitere, die du in der Diagnose von OpenReply findest.`,
    sendByHand: (url) =>
      url
        ? `Soll jemand davon die DM doch noch bekommen? Dann schick sie auf der Seite „Kommentare“ mit „DM senden“: ${url}`
        : "Soll jemand davon die DM doch noch bekommen? Dann schick sie in OpenReply auf der Seite „Kommentare“ mit „DM senden“.",
    openComments: "Kommentare öffnen",
    olderPosts: `Beiträge, die älter sind als deine neuesten ${CATCH_UP_MAX_POSTS}, hat OpenReply nicht durchgesehen.`,
    postsSkipped: (count) =>
      count === 1
        ? "Bei 1 Beitrag konnte OpenReply die Kommentare nicht vollständig lesen."
        : `Bei ${count} Beiträgen konnte OpenReply die Kommentare nicht vollständig lesen.`,
    gaveUp: "Das Nachholen hat zu lange gedauert: OpenReply hat es nach 24 Stunden beendet, ohne alles durchzusehen.",
    tooOld: (count) =>
      count === 1
        ? "1 Kommentar war älter als 7 Tage. Darauf erlaubt Instagram keine DM mehr."
        : `${count} Kommentare waren älter als 7 Tage. Darauf erlaubt Instagram keine DM mehr.`,
    notQueued: (count) =>
      count === 1
        ? "1 weiteren Kommentar hat OpenReply nicht mehr eingeplant, weil es schon zu viele waren."
        : `${count} weitere Kommentare hat OpenReply nicht mehr eingeplant, weil es schon zu viele waren.`,
    checkByHand: (url) =>
      url
        ? `Schau auf der Seite „Kommentare“ nach, ob noch jemand auf eine DM wartet: ${url}`
        : "Schau in OpenReply auf der Seite „Kommentare“ nach, ob noch jemand auf eine DM wartet.",
    footer:
      "Diese E-Mail hat deine OpenReply-Installation automatisch geschickt. Was nachgeholt wurde, siehst du auch in der Diagnose.",
    duration: {
      minutes: (count) => `${count} ${count === 1 ? "Minute" : "Minuten"}`,
      hours: (count) => `${count} ${count === 1 ? "Stunde" : "Stunden"}`,
      days: (count) => `${count} ${count === 1 ? "Tag" : "Tage"}`,
      and: "und",
    },
  },
  en: {
    subject: "Instagram connection is back: OpenReply is sending DMs again",
    greeting: "Hello,",
    lead: (account) => `The connection to your Instagram account ${account} is back.`,
    downtime: ({ duration, from, to }) =>
      from.date === to.date
        ? `It was lost for about ${duration}: on ${from.date} from ${from.time} to ${to.time} UTC.`
        : `It was lost for about ${duration}: from ${from.date}, ${from.time} UTC to ${to.date}, ${to.time} UTC.`,
    queued: (count) =>
      count === 0
        ? "OpenReply went through the comments of that time: none of them needed a DM caught up."
        : count === 1
          ? "OpenReply went through the comments of that time: 1 comment with your keywords gets its DM now."
          : `OpenReply went through the comments of that time: ${count} comments with your keywords get their DM now, one after the other, about one every ${CATCH_UP_SPACING_MS / 1000} seconds.`,
    answeredIntro: (count) =>
      count === 1
        ? "You answered one comment yourself in the meantime. OpenReply sends it no automatic DM, in case you already sent the guide by hand:"
        : `You answered these ${count} comments yourself in the meantime. OpenReply sends them no automatic DM, in case you already sent the guide by hand:`,
    noName: "(no name)",
    answeredItem: ({ author, date, time, text }) =>
      `${author} on ${date}, ${time} UTC: “${text}”`,
    post: "View post",
    more: (count) =>
      count === 1
        ? "… and 1 more, which you find in OpenReply's Diagnostics."
        : `… and ${count} more, which you find in OpenReply's Diagnostics.`,
    sendByHand: (url) =>
      url
        ? `Should one of them get the DM after all? Send it on the Comments page with “Send DM”: ${url}`
        : "Should one of them get the DM after all? Send it on the Comments page in OpenReply with “Send DM”.",
    openComments: "Open comments",
    olderPosts: `OpenReply did not go through posts older than your newest ${CATCH_UP_MAX_POSTS}.`,
    postsSkipped: (count) =>
      count === 1
        ? "OpenReply could not read all comments of 1 post."
        : `OpenReply could not read all comments of ${count} posts.`,
    gaveUp: "The catch-up took too long: OpenReply ended it after 24 hours without going through everything.",
    tooOld: (count) =>
      count === 1
        ? "1 comment was older than 7 days. Instagram allows no DM for it any more."
        : `${count} comments were older than 7 days. Instagram allows no DM for them any more.`,
    notQueued: (count) =>
      count === 1
        ? "OpenReply did not plan 1 more comment, as there were too many already."
        : `OpenReply did not plan ${count} more comments, as there were too many already.`,
    checkByHand: (url) =>
      url
        ? `Check the Comments page for anyone still waiting for a DM: ${url}`
        : "Check the Comments page in OpenReply for anyone still waiting for a DM.",
    footer:
      "This e-mail was sent automatically by your OpenReply installation. Diagnostics also shows what was caught up.",
    duration: {
      minutes: (count) => `${count} ${count === 1 ? "minute" : "minutes"}`,
      hours: (count) => `${count} ${count === 1 ? "hour" : "hours"}`,
      days: (count) => `${count} ${count === 1 ? "day" : "days"}`,
      and: "and",
    },
  },
};

/**
 * How long the connection was lost, in words: minutes below an hour, then
 * hours and minutes to the nearest five, from two days on days and hours.
 */
export function formatDowntime(ms: number, locale: AlertLocale): string {
  const words = COPY[locale].duration;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return words.minutes(minutes);
  const rounded = Math.round(minutes / 5) * 5;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  if (hours < 48) {
    return rest === 0
      ? words.hours(hours)
      : `${words.hours(hours)} ${words.and} ${words.minutes(rest)}`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0
    ? words.days(days)
    : `${words.days(days)} ${words.and} ${words.hours(restHours)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// One line, at most TEXT_MAX characters.
function shortText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX - 1).trimEnd()}…` : line;
}

/** The all-clear e-mail: subject, plain text and simple HTML. */
export function buildAllClearEmail(input: AllClearEmailInput): EmailContent {
  const copy = COPY[input.locale];
  const account = `@${input.username}`;
  const lead = copy.lead(account);
  const downtime = copy.downtime({
    duration: formatDowntime(
      input.recoveredAt.getTime() - input.lostAt.getTime(),
      input.locale
    ),
    from: formatAlertTime(input.lostAt, input.locale),
    to: formatAlertTime(input.recoveredAt, input.locale),
  });
  const queued = copy.queued(input.queued);

  const listed = input.ownerAnswered.slice(0, ALL_CLEAR_MAX_LISTED);
  const total = Math.max(input.ownerAnsweredTotal, input.ownerAnswered.length);
  const items = listed.map((comment) => {
    const { date, time } = formatAlertTime(new Date(comment.timestamp), input.locale);
    return {
      line: copy.answeredItem({
        author: comment.username ? `@${comment.username}` : copy.noName,
        date,
        time,
        text: shortText(comment.text),
      }),
      permalink: comment.permalink,
    };
  });
  const more = total - listed.length;

  const skipped = input.skipped;
  const notes = [
    ...(skipped.olderPosts ? [copy.olderPosts] : []),
    ...(skippedPosts(skipped) > 0 ? [copy.postsSkipped(skippedPosts(skipped))] : []),
    ...(skipped.gaveUp ? [copy.gaveUp] : []),
    ...(skipped.notQueued > 0 ? [copy.notQueued(skipped.notQueued)] : []),
    ...(skipped.tooOld > 0 ? [copy.tooOld(skipped.tooOld)] : []),
  ];
  // Only what may have left someone without a DM asks for a look.
  const incomplete =
    skipped.olderPosts ||
    skippedPosts(skipped) > 0 ||
    skipped.gaveUp ||
    skipped.notQueued > 0;

  const text = [
    copy.greeting,
    "",
    lead,
    downtime,
    "",
    queued,
    ...(total > 0
      ? [
          "",
          copy.answeredIntro(total),
          ...items.map(
            (item) =>
              `- ${item.line}${item.permalink ? ` (${copy.post}: ${item.permalink})` : ""}`
          ),
          ...(more > 0 ? [copy.more(more)] : []),
          "",
          copy.sendByHand(input.commentsUrl),
        ]
      : []),
    ...(notes.length > 0
      ? ["", ...notes, ...(incomplete ? [copy.checkByHand(input.commentsUrl)] : [])]
      : []),
    "",
    "--",
    copy.footer,
    "",
  ].join("\n");

  const paragraph = (value: string, style = "") =>
    `<p style="margin:0 0 16px${style}">${escapeHtml(value)}</p>`;
  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" style="color:#c2410c">${escapeHtml(label)}</a>`;
  const button = input.commentsUrl
    ? `<p style="margin:0 0 16px"><a href="${escapeHtml(input.commentsUrl)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#f97316;color:#ffffff;font-weight:600;text-decoration:none">${escapeHtml(copy.openComments)}</a></p>`
    : "";

  const html = [
    "<!doctype html>",
    `<html lang="${input.locale}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(copy.subject)}</title></head>`,
    '<body style="margin:0;padding:24px 16px;background:#ffffff;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5">',
    '<div style="max-width:560px;margin:0 auto">',
    paragraph(copy.greeting),
    `<p style="margin:0 0 16px;font-weight:600">${escapeHtml(lead)}</p>`,
    paragraph(downtime),
    paragraph(queued),
    ...(total > 0
      ? [
          paragraph(copy.answeredIntro(total), ";font-weight:600"),
          `<ul style="margin:0 0 16px;padding-left:20px">${items
            .map(
              (item) =>
                `<li style="margin:0 0 8px;overflow-wrap:anywhere">${escapeHtml(item.line)}${
                  item.permalink ? ` ${link(item.permalink, copy.post)}` : ""
                }</li>`
            )
            .join("")}</ul>`,
          more > 0 ? paragraph(copy.more(more)) : "",
          paragraph(copy.sendByHand(null)),
          button,
        ]
      : []),
    ...(notes.length > 0
      ? [
          ...notes.map((note) => paragraph(note)),
          ...(incomplete ? [paragraph(copy.checkByHand(null)), total > 0 ? "" : button] : []),
        ]
      : []),
    `<p style="margin:24px 0 0;color:#71717a;font-size:13px">${escapeHtml(copy.footer)}</p>`,
    "</div>",
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject: copy.subject, text, html };
}
