/**
 * The Inbox's copies of conversation lists and threads in the tab's
 * sessionStorage (lib/client-cache.ts; Meta submission plan, part B, S1b).
 *
 * They hold DM texts, handles and IGSIDs. The Inbox paints a copy only while
 * it is younger than CACHE_MAX_AGE_MS (lib/inbox/poll.ts), so an older one is
 * never used again, and it may hold a message unsent since. pruneInboxCopies
 * removes those older ones: the Inbox calls it when an account opens, after
 * every successful read and when it unmounts, and the dashboard shell on
 * every dashboard page (components/dashboard-shell.tsx). A copy still younger
 * when the Inbox is left goes with the first dashboard page opened after it
 * turned that old, or with the tab. Every other key stays, the account the
 * Inbox remembers (inbox:selectedAccount) too.
 */
import { pruneCache } from "@/lib/client-cache";
import { CACHE_MAX_AGE_MS } from "@/lib/inbox/poll";

/** inbox:convs:<account row id> holds a list, inbox:msgs:<conversation id> a thread. */
export const INBOX_COPY_PREFIXES = ["inbox:convs:", "inbox:msgs:"] as const;

/** Removes the Inbox's copies older than CACHE_MAX_AGE_MS; best effort. */
export function pruneInboxCopies(): void {
  pruneCache(INBOX_COPY_PREFIXES, CACHE_MAX_AGE_MS);
}
