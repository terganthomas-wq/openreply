"use client";

/**
 * A messaging silence (A2) on the dashboard: the banner above every page and
 * the account's notice on the settings page, each with "Neu verbinden", like
 * a lost connection (A1, components/connection-incident.tsx). Only owners and
 * admins can reconnect; a member is asked to have one of them do it, and gets
 * no button that would only be refused.
 */

import { ReconnectButton, useInBrowser } from "@/components/connection-incident";
import type { StaticMessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { formatIncidentTime } from "@/lib/instagram/connection-incident";
import type { MessagingSilenceIncident } from "@/lib/instagram/messaging-silence-incident";

/** What every place that shows a silence says, in the reader's language. */
export const MESSAGING_SILENCE_TEXT = {
  title: "Instagram is not passing on button taps",
  what: "Instagram is not passing button taps, DMs and read receipts on to OpenReply right now. Comments arrive, but nothing happens after the first DM.",
  causes:
    "Usually one of these is behind it: Instagram was linked to or unlinked from a Facebook Page (then select that Page too when you reconnect), “Allow access to messages” is switched off in Instagram, or another app is set as the default for Instagram under “Conversation routing” in the Business Suite.",
  fix: "To fix it: tap “Reconnect”, log in with Meta, choose your Instagram account and, if it is linked to a Facebook Page, that Page too, and allow all permissions. The notice goes away by itself as soon as a button tap, a DM or a read receipt arrives again.",
  askAdmin: "Ask your workspace owner or an admin to reconnect Instagram.",
} as const satisfies Record<string, StaticMessageKey>;

/** Above every dashboard page while any account's messaging events are missing. */
export function MessagingSilenceBanner({
  silences,
  canManage,
}: {
  silences: readonly MessagingSilenceIncident[];
  /** Owner or admin: may reconnect. */
  canManage: boolean;
}) {
  const { t, locale } = useI18n();
  const inBrowser = useInBrowser();
  if (silences.length === 0) return null;

  return (
    <div role="alert" className="border-b border-error/30 bg-error/10 px-4 py-3 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-sm text-foreground">
          <p className="font-semibold text-error">{t(MESSAGING_SILENCE_TEXT.title)}</p>
          <ul className="mt-1 space-y-1">
            {silences.map((silence) => (
              <li key={silence.accountId} className="break-words font-medium">
                {inBrowser
                  ? t("@{account}: no button taps, DMs or read receipts since {time}", {
                      account: silence.username,
                      time: formatIncidentTime(silence.since, locale),
                    })
                  : t("@{account}: no button taps, DMs or read receipts", {
                      account: silence.username,
                    })}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted">{t(MESSAGING_SILENCE_TEXT.what)}</p>
          <p className="mt-1 text-muted">{t(MESSAGING_SILENCE_TEXT.causes)}</p>
          {!canManage && (
            <p className="mt-1 text-muted">{t(MESSAGING_SILENCE_TEXT.askAdmin)}</p>
          )}
        </div>
        {canManage && <ReconnectButton className="self-start sm:self-center" />}
      </div>
    </div>
  );
}

/**
 * The account's state on the settings page while its messaging events are
 * missing: since when, what it means, the likely causes, what to do, and
 * "Neu verbinden".
 */
export function MessagingSilenceNotice({
  silence,
  canManage,
}: {
  silence: MessagingSilenceIncident;
  canManage: boolean;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="mt-2 space-y-2 rounded border border-error/20 bg-error/10 p-3 text-sm">
      <p className="font-semibold text-error">
        {t("No button taps, DMs or read receipts since {time}", {
          time: formatIncidentTime(silence.since, locale),
        })}
      </p>
      <p className="text-foreground">{t(MESSAGING_SILENCE_TEXT.what)}</p>
      <p className="text-foreground">{t(MESSAGING_SILENCE_TEXT.causes)}</p>
      {canManage ? (
        <>
          <p className="text-muted">{t(MESSAGING_SILENCE_TEXT.fix)}</p>
          <ReconnectButton />
        </>
      ) : (
        <p className="text-muted">{t(MESSAGING_SILENCE_TEXT.askAdmin)}</p>
      )}
    </div>
  );
}
