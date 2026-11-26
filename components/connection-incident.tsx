"use client";

/**
 * A lost Instagram connection (A1) on the dashboard: the banner above every
 * page and the account's notice on the settings page, each with "Neu
 * verbinden" (the same Meta login as "Mit eigener Meta-App verbinden"). Only
 * owners and admins can reconnect; a member is asked to have one of them do
 * it, and gets no button that would only be refused.
 */

import { useSyncExternalStore } from "react";
import { useI18n } from "@/lib/i18n/provider";
import {
  CONNECTION_LOST_REASON_TEXT,
  formatIncidentTime,
  RECONNECT_URL,
  type ConnectionIncident,
} from "@/lib/instagram/connection-incident";

function subscribe() {
  return () => {};
}

/**
 * False while the server renders and during hydration, true afterwards. The
 * banner is rendered on the server too, which knows neither the reader's
 * time zone nor its clock: the time only shows once the browser renders, so
 * the two renders never disagree. The messaging silence's banner (A2,
 * components/messaging-silence.tsx) uses it too.
 */
export function useInBrowser(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}

export function ReconnectButton({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  return (
    <a
      href={RECONNECT_URL}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover ${className}`}
    >
      {t("Reconnect")}
    </a>
  );
}

/** Above every dashboard page while any account's connection is lost. */
export function ConnectionIncidentBanner({
  incidents,
  canManage,
}: {
  incidents: readonly ConnectionIncident[];
  /** Owner or admin: may reconnect. */
  canManage: boolean;
}) {
  const { t, locale } = useI18n();
  const inBrowser = useInBrowser();
  if (incidents.length === 0) return null;

  return (
    <div
      role="alert"
      className="border-b border-error/30 bg-error/10 px-4 py-3 lg:px-8"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-sm text-foreground">
          <p className="font-semibold text-error">
            {t("Instagram connection lost")}
          </p>
          <ul className="mt-1 space-y-1">
            {incidents.map((incident) => (
              <li key={incident.accountId} className="break-words">
                <span className="font-medium">
                  {inBrowser
                    ? t("@{account}: connection lost since {time}", {
                        account: incident.username,
                        time: formatIncidentTime(incident.since, locale),
                      })
                    : t("@{account}: connection lost", {
                        account: incident.username,
                      })}
                </span>{" "}
                <span className="text-muted">
                  {t(CONNECTION_LOST_REASON_TEXT[incident.reason])}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted">
            {t(
              "OpenReply is not sending DMs right now: no DMs for comments, no replies to button taps, no public replies."
            )}
          </p>
          {!canManage && (
            <p className="mt-1 text-muted">
              {t("Ask your workspace owner or an admin to reconnect Instagram.")}
            </p>
          )}
        </div>
        {canManage && <ReconnectButton className="self-start sm:self-center" />}
      </div>
    </div>
  );
}

/**
 * The account's state on the settings page while its connection is lost:
 * since when, why in plain words, what to do, and "Neu verbinden".
 */
export function ConnectionIncidentNotice({
  incident,
  canManage,
}: {
  incident: ConnectionIncident;
  canManage: boolean;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="mt-2 space-y-2 rounded border border-error/20 bg-error/10 p-3 text-sm">
      <p className="font-semibold text-error">
        {t("Connection lost since {time}", {
          time: formatIncidentTime(incident.since, locale),
        })}
      </p>
      <p className="text-foreground">{t(CONNECTION_LOST_REASON_TEXT[incident.reason])}</p>
      <p className="text-foreground">
        {t(
          "OpenReply is not sending DMs right now: no DMs for comments, no replies to button taps, no public replies."
        )}
      </p>
      {canManage ? (
        <>
          <p className="text-muted">
            {t(
              "To fix it: tap “Reconnect”, log in with Meta, choose your Instagram account and allow all permissions. OpenReply then catches up on the comments of the meantime."
            )}
          </p>
          <ReconnectButton />
        </>
      ) : (
        <p className="text-muted">
          {t("Ask your workspace owner or an admin to reconnect Instagram.")}
        </p>
      )}
    </div>
  );
}
