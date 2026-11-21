/**
 * Operational events that Diagnostics shows in the reader's language.
 *
 * Events are stored with an English message. The ones about Meta's request
 * limits also carry what a translation needs in their payload (`kind` and
 * the values), so Diagnostics can say "paused until 14:05" in the reader's
 * language and time zone rather than in the worker's UTC. Only these values
 * leave the server, never the rest of a payload.
 *
 * Client-safe: no database, queue or Redis import.
 */

/** An account pause started (lib/queue/account-pause.ts). */
export const META_PAUSE_EVENT = "meta-pause";
/** A response reported 80 % or more of a limit (lib/ops/meta-usage.ts). */
export const META_USAGE_EVENT = "meta-usage";
/** A request limit ended a comment sweep (lib/polling/comment-reconciler.ts). */
export const SWEEP_LIMIT_EVENT = "sweep-limit";

export type EventDetail =
  | { kind: typeof META_PAUSE_EVENT; resumeAt: string; account: string | null }
  | { kind: typeof META_USAGE_EVENT; percent: number; account: string | null }
  | { kind: typeof SWEEP_LIMIT_EVENT; account: string | null };

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
    default:
      return null;
  }
}
