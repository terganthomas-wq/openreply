/**
 * How close the app is to Meta's request limits, as Meta reports it with
 * every Graph API response.
 *
 * - `x-app-usage`: the app's share of its limit over the last hour, e.g.
 *   {"call_count":28,"total_cputime":25,"total_time":25}, each in percent.
 * - `x-business-use-case-usage`: the same per business (the Instagram
 *   account) and use case, e.g. {"1784…":[{"type":"instagram",
 *   "call_count":1,"total_cputime":1,"total_time":1,
 *   "estimated_time_to_regain_access":0}]}; the last value is in minutes.
 *
 * The Meta client hands every response's headers to noteMetaUsage. Whoever
 * wants to know registers with observeMetaUsage: the worker does
 * (lib/ops/meta-usage.ts), so the parsing here stays free of side effects.
 * Neither header ever carries a token.
 */

export interface MetaUsageShare {
  callCount?: number;
  totalCputime?: number;
  totalTime?: number;
}

export interface MetaBusinessUsage extends MetaUsageShare {
  /** The business the share is counted for: the Instagram account's id. */
  id: string;
  type?: string;
  /** Minutes until calls go through again, when Meta is refusing them. */
  estimatedTimeToRegainAccess?: number;
}

export interface MetaUsage {
  app: MetaUsageShare | null;
  business: MetaBusinessUsage[];
}

export interface MetaUsageReport {
  usage: MetaUsage;
  /** The Instagram account whose token made the call, when known. */
  instagramId: string | null;
}

type HeaderSource = { get(name: string): string | null } | null | undefined;

function readJson(headers: HeaderSource, name: string): unknown {
  if (!headers || typeof headers.get !== "function") return null;
  const value = headers.get(name);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function share(raw: Record<string, unknown>): MetaUsageShare {
  return {
    ...(percent(raw.call_count) !== undefined
      ? { callCount: percent(raw.call_count) }
      : {}),
    ...(percent(raw.total_cputime) !== undefined
      ? { totalCputime: percent(raw.total_cputime) }
      : {}),
    ...(percent(raw.total_time) !== undefined
      ? { totalTime: percent(raw.total_time) }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The usage a response reports, or null when it carries neither header (or
 * only ones that cannot be read).
 */
export function parseMetaUsage(headers: HeaderSource): MetaUsage | null {
  const appRaw = readJson(headers, "x-app-usage");
  const businessRaw = readJson(headers, "x-business-use-case-usage");
  const app = isRecord(appRaw) ? share(appRaw) : null;
  const business: MetaBusinessUsage[] = [];
  if (isRecord(businessRaw)) {
    for (const [id, entries] of Object.entries(businessRaw)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const regain = percent(entry.estimated_time_to_regain_access);
        business.push({
          id,
          ...(typeof entry.type === "string" ? { type: entry.type } : {}),
          ...share(entry),
          ...(regain !== undefined ? { estimatedTimeToRegainAccess: regain } : {}),
        });
      }
    }
  }
  if (!app && business.length === 0) return null;
  return { app, business };
}

/** The highest share of any limit in the report, in percent (0 if none). */
export function highestUsagePercent(usage: MetaUsage): number {
  const shares: MetaUsageShare[] = [
    ...(usage.app ? [usage.app] : []),
    ...usage.business,
  ];
  let highest = 0;
  for (const s of shares) {
    for (const value of [s.callCount, s.totalCputime, s.totalTime]) {
      if (value !== undefined && value > highest) highest = value;
    }
  }
  return highest;
}

type MetaUsageObserver = (report: MetaUsageReport) => void;

let observer: MetaUsageObserver | null = null;

/**
 * Register the one observer of Meta's usage reports (null removes it). It
 * runs synchronously with every Meta response that carries a usage header,
 * so it must return at once and never throw; anything slow belongs in a
 * promise it does not await.
 */
export function observeMetaUsage(next: MetaUsageObserver | null): void {
  observer = next;
}

/** Called by the Meta client with the headers of every response. */
export function noteMetaUsage(
  headers: HeaderSource,
  instagramId: string | null
): void {
  if (!observer) return;
  try {
    const usage = parseMetaUsage(headers);
    if (usage) observer({ usage, instagramId });
  } catch {
    // Observing usage must never break the call that reported it.
  }
}
