/**
 * When the Inbox reads Instagram (Meta submission plan, part B, S1b).
 *
 * Every Meta call of the app counts against one shared request limit: on
 * 2026-11-21 about 25 private replies and 50 conversation reads in an hour
 * stopped every call of the app for about an hour. The Inbox used to read
 * the list and the open thread every 12 seconds, up to 600 reads an hour for
 * one open tab. Now:
 * - the list is read every LIST_POLL_MS, and only while the tab is visible
 *   and was used (pointer, key, scroll, focus) in the last IDLE_STOP_MS.
 *   After that the timer stops until "Refresh" or a return to the tab;
 * - there is no thread timer: the open thread is read when it opens, after
 *   an own send, when a list read shows that it changed
 *   (conversationChanged), and on "Refresh";
 * - a stored copy of the list or a thread is painted only while it is
 *   younger than CACHE_MAX_AGE_MS; the thread is read when it opens anyway.
 *   A list copy painted on opening stands in for a read only until it is
 *   that old (firstListReadIn). Then the list is read as an open without a
 *   copy reads it: the whole list, a page Meta refuses narrowed down, and an
 *   error shown in the list's place, so the copy goes either way. A tab
 *   hidden at that moment makes this read when it is shown again; while the
 *   server pauses reads, the copy stays, as anything shown does, and the
 *   first turn of the timer or return to the tab after the pause makes it.
 *   A list read that replaced the copy before stands for it. So a message
 *   unsent meanwhile shows from a list copy until that read has answered,
 *   during a pause until the read after it. Copies older than
 *   CACHE_MAX_AGE_MS are removed from the browser's storage
 *   (lib/inbox/copies.ts);
 * - the server allows both reads together at most 40 requests to Meta an
 *   hour per account (lib/inbox/read-budget.ts) and answers 429 inbox_budget
 *   beyond that and while the worker has paused the account for a Meta
 *   limit; the page then pauses until the answer's Retry-After
 *   (inboxBudgetRetryAt).
 *
 * Pure and client-safe: no imports, no clock of its own.
 */

/** How often the list is read while the Inbox is visible and used. */
export const LIST_POLL_MS = 120_000;
/** No input for this long stops the list timer. */
export const IDLE_STOP_MS = 600_000;
/** A stored list or thread older than this is not painted. */
export const CACHE_MAX_AGE_MS = 60_000;
/** The list's scope: getConversations (lib/meta/client.ts) reads at most 50. */
export const CONVERSATION_LIST_MAX = 50;

export type PollState = "poll" | "hidden" | "idle";

/** What the list timer does now: read, skip (tab hidden) or stop (idle). */
export function pollState({
  visible,
  lastInputAt,
  now,
}: {
  visible: boolean;
  lastInputAt: number;
  now: number;
}): PollState {
  if (!visible) return "hidden";
  if (now - lastInputAt >= IDLE_STOP_MS) return "idle";
  return "poll";
}

/** Whether a read done at `readAt` is too old to stand for the list now. */
export function readIsStale(readAt: number, now: number): boolean {
  return now - readAt > CACHE_MAX_AGE_MS;
}

/**
 * How long (ms) a list copy stored at `copyAt` and painted on opening stands
 * in for the first read: until it is CACHE_MAX_AGE_MS old. Then the whole
 * list is read, as on an open without a copy, so a reload does not keep an
 * unsent message's preview until the timer's next turn, nor while Meta
 * refuses the newest page that a timer read asks for.
 */
export function firstListReadIn(copyAt: number, now: number): number {
  return Math.max(0, CACHE_MAX_AGE_MS - (now - copyAt));
}

/** The fields of a list entry that tell whether its thread changed. */
export interface ConversationSummary {
  id: string;
  updatedTime: string | null;
  lastMessage: { text: string; createdTime: string | null } | null;
}

/**
 * Whether the list now shows conversation `id` other than before: its update
 * time or its last message (text, time) differs, or it is new. One that is no
 * longer listed has nothing to read.
 */
export function conversationChanged(
  previousList: readonly ConversationSummary[],
  nextList: readonly ConversationSummary[],
  id: string
): boolean {
  const next = nextList.find((conversation) => conversation.id === id);
  if (!next) return false;
  const previous = previousList.find((conversation) => conversation.id === id);
  if (!previous) return true;
  if (previous.updatedTime !== next.updatedTime) return true;
  const before = previous.lastMessage;
  const after = next.lastMessage;
  if (!before || !after) return before !== after;
  return before.text !== after.text || before.createdTime !== after.createdTime;
}

/**
 * A timer read asks for one page of the list (the newest conversations,
 * `?silent=1`). It replaces the top of what is shown; older entries stay as
 * they were until the next full read (opening the Inbox, "Refresh").
 */
export function mergeConversationPage<T extends { id: string }>(
  shown: readonly T[],
  page: readonly T[],
  max = CONVERSATION_LIST_MAX
): T[] {
  const fresh = new Set(page.map((conversation) => conversation.id));
  return [...page, ...shown.filter((conversation) => !fresh.has(conversation.id))].slice(
    0,
    max
  );
}

/** A refused read pauses the Inbox's reads at least this long. */
export const BUDGET_PAUSE_MIN_MS = 30_000;

/**
 * The end of the read pause (ms, on this browser's clock `now`) when the
 * server refused a read for the account's hourly budget (HTTP 429, code
 * "inbox_budget"); otherwise null. It counts the answer's Retry-After
 * seconds from `now`, so a browser clock ahead of the server's cannot end
 * the pause at once; the server's own retryAt only stands in when the header
 * is missing. Never sooner than BUDGET_PAUSE_MIN_MS from `now`, so a refused
 * read never starts the next one right away.
 */
export function inboxBudgetRetryAt(
  status: number,
  body: unknown,
  retryAfter: string | null,
  now: number
): number | null {
  if (status !== 429 || !body || typeof body !== "object") return null;
  const { code, retryAt } = body as { code?: unknown; retryAt?: unknown };
  if (code !== "inbox_budget") return null;
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
  const at = Number.isFinite(seconds)
    ? now + seconds * 1000
    : typeof retryAt === "string"
      ? Date.parse(retryAt)
      : NaN;
  return Number.isFinite(at) ? Math.max(at, now + BUDGET_PAUSE_MIN_MS) : null;
}
