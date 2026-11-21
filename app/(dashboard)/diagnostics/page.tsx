"use client";

import type { I18n } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import type { EventDetail } from "@/lib/ops/event-details";
import { useEffect, useState } from "react";
import StatusBadge from "@/components/status-badge";

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
