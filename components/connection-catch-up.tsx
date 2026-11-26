"use client";

/**
 * The catch-up after a lost Instagram connection (A1) in Diagnostics: while
 * it runs, and for 7 days after it finished, since when and until when the
 * connection was lost, how many comments of that time get their DM now, and
 * the comments the owner had answered by hand, which got none automatically,
 * with the author, the text, the time and a link to the post. Owners and
 * admins get the way to the Kommentare page, where "DM senden" sends it.
 */

import Link from "next/link";
import { useI18n } from "@/lib/i18n/provider";
import type { CatchUpReport } from "@/lib/instagram/catch-up-report";
import { formatIncidentTime } from "@/lib/instagram/connection-incident";

export default function ConnectionCatchUpReport({
  reports,
  canManage,
}: {
  reports: readonly CatchUpReport[];
  /** Owner or admin: may open the Kommentare page and send a DM by hand. */
  canManage: boolean;
}) {
  const { t, locale } = useI18n();
  if (reports.length === 0) return null;

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold text-foreground">
        {t("After the lost connection")}
      </h2>
      <ul className="mt-3 space-y-5 text-sm text-foreground">
        {reports.map((report) => {
          const last = report.last;
          const more = last ? last.ownerAnsweredTotal - last.ownerAnswered.length : 0;
          return (
            <li key={report.accountId} className="min-w-0 break-words">
              {report.running && (
                <p className="font-semibold">
                  {t("@{account}: catching up on the comments of the lost connection …", {
                    account: report.username,
                  })}
                </p>
              )}
              {last && (
                <>
                  <p className={report.running ? "mt-2 text-muted" : "font-semibold"}>
                    {t("@{account}: connection back since {time}", {
                      account: report.username,
                      time: formatIncidentTime(last.recoveredAt, locale),
                    })}
                  </p>
                  <p className="mt-0.5 text-muted">
                    {t("Lost from {from} to {to}.", {
                      from: formatIncidentTime(last.lostAt, locale),
                      to: formatIncidentTime(last.recoveredAt, locale),
                    })}{" "}
                    {t("Comments that get their DM now: {count}", { count: last.queued })}
                  </p>
                  {!last.complete && (
                    <p className="mt-1 text-warning">
                      {t(
                        "Not every post could be checked. Look on the Comments page whether anyone is still waiting for a DM."
                      )}
                    </p>
                  )}
                  {last.ownerAnsweredTotal > 0 ? (
                    <div className="mt-2">
                      <p>
                        {t(
                          "You answered these comments yourself in the meantime, so OpenReply sent them no automatic DM:"
                        )}
                      </p>
                      <ul className="mt-2 space-y-2">
                        {last.ownerAnswered.map((comment) => (
                          <li
                            key={comment.commentId}
                            className="rounded border border-border bg-surface/50 p-3"
                          >
                            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                              <span className="min-w-0 truncate font-medium text-foreground">
                                {comment.username ? `@${comment.username}` : "—"}
                              </span>
                              <time dateTime={comment.timestamp} className="text-xs text-muted">
                                {formatIncidentTime(comment.timestamp, locale)}
                              </time>
                              {comment.permalink && (
                                <a
                                  href={comment.permalink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-muted underline hover:text-foreground"
                                >
                                  {t("View post")}
                                </a>
                              )}
                            </div>
                            {/* User content: never translated, wrapped at any
                                character so a long word cannot widen the page. */}
                            <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                              {comment.text || t("(no text)")}
                            </p>
                          </li>
                        ))}
                      </ul>
                      {more > 0 && (
                        <p className="mt-1 text-muted">{t("and {count} more", { count: more })}</p>
                      )}
                      {canManage && (
                        <p className="mt-2 text-muted">
                          {t(
                            "If one of them should still get the DM, send it on the Comments page with “Send DM”."
                          )}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="mt-1 text-muted">
                      {t("None of the comments of that time had an answer from you.")}
                    </p>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {canManage && (
        <Link
          href="/comments"
          className="mt-4 inline-block text-sm font-medium text-accent hover:underline"
        >
          {t("Open comments")}
        </Link>
      )}
    </section>
  );
}
