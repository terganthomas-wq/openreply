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
 *   younger than CACHE_MAX_AGE_MS, so an unsent message does not come back
 *   from the browser;
 * - the server allows both reads at most 40 times an hour per account
 *   (lib/inbox/read-budget.ts) and answers 429 inbox_budget beyond that.
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

/**
 * The end of the read pause (ms) when the server refused a read for the
 * account's hourly budget (HTTP 429, code "inbox_budget"); otherwise null.
 */
export function inboxBudgetRetryAt(status: number, body: unknown): number | null {
  if (status !== 429 || !body || typeof body !== "object") return null;
  const { code, retryAt } = body as { code?: unknown; retryAt?: unknown };
  if (code !== "inbox_budget" || typeof retryAt !== "string") return null;
  const at = Date.parse(retryAt);
  return Number.isFinite(at) ? at : null;
}
