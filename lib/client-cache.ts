/**
 * Tiny stale-while-revalidate cache backed by sessionStorage.
 *
 * Instagram API calls (profile picture, the post library) are slow, so we show
 * the last cached copy instantly and refresh in the background. Cache lives for
 * the browser tab session; entries older than the caller's max age are treated
 * as stale (still shown, but the caller should revalidate). A page whose
 * copies must not outlive their use removes its stale ones with pruneCache.
 */

interface Entry<T> {
  data: T;
  ts: number;
}

export function readCache<T>(
  key: string,
  maxAgeMs: number
): { data: T | null; stale: boolean; ts: number | null } {
  if (typeof window === "undefined") return { data: null, stale: true, ts: null };
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return { data: null, stale: true, ts: null };
    const entry = JSON.parse(raw) as Entry<T>;
    return { data: entry.data, stale: Date.now() - entry.ts > maxAgeMs, ts: entry.ts };
  } catch {
    return { data: null, stale: true, ts: null };
  }
}

/**
 * Removes the stored entries under `prefixes` that are older than `maxAgeMs`
 * or cannot be read; every other key stays. For copies a page paints only
 * while they are fresh (the Inbox's lists and threads): a stale one is never
 * shown again, and it may hold a message that was unsent since. Best effort,
 * like the cache itself.
 */
export function pruneCache(prefixes: readonly string[], maxAgeMs: number): void {
  if (typeof window === "undefined") return;
  try {
    const storage = window.sessionStorage;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    const now = Date.now();
    for (const key of keys) {
      let ts = Number.NaN;
      try {
        ts = Number((JSON.parse(storage.getItem(key) ?? "null") as Entry<unknown> | null)?.ts);
      } catch {
        // Unreadable: removed below.
      }
      if (!Number.isFinite(ts) || now - ts > maxAgeMs) storage.removeItem(key);
    }
  } catch {
    // Storage unavailable — pruning is best-effort.
  }
}

export function writeCache<T>(key: string, data: T): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      key,
      JSON.stringify({ data, ts: Date.now() })
    );
  } catch {
    // Storage full or unavailable — caching is best-effort.
  }
}
