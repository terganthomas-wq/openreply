/**
 * The Inbox's Meta read budget (Meta submission plan, part B, S1b).
 *
 * At most INBOX_READS_PER_HOUR reads of the conversation list and of threads
 * per Instagram account row, in a window of one hour from the window's first
 * read. Both GET routes (/api/instagram/conversations and its [id]) reserve
 * one before they ask Meta; sending by hand (the POST) is never capped.
 *
 * A constant on purpose, no env var: every Meta call of the app counts
 * against one shared request limit (on 2026-11-21 about 25 private replies
 * and 50 conversation reads in an hour blocked every call for an hour), and
 * whoever opens the Inbox, a reviewer included, must not spend it on reads.
 *
 * The counter is the one of the manual sends (lib/comments/server.ts):
 * INCR first, the expiry set by the first read. It is a safety net, not an
 * access control: when Redis fails or does not answer within 3 seconds, the
 * read is allowed and a warning is logged.
 */
import { getRedisConnection } from "@/lib/queue/client";

export const INBOX_READS_PER_HOUR = 40;
export const INBOX_READ_WINDOW_MS = 60 * 60_000;
const REDIS_TIMEOUT_MS = 3_000;
// Word for word the manual sends' counter, so the test stand-in runs it too.
const COUNTER_SCRIPT =
  'local n = redis.call("INCR", KEYS[1]) if n == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end return n';

export function inboxReadKey(accountRowId: string): string {
  return `inbox:reads:${accountRowId}`;
}

export type InboxReadReservation =
  | { allowed: true }
  | { allowed: false; retryAt: Date };

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), REDIS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reserves one Inbox read of Meta for this account row. Refused once the
 * hour's budget is used up, with the time the window ends.
 */
export async function reserveInboxRead(
  accountRowId: string
): Promise<InboxReadReservation> {
  const key = inboxReadKey(accountRowId);
  let count: number;
  try {
    count = Number(
      await withTimeout(
        getRedisConnection().eval(COUNTER_SCRIPT, 1, key, String(INBOX_READ_WINDOW_MS))
      )
    );
  } catch {
    // No detail: a Redis error can name the server.
    console.warn("[Inbox] Read budget not checked (Redis failed or was slow); read allowed");
    return { allowed: true };
  }
  if (!Number.isFinite(count) || count <= INBOX_READS_PER_HOUR) {
    return { allowed: true };
  }
  const now = Date.now();
  let retryAt = now + INBOX_READ_WINDOW_MS;
  try {
    const left = Number(await withTimeout(getRedisConnection().pttl(key)));
    if (left > 0) retryAt = now + left;
  } catch {
    // Without the time left, wait the whole window.
  }
  return { allowed: false, retryAt: new Date(retryAt) };
}

/** The answer to a refused read: 429 with code inbox_budget and retryAt. */
export function inboxBudgetResponse(retryAt: Date): Response {
  const seconds = Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000));
  return Response.json(
    {
      success: false,
      code: "inbox_budget",
      retryAt: retryAt.toISOString(),
      error: "The Inbox pauses its Instagram reads to stay within the request limit.",
    },
    { status: 429, headers: { "Retry-After": String(seconds) } }
  );
}
