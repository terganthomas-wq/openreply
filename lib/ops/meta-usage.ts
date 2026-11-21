/**
 * A warning in Diagnostics before Meta's request limit is reached.
 *
 * Every Meta response says how much of the app's limit, and of the account's
 * business use case limit, the last hour used (lib/meta/usage.ts). From 80 %
 * on, the worker records a WARNING with those percentages, at most once per
 * 10 minutes per account, so the owner sees a limit coming before Meta starts
 * refusing messages. The worker registers this at start (worker/dm-worker.ts).
 */

import { prisma } from "@/lib/db/client";
import {
  highestUsagePercent,
  observeMetaUsage,
  type MetaUsage,
  type MetaUsageReport,
  type MetaUsageShare,
} from "@/lib/meta/usage";
import { META_USAGE_EVENT } from "@/lib/ops/event-details";
import { getRedisConnection } from "@/lib/queue/client";
import { formatError, logWorkerEvent } from "@/lib/queue/send-helpers";

/** From this share of a limit on (percent), a warning is recorded. */
export const USAGE_WARNING_PERCENT = 80;
/** At most one warning per account in this time. */
export const USAGE_WARNING_INTERVAL_MS = 10 * 60_000;

// Per process, so a response at 90 % does not ask Redis every time; Redis
// decides across processes.
const lastWarnedAt = new Map<string, number>();

function rounded(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value);
}

/**
 * The percentages, for the event: numbers only, never a token. The business
 * ids are Instagram account ids, kept only for an account of this instance.
 */
function usagePayload(usage: MetaUsage, withIds: boolean) {
  return {
    app: usage.app
      ? {
          callCount: rounded(usage.app.callCount),
          totalCputime: rounded(usage.app.totalCputime),
          totalTime: rounded(usage.app.totalTime),
        }
      : null,
    business: usage.business.map((entry) => ({
      id: withIds ? entry.id : null,
      type: entry.type ?? null,
      callCount: rounded(entry.callCount),
      totalCputime: rounded(entry.totalCputime),
      totalTime: rounded(entry.totalTime),
      estimatedTimeToRegainAccess: rounded(entry.estimatedTimeToRegainAccess),
    })),
  };
}

function describe(usage: MetaUsage, withIds: boolean): string {
  const shares = (s: MetaUsageShare) =>
    `calls ${rounded(s.callCount) ?? "-"} %, CPU ${rounded(s.totalCputime) ?? "-"} %, time ${rounded(s.totalTime) ?? "-"} %`;
  const parts: string[] = [];
  if (usage.app) parts.push(`app: ${shares(usage.app)}`);
  for (const entry of usage.business) {
    const name = [entry.type ?? "business", withIds ? entry.id : null]
      .filter(Boolean)
      .join(" ");
    parts.push(`${name}: ${shares(entry)}`);
  }
  return parts.join("; ");
}

/**
 * Record a WARNING when a response reports 80 % or more of any limit, unless
 * one was recorded for the account in the last 10 minutes. True when it did.
 */
export async function reportMetaUsage(
  { usage, instagramId }: MetaUsageReport,
  now: number = Date.now()
): Promise<boolean> {
  const highest = highestUsagePercent(usage);
  if (highest < USAGE_WARNING_PERCENT) return false;

  // Calls made without an account (none in the worker) share one key.
  const key = instagramId ?? "app";
  const last = lastWarnedAt.get(key);
  if (last !== undefined && now - last < USAGE_WARNING_INTERVAL_MS) {
    return false;
  }
  lastWarnedAt.set(key, now);

  const first = await getRedisConnection().set(
    `meta:usage-warning:${key}`,
    String(now),
    "PX",
    USAGE_WARNING_INTERVAL_MS,
    "NX"
  );
  if (first !== "OK") return false;

  const account = instagramId
    ? await prisma.instagramAccount.findUnique({
        where: { instagramId },
        select: { workspaceId: true, username: true },
      })
    : null;
  const percent = Math.round(highest);
  // Account ids only for an account of this instance: an event without a
  // workspace shows in every workspace's Diagnostics.
  const withIds = Boolean(account);
  await logWorkerEvent({
    workspaceId: account?.workspaceId ?? null,
    level: "WARNING",
    message: `Instagram request usage at ${percent} %${account ? ` for @${account.username}` : ""} (${describe(usage, withIds)}); from 100 % on Meta refuses messages`,
    payload: {
      kind: META_USAGE_EVENT,
      instagramAccountId: withIds ? instagramId : null,
      account: account?.username ?? null,
      highestPercent: percent,
      ...usagePayload(usage, withIds),
    },
  });
  return true;
}

/** Start reporting the usage of every Meta response of this process. */
export function startMetaUsageReports(): void {
  observeMetaUsage((report) => {
    if (highestUsagePercent(report.usage) < USAGE_WARNING_PERCENT) return;
    void reportMetaUsage(report).catch((error) =>
      console.error(
        "[Meta usage] Could not record the warning:",
        formatError(error)
      )
    );
  });
}

/** Tests: forget which accounts were warned in this process. */
export function resetMetaUsageWarnings(): void {
  lastWarnedAt.clear();
}
