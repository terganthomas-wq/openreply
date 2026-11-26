"use client";

/**
 * The last messaging silence (A2) in Diagnostics, for 7 days after it ended:
 * from when to when nothing arrived and how long that was (and any earlier
 * silence reported with it), and what the search for lost taps after it
 * found (lib/instagram/lost-tap-search.ts): how many taps it continued, the
 * people it could not help any more (name, campaign, time, why), how many
 * got the first DM without tapping, and how many it could not look at. While
 * the search runs, it says so.
 */

import type { StaticMessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { formatIncidentTime } from "@/lib/instagram/connection-incident";
import type { ListedTap, LostTapResult } from "@/lib/instagram/lost-tap-state";
import type { MessagingSilenceReport } from "@/lib/instagram/messaging-silence-incident";

const HOUR = 60 * 60_000;

/** How long a silence lasted, in whole hours, at least one. */
function hoursBetween(since: string, endedAt: string): number {
  return Math.max(1, Math.round((Date.parse(endedAt) - Date.parse(since)) / HOUR));
}

/** Why a tap was not continued, in the reader's language. */
export const LISTED_REASON_TEXT = {
  window: "Instagram allows an answer only within 24 hours of the tap.",
  campaign: "The campaign is paused.",
  replied:
    "After the tap a message came from your account that OpenReply did not send. So that nothing arrives twice, OpenReply does not continue here.",
  unclear:
    "Several of your campaigns have a button with this text. OpenReply cannot tell whether the tap was meant for this campaign.",
} as const satisfies Record<ListedTap["reason"], StaticMessageKey>;

/** What to do about the people listed: one, or several. */
export const LOOK_YOURSELF_TEXT = {
  one: "Best look at this conversation yourself in Instagram and send the person what they asked for, if they do not have it yet.",
  many: "Best look at these conversations yourself in Instagram and send each person what they asked for, if they do not have it yet.",
} as const satisfies Record<"one" | "many", StaticMessageKey>;

function SearchResult({ taps }: { taps: LostTapResult }) {
  const { t, locale } = useI18n();
  return (
    <>
      {taps.continued > 0 ? (
        <p className="mt-2">
          {t("Lost taps found and continued: {count}", { count: taps.continued })}
        </p>
      ) : taps.listed.length === 0 && taps.answered === 0 && taps.complete ? (
        <p className="mt-2">{t("No button tap got lost in that time.")}</p>
      ) : null}
      {taps.listed.length > 0 && (
        <div className="mt-2">
          <p>{t("These taps could not be continued:")}</p>
          <ul className="mt-2 space-y-2">
            {taps.listed.map((entry) => (
              <li
                key={`${entry.username ?? ""}|${entry.campaign}|${entry.tappedAt}`}
                className="rounded border border-border bg-surface/50 p-3"
              >
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {entry.username ? `@${entry.username}` : "—"}
                  </span>
                  <time dateTime={entry.tappedAt} className="text-xs text-muted">
                    {t("Tapped: {time}", { time: formatIncidentTime(entry.tappedAt, locale) })}
                  </time>
                </div>
                {/* The campaign's name is user content: wrapped at any
                    character so a long word cannot widen the page. */}
                <p className="mt-1 break-words [overflow-wrap:anywhere]">
                  {t("Campaign “{campaign}”", { campaign: entry.campaign })}
                </p>
                <p className="mt-0.5 text-muted">{t(LISTED_REASON_TEXT[entry.reason])}</p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted">
            {t(taps.listed.length === 1 ? LOOK_YOURSELF_TEXT.one : LOOK_YOURSELF_TEXT.many)}
          </p>
        </div>
      )}
      {taps.answered > 0 && (
        <p className="mt-2 text-muted">
          {t("Went on by itself after the silence: {count}", { count: taps.answered })}
        </p>
      )}
      {taps.noTap > 0 && (
        <p className="mt-2 text-muted">
          {t("Got your first DM in that time without tapping: {count}", { count: taps.noTap })}
        </p>
      )}
      {taps.notChecked > 0 && (
        <p className="mt-1 text-warning">
          {t("Could not be checked: {count}. Look at their conversations in Instagram yourself.", {
            count: taps.notChecked,
          })}
        </p>
      )}
    </>
  );
}

export default function MessagingSilenceReports({
  reports,
}: {
  reports: readonly MessagingSilenceReport[];
}) {
  const { t, locale } = useI18n();
  if (reports.length === 0) return null;

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold text-foreground">
        {t("After the missing button taps")}
      </h2>
      <ul className="mt-3 space-y-5 text-sm text-foreground">
        {reports.map((report) => {
          const hours = hoursBetween(report.since, report.endedAt);
          return (
            <li key={report.accountId} className="min-w-0 break-words">
              <p className="font-semibold">
                {t("@{account}: button taps arrive again since {time}", {
                  account: report.username,
                  time: formatIncidentTime(report.endedAt, locale),
                })}
              </p>
              <p className="mt-0.5 text-muted">
                {t("No button taps, DMs or read receipts arrived from {from} to {to}.", {
                  from: formatIncidentTime(report.since, locale),
                  to: formatIncidentTime(report.endedAt, locale),
                })}{" "}
                {t("That was about {hours} hours.", { hours })}
              </p>
              {report.earlier.map((silence) => (
                <p key={silence.since} className="mt-0.5 text-muted">
                  {t("Before that, nothing arrived either from {from} to {to}: about {hours} hours.", {
                    from: formatIncidentTime(silence.since, locale),
                    to: formatIncidentTime(silence.endedAt, locale),
                    hours: hoursBetween(silence.since, silence.endedAt),
                  })}
                </p>
              ))}
              {report.searching ? (
                <p className="mt-2">
                  {t("@{account}: looking for button taps that got lost in that time …", {
                    account: report.username,
                  })}
                </p>
              ) : report.taps ? (
                <SearchResult taps={report.taps} />
              ) : (
                <p className="mt-2 text-muted">
                  {t(
                    "Whoever tapped the button in your first DM in that time got nothing: the tap did not reach OpenReply. In Instagram such a tap shows in the conversation as a message with the button's text."
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
