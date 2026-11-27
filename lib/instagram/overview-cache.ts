/**
 * The Overview's cache in Redis (B13; Meta submission plan, part B, S1c).
 *
 * The Overview asked Meta for one insights read per post, for up to 500
 * posts at a time, on every open. It now reads insights for the 12 newest
 * posts only and keeps them here:
 * - overview:v1:<accountRowId>:<count>  the whole answer for 10 minutes, so a
 *   reopen in that time makes no Meta call;
 * - insights:v1:<accountRowId>:<mediaId>  one post's insights for 6 hours.
 * Business metrics and the account's own captions only: nothing about the
 * people who follow or write, no messages.
 *
 * A cache that fails or does not answer within 3 seconds is skipped for the
 * rest of the request (the page then reads Meta as before), so a slow Redis
 * costs a request at most those 3 seconds.
 */
import { getRedisConnection } from "@/lib/queue/client";

export const OVERVIEW_CACHE_TTL_MS = 10 * 60_000;
export const INSIGHTS_CACHE_TTL_MS = 6 * 60 * 60_000;
const CACHE_TIMEOUT_MS = 3_000;

export function overviewCacheKey(accountRowId: string, count: number | "all"): string {
  return `overview:v1:${accountRowId}:${count}`;
}

export function insightsCacheKey(accountRowId: string, mediaId: string): string {
  return `insights:v1:${accountRowId}:${mediaId}`;
}

export interface OverviewCache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("cache timeout")), CACHE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The cache as one request uses it: after a failure it is left alone. */
export function overviewCache(): OverviewCache {
  let unavailable = false;
  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (unavailable) return undefined;
    try {
      return await withTimeout(operation());
    } catch {
      unavailable = true;
      return undefined;
    }
  }
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = await run(() => getRedisConnection().get(key));
      if (typeof raw !== "string") return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async set(key: string, value: unknown, ttlMs: number): Promise<void> {
      await run(() => getRedisConnection().set(key, JSON.stringify(value), "PX", ttlMs));
    },
  };
}
