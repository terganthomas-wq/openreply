/**
 * Operational events that Diagnostics shows in the reader's language.
 *
 * Events are stored with an English message. The ones about Meta's request
 * limits and about a lost Instagram connection (A1) also carry what a
 * translation needs in their payload (`kind` and the values), so Diagnostics
 * can say "paused until 14:05" in the reader's language and time zone rather
 * than in the worker's UTC. Only these values leave the server, never the
 * rest of a payload.
 *
 * Client-safe: no database, queue or Redis import.
 */

/** An account pause started (lib/queue/account-pause.ts). */
export const META_PAUSE_EVENT = "meta-pause";
/** A response reported 80 % or more of a limit (lib/ops/meta-usage.ts). */
export const META_USAGE_EVENT = "meta-usage";
/** A request limit ended a comment sweep (lib/polling/comment-reconciler.ts). */
export const SWEEP_LIMIT_EVENT = "sweep-limit";
/** An account's connection is lost: an incident opened (lib/instagram/connection-check.ts). */
export const CONNECTION_LOST_EVENT = "connection-lost";
/** An incident ended: a check got through, or the account was reconnected. */
export const CONNECTION_BACK_EVENT = "connection-back";
/** The alert e-mail (or its reminder) about a lost connection went out (lib/ops/connection-alert.ts). */
export const CONNECTION_ALERT_EVENT = "connection-alert";
/** The worker has no e-mail settings, so no alert can go out (lib/ops/mail.ts). */
export const MAIL_UNCONFIGURED_EVENT = "mail-unconfigured";
/** The catch-up after an incident finished (lib/instagram/connection-catch-up.ts). */
export const CONNECTION_CATCH_UP_EVENT = "connection-catch-up";
/** The all-clear e-mail after an incident went out (lib/ops/connection-all-clear.ts). */
export const CONNECTION_ALL_CLEAR_EVENT = "connection-all-clear";

export type EventDetail =
  | { kind: typeof META_PAUSE_EVENT; resumeAt: string; account: string | null }
  | { kind: typeof META_USAGE_EVENT; percent: number; account: string | null }
  | { kind: typeof SWEEP_LIMIT_EVENT; account: string | null }
  | { kind: typeof CONNECTION_LOST_EVENT; lostAt: string; account: string | null }
  | { kind: typeof CONNECTION_BACK_EVENT; account: string | null }
  | {
      kind: typeof CONNECTION_ALERT_EVENT;
      account: string | null;
      recipients: number;
      reminder: boolean;
    }
  | { kind: typeof MAIL_UNCONFIGURED_EVENT }
  | {
      kind: typeof CONNECTION_CATCH_UP_EVENT;
      account: string | null;
      queued: number;
      answered: number;
    }
  | { kind: typeof CONNECTION_ALL_CLEAR_EVENT; account: string | null; recipients: number };

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** What Diagnostics needs to translate an event, or null to show its message. */
export function eventDetail(payload: unknown): EventDetail | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const p = payload as Record<string, unknown>;
  const account = text(p.account);
  switch (p.kind) {
    case META_PAUSE_EVENT: {
      const resumeAt = text(p.resumeAt);
      if (!resumeAt || Number.isNaN(Date.parse(resumeAt))) return null;
      return { kind: META_PAUSE_EVENT, resumeAt, account };
    }
    case META_USAGE_EVENT:
      return typeof p.highestPercent === "number" &&
        Number.isFinite(p.highestPercent)
        ? { kind: META_USAGE_EVENT, percent: Math.round(p.highestPercent), account }
        : null;
    case SWEEP_LIMIT_EVENT:
      return { kind: SWEEP_LIMIT_EVENT, account };
    case CONNECTION_LOST_EVENT: {
      const lostAt = text(p.lostAt);
      if (!lostAt || Number.isNaN(Date.parse(lostAt))) return null;
      return { kind: CONNECTION_LOST_EVENT, lostAt, account };
    }
    case CONNECTION_BACK_EVENT:
      return { kind: CONNECTION_BACK_EVENT, account };
    case CONNECTION_ALERT_EVENT:
      return typeof p.recipients === "number" &&
        Number.isInteger(p.recipients) &&
        p.recipients > 0
        ? {
            kind: CONNECTION_ALERT_EVENT,
            account,
            recipients: p.recipients,
            reminder: p.reminder === true,
          }
        : null;
    case MAIL_UNCONFIGURED_EVENT:
      return { kind: MAIL_UNCONFIGURED_EVENT };
    case CONNECTION_CATCH_UP_EVENT:
      return isCount(p.queued) && isCount(p.answered)
        ? { kind: CONNECTION_CATCH_UP_EVENT, account, queued: p.queued, answered: p.answered }
        : null;
    case CONNECTION_ALL_CLEAR_EVENT:
      return isCount(p.recipients) && p.recipients > 0
        ? { kind: CONNECTION_ALL_CLEAR_EVENT, account, recipients: p.recipients }
        : null;
    default:
      return null;
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
