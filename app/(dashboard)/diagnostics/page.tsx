"use client";

import type { I18n } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import type { EventDetail } from "@/lib/ops/event-details";
import { useEffect, useState } from "react";
import KeyExpiryNotice, {
  type KeyNeedingAttention,
} from "@/components/key-expiry-notice";
import StatusBadge from "@/components/status-badge";
import ConnectionCatchUpReport from "@/components/connection-catch-up";
import { ReconnectButton } from "@/components/connection-incident";
import { MESSAGING_SILENCE_TEXT } from "@/components/messaging-silence";
import MessagingSilenceReports from "@/components/messaging-silence-report";
import type { MessagingSilenceReport } from "@/lib/instagram/messaging-silence-incident";
import { catchUpEventText, type CatchUpReport } from "@/lib/instagram/catch-up-report";
import {
  CONNECTION_LOST_REASON_TEXT,
  formatIncidentTime,
  type ConnectionLostKind,
} from "@/lib/instagram/connection-incident";

interface DiagnosticsData {
  queueCounts: Record<string, number>;
  workerHealth: {
    healthy: boolean;
    ageMs: number | null;
    heartbeat: {
      checkedAt: string;
      hostname?: string;
      pid: number;
      startedAt?: string;
    } | null;
  };
  workerAlerts: Array<{
    level: string;
    message: string;
    jobId?: string;
    commentId?: string;
    createdAt: string;
  }>;
  webhookFailures: Array<{
    id: string;
    object: string | null;
    errorMessage: string | null;
    createdAt: string;
  }>;
  dmFailures: Array<{
    id: string;
    status: string;
    commentId: string;
    commentText: string;
    errorMessage: string | null;
    updatedAt: string;
    automation: { name: string };
  }>;
  tokenRefreshFailures: Array<{
    id: string;
    message: string;
    createdAt: string;
  }>;
  operationalEvents: Array<{
    id: string;
    source: string;
    level: string;
    message: string;
    createdAt: string;
    resolvedAt: string | null;
    detail: EventDetail | null;
  }>;
  accountPauses: Array<{
    username: string;
    resumeAt: string;
    waiting: number | null;
  }>;
  // A1: accounts whose connection Meta dropped, from the worker's check.
  connectionIncidents?: Array<{
    username: string;
    since: string;
    reason: ConnectionLostKind;
    code: string | null;
    alertSentAt: string | null;
  }>;
  // A1: the catch-up after an incident, while it runs and for 7 days after,
  // with the comments the owner had answered by hand.
  connectionCatchUps?: CatchUpReport[];
  // A2: accounts whose button taps, DMs and read receipts do not arrive.
  messagingSilences?: Array<{
    username: string;
    since: string;
    alertSentAt: string | null;
  }>;
  // A2: the last silence of an account, for 7 days after it ended.
  endedMessagingSilences?: MessagingSilenceReport[];
  // Owners and admins can reconnect an account.
  canReconnect?: boolean;
  // Service keys that expire within 14 days, or expired although something
  // used them in the last 30 days.
  keyWarnings: KeyNeedingAttention[];
  // Whether the reader may create and revoke keys (owners and admins).
  canManageKeys: boolean;
}

function formatDate(value: string, locale: string) {
  return new Date(value).toLocaleString(locale);
}

// A time in the reader's own time zone; the worker stores UTC.
function formatTime(value: string, locale: string) {
  return new Date(value).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// The events about Meta's request limits, in the reader's language; every
// other event shows the message it was stored with.
function eventMessage(
  event: DiagnosticsData["operationalEvents"][number],
  { t, locale }: Pick<I18n, "t" | "locale">
): string {
  const detail = event.detail;
  switch (detail?.kind) {
    case "meta-pause": {
      const time = formatTime(detail.resumeAt, locale);
      return detail.account
        ? t(
            "Instagram limit reached for @{account}: sending paused until {time}",
            { account: detail.account, time }
          )
        : t("Instagram limit reached: sending paused until {time}", { time });
    }
    case "meta-usage":
      return detail.account
        ? t(
            "Instagram requests for @{account} are at {percent}% of the limit. At 100% Instagram refuses messages.",
            { percent: detail.percent, account: detail.account }
          )
        : t(
            "Instagram requests are at {percent}% of the limit. At 100% Instagram refuses messages.",
            { percent: detail.percent }
          );
    case "sweep-limit":
      return detail.account
        ? t(
            "The regular search for missed comments stopped early: Instagram limit reached for @{account}. The next search runs as planned.",
            { account: detail.account }
          )
        : event.message;
    case "connection-lost":
      return detail.account
        ? t(
            "Instagram connection of @{account} lost since {time}. No DMs go out until it is reconnected.",
            { account: detail.account, time: formatIncidentTime(detail.lostAt, locale) }
          )
        : event.message;
    case "connection-back":
      return detail.account
        ? t("Instagram connection of @{account} is back.", { account: detail.account })
        : event.message;
    case "connection-alert":
      if (!detail.account) return event.message;
      return detail.reminder
        ? t("Reminder about the lost connection of @{account} sent. Recipients: {count}", {
            account: detail.account,
            count: detail.recipients,
          })
        : t("Alert e-mail about the lost connection of @{account} sent. Recipients: {count}", {
            account: detail.account,
            count: detail.recipients,
          });
    case "mail-unconfigured":
      return t(
        "Alert e-mails about a lost Instagram connection cannot go out: the sending service has no e-mail settings (RESEND_API_KEY and EMAIL_FROM)."
      );
    case "connection-catch-up":
      return detail.account
        ? catchUpEventText(
            { t },
            { account: detail.account, queued: detail.queued, answered: detail.answered }
          )
        : event.message;
    case "connection-all-clear":
      return detail.account
        ? t("All-clear e-mail for @{account} sent. Recipients: {count}", {
            account: detail.account,
            count: detail.recipients,
          })
        : event.message;
    case "messaging-silent":
      return detail.account
        ? t(
            "Instagram passes on no button taps, DMs or read receipts for @{account} since {time}.",
            { account: detail.account, time: formatIncidentTime(detail.since, locale) }
          )
        : event.message;
    case "messaging-back":
      return detail.account
        ? t("Button taps, DMs and read receipts for @{account} arrive again.", {
            account: detail.account,
          })
        : event.message;
    case "messaging-alert":
      if (!detail.account) return event.message;
      return detail.reminder
        ? t("Reminder about the missing button taps of @{account} sent. Recipients: {count}", {
            account: detail.account,
            count: detail.recipients,
          })
        : t("Alert e-mail about the missing button taps of @{account} sent. Recipients: {count}", {
            account: detail.account,
            count: detail.recipients,
          });
    case "messaging-all-clear":
      return detail.account
        ? t("All-clear e-mail about the button taps of @{account} sent. Recipients: {count}", {
            account: detail.account,
            count: detail.recipients,
          })
        : event.message;
    case "messaging-tap-search":
      return detail.account
        ? t(
            "Search for lost button taps of @{account} done: {continued} continued, {listed} could not be continued, {noTap} without a tap.",
            {
              account: detail.account,
              continued: detail.continued,
              listed: detail.listed,
              noTap: detail.noTap,
            }
          )
        : event.message;
    default:
      return event.message;
  }
}

function EmptyState({ label }: { label: string }) {
  return <p className="py-5 text-center text-sm text-muted">{label}</p>;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function DiagnosticsPage() {
  const { t, label, locale } = useI18n();
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(true);

  async function refreshDiagnostics() {
    setLoading(true);
    const response = await fetch("/api/admin/diagnostics");
    const payload = await response.json();
    if (payload.success) {
      setData(payload.data);
    }
    setLoading(false);
  }

  useEffect(() => {
    let active = true;

    async function loadInitialDiagnostics() {
      const response = await fetch("/api/admin/diagnostics");
      const payload = await response.json();
      if (active && payload.success) {
        setData(payload.data);
      }
      if (active) {
        setLoading(false);
      }
    }

    void loadInitialDiagnostics();

    return () => {
      active = false;
    };
  }, []);

  if (loading && !data) {
    return <div className="panel rounded p-8 h-64" />;
  }

  const workerAgeSeconds =
    data?.workerHealth.ageMs == null
      ? null
      : Math.round(data.workerHealth.ageMs / 1000);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t("Production Diagnostics")}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {t("Health, queues, webhook failures, billing events, and worker alerts.")}
          </p>
        </div>
        <button
          onClick={() => void refreshDiagnostics()}
          className="rounded border border-border bg-surface px-4 py-2 text-sm font-semibold text-foreground transition hover:border-border-hover"
        >
          {t("Refresh")}
        </button>
      </div>

      {data?.connectionIncidents?.length ? (
        <section className="rounded border border-error/30 bg-error/10 p-4 sm:p-6">
          <h2 className="text-base font-semibold text-foreground">
            {t("Instagram connection lost")}
          </h2>
          <p className="mt-2 text-sm text-foreground">
            {t(
              "OpenReply is not sending DMs right now: no DMs for comments, no replies to button taps, no public replies."
            )}
          </p>
          <ul className="mt-3 space-y-3 text-sm text-foreground">
            {data.connectionIncidents.map((incident) => (
              <li key={incident.username} className="break-words">
                <p className="font-semibold">
                  {t("@{account}: connection lost since {time}", {
                    account: incident.username,
                    time: formatIncidentTime(incident.since, locale),
                  })}
                </p>
                <p className="mt-0.5">
                  {t(CONNECTION_LOST_REASON_TEXT[incident.reason])}
                  {incident.code ? (
                    <span className="text-muted"> ({incident.code})</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-muted">
                  {incident.alertSentAt
                    ? t("Alert e-mail sent: {time}", {
                        time: formatIncidentTime(incident.alertSentAt, locale),
                      })
                    : t("No alert e-mail sent yet")}
                </p>
              </li>
            ))}
          </ul>
          {data.canReconnect ? (
            <ReconnectButton className="mt-4" />
          ) : (
            <p className="mt-3 text-sm text-muted">
              {t("Ask your workspace owner or an admin to reconnect Instagram.")}
            </p>
          )}
        </section>
      ) : null}

      {data?.connectionCatchUps?.length ? (
        <ConnectionCatchUpReport
          reports={data.connectionCatchUps}
          canManage={Boolean(data.canReconnect)}
        />
      ) : null}

      {data?.messagingSilences?.length ? (
        <section className="rounded border border-error/30 bg-error/10 p-4 sm:p-6">
          <h2 className="text-base font-semibold text-foreground">
            {t(MESSAGING_SILENCE_TEXT.title)}
          </h2>
          <p className="mt-2 text-sm text-foreground">{t(MESSAGING_SILENCE_TEXT.what)}</p>
          <ul className="mt-3 space-y-3 text-sm text-foreground">
            {data.messagingSilences.map((silence) => (
              <li key={silence.username} className="break-words">
                <p className="font-semibold">
                  {t("@{account}: no button taps, DMs or read receipts since {time}", {
                    account: silence.username,
                    time: formatIncidentTime(silence.since, locale),
                  })}
                </p>
                <p className="mt-0.5 text-muted">
                  {silence.alertSentAt
                    ? t("Alert e-mail sent: {time}", {
                        time: formatIncidentTime(silence.alertSentAt, locale),
                      })
                    : t("No alert e-mail sent yet")}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-foreground">{t(MESSAGING_SILENCE_TEXT.causes)}</p>
          {data.canReconnect ? (
            <ReconnectButton className="mt-4" />
          ) : (
            <p className="mt-3 text-sm text-muted">{t(MESSAGING_SILENCE_TEXT.askAdmin)}</p>
          )}
        </section>
      ) : null}

      {data?.endedMessagingSilences?.length ? (
        <MessagingSilenceReports reports={data.endedMessagingSilences} />
      ) : null}

      {data?.accountPauses.length ? (
        <section className="rounded border border-warning/30 bg-warning/10 p-4 sm:p-6">
          <h2 className="text-base font-semibold text-foreground">
            {t("Sending paused: Instagram limit reached")}
          </h2>
          <p className="mt-2 text-sm text-foreground">
            {t(
              "Instagram refuses messages for a while when too many requests reach it in a short time. What waits goes out on its own once the pause is over."
            )}
          </p>
          <ul className="mt-3 space-y-1 text-sm text-foreground">
            {data.accountPauses.map((pause) => (
              <li key={pause.username} className="break-words">
                <span className="font-semibold">
                  {t("@{account}: paused until {time}", {
                    account: pause.username,
                    time: formatTime(pause.resumeAt, locale),
                  })}
                </span>
                {pause.waiting ? (
                  <span className="text-muted">
                    {" · "}
                    {t("Waiting: {count}", { count: pause.waiting })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data?.keyWarnings?.length ? (
        <KeyExpiryNotice
          keys={data.keyWarnings}
          linkToKeys
          canManageKeys={data.canManageKeys}
        />
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">
        <div className="panel rounded p-4 sm:p-5">
          <p className="text-xs font-semibold uppercase text-muted">
            {t("Worker health")}
          </p>
          <p
            className={`mt-3 text-2xl font-bold ${
              data?.workerHealth.healthy ? "text-success" : "text-warning"
            }`}
          >
            {data?.workerHealth.healthy ? t("Healthy") : t("Needs attention")}
          </p>
          <p className="mt-2 text-xs text-muted">
            {workerAgeSeconds == null
              ? t("No heartbeat found")
              : t("Last heartbeat {seconds}s ago", { seconds: workerAgeSeconds })}
          </p>
        </div>
        {["waiting", "active", "delayed", "failed"].map((key) => (
          <div key={key} className="panel rounded p-4 sm:p-5">
            <p className="text-xs font-semibold uppercase text-muted">
              {t("Queue")} {label(key)}
            </p>
            <p className="mt-3 text-2xl font-bold text-foreground">
              {data?.queueCounts[key] ?? 0}
            </p>
          </div>
        ))}
      </div>

      <Section title={t("Recent Worker Alerts")}>
        {data?.workerAlerts.length ? (
          <div className="space-y-3">
            {data.workerAlerts.map((alert) => (
              <div
                key={`${alert.createdAt}-${alert.jobId ?? alert.message}`}
                className="rounded border border-border bg-surface/50 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 flex-1 break-words text-sm font-semibold text-foreground">
                    {alert.message}
                  </p>
                  <span className="shrink-0 rounded-full bg-error/10 px-2 py-1 text-xs font-semibold text-error">
                    {alert.level}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted">
                  {formatDate(alert.createdAt, locale)}
                  {alert.commentId ? ` · ${alert.commentId}` : ""}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState label={t("No worker alerts recorded.")} />
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t("Campaign DM Failures And Skips")}>
          {data?.dmFailures.length ? (
            <div className="space-y-3">
              {data.dmFailures.map((item) => (
                <div key={item.id} className="border-b border-border pb-3 last:border-0">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                      {item.automation.name}
                    </p>
                    <StatusBadge status={item.status} />
                  </div>
                  <p className="mt-1 truncate text-xs text-muted">
                    {item.commentText}
                  </p>
                  {item.errorMessage && (
                    <p className="mt-1 text-xs text-error">{item.errorMessage}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label={t("No DM failures or skips.")} />
          )}
        </Section>

        <Section title={t("Webhook Failures")}>
          {data?.webhookFailures.length ? (
            <div className="space-y-3">
              {data.webhookFailures.map((event) => (
                <div key={event.id} className="border-b border-border pb-3 last:border-0">
                  <p className="text-sm font-semibold text-foreground">
                    {event.object ?? t("Instagram webhook")}
                  </p>
                  <p className="mt-1 text-xs text-error">
                    {event.errorMessage ?? t("Unknown error")}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {formatDate(event.createdAt, locale)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label={t("No failed webhook events.")} />
          )}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t("Token Refresh Failures")}>
          {data?.tokenRefreshFailures.length ? (
            <div className="space-y-3">
              {data.tokenRefreshFailures.map((event) => (
                <div key={event.id} className="border-b border-border pb-3 last:border-0">
                  <p className="text-sm font-semibold text-foreground">
                    {event.message}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {formatDate(event.createdAt, locale)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label={t("No token refresh failures.")} />
          )}
        </Section>

      </div>

      <Section title={t("Operational Event Timeline")}>
        {data?.operationalEvents.length ? (
          <div className="space-y-3">
            {data.operationalEvents.map((event) => (
              <div key={event.id} className="grid gap-2 border-b border-border pb-3 last:border-0 sm:grid-cols-[140px_1fr_auto]">
                <p className="text-xs font-semibold text-muted">{event.source}</p>
                <p className="min-w-0 break-words text-sm text-foreground">
                  {eventMessage(event, { t, locale })}
                </p>
                <p className="text-xs text-muted">{formatDate(event.createdAt, locale)}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState label={t("No operational events recorded.")} />
        )}
      </Section>
    </div>
  );
}
