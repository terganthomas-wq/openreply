/**
 * When the Inbox reads Instagram (lib/inbox/poll.ts; Meta submission plan,
 * part B, S1b): never while the tab is hidden, a stop after 10 minutes
 * without input, and a thread read only when the list shows a change.
 */
import { describe, expect, it } from "vitest";
import {
  CACHE_MAX_AGE_MS,
  IDLE_STOP_MS,
  LIST_POLL_MS,
  conversationChanged,
  inboxBudgetRetryAt,
  mergeConversationPage,
  pollState,
  readIsStale,
  type ConversationSummary,
} from "../lib/inbox/poll";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The list timer over an hour: one turn every LIST_POLL_MS, `inputAt` says
 * when someone last used the tab at a given time. Counts the reads and says
 * when it stopped, as the page's timer does (it stops at the first idle turn).
 */
function simulate(visible: (t: number) => boolean, inputAt: (t: number) => number) {
  let reads = 0;
  for (let t = LIST_POLL_MS; t <= HOUR; t += LIST_POLL_MS) {
    const state = pollState({ visible: visible(t), lastInputAt: inputAt(t), now: t });
    if (state === "idle") return { reads, stoppedAt: t };
    if (state === "poll") reads++;
  }
  return { reads, stoppedAt: null };
}

describe("the list timer's rules", () => {
  it("reads every 2 minutes, keeps a stored copy for 1 minute, stops after 10 idle minutes", () => {
    expect(LIST_POLL_MS).toBe(120_000);
    expect(CACHE_MAX_AGE_MS).toBe(60_000);
    expect(IDLE_STOP_MS).toBe(600_000);
  });

  it("does not read while the tab is hidden, however recent the input", () => {
    expect(pollState({ visible: false, lastInputAt: 1_000, now: 1_000 })).toBe("hidden");
    expect(simulate(() => false, (t) => t)).toEqual({ reads: 0, stoppedAt: null });
  });

  it("reads while visible and used: about 30 times an hour", () => {
    expect(pollState({ visible: true, lastInputAt: 0, now: 5 * MINUTE })).toBe("poll");
    expect(simulate(() => true, (t) => t - MINUTE)).toEqual({ reads: 30, stoppedAt: null });
  });

  it("stops after 10 minutes without input", () => {
    expect(pollState({ visible: true, lastInputAt: 0, now: IDLE_STOP_MS - 1 })).toBe("poll");
    expect(pollState({ visible: true, lastInputAt: 0, now: IDLE_STOP_MS })).toBe("idle");
    // Opened at 0 and left alone: four reads, then the timer stops.
    expect(simulate(() => true, () => 0)).toEqual({ reads: 4, stoppedAt: 10 * MINUTE });
  });

  it("a hidden tab is not stopped for idleness, and reads again once it is back and used", () => {
    // Hidden from minute 5 to minute 45 with no input since minute 0, then
    // back (that is input) and used: two reads before, eight after.
    const visible = (t: number) => t < 5 * MINUTE || t >= 45 * MINUTE;
    const inputAt = (t: number) => (t < 45 * MINUTE ? 0 : t - MINUTE);
    expect(pollState({ visible: false, lastInputAt: 0, now: 30 * MINUTE })).toBe("hidden");
    expect(simulate(visible, inputAt)).toEqual({ reads: 10, stoppedAt: null });
  });

  it("calls a read older than a minute stale", () => {
    expect(readIsStale(0, CACHE_MAX_AGE_MS)).toBe(false);
    expect(readIsStale(0, CACHE_MAX_AGE_MS + 1)).toBe(true);
    // Never read yet.
    expect(readIsStale(0, Date.UTC(2026, 10, 27))).toBe(true);
  });
});

function entry(
  id: string,
  updatedTime: string | null,
  lastMessage: ConversationSummary["lastMessage"] = { text: "Hallo", createdTime: updatedTime }
): ConversationSummary {
  return { id, updatedTime, lastMessage };
}

describe("conversationChanged", () => {
  const before = [
    entry("c1", "2026-11-27T10:00:00+0000"),
    entry("c2", "2026-11-27T09:00:00+0000"),
  ];

  it("sees no change in an identical list, so the thread is not read again", () => {
    const same = before.map((c) => ({ ...c, lastMessage: c.lastMessage && { ...c.lastMessage } }));
    expect(conversationChanged(before, same, "c1")).toBe(false);
    expect(conversationChanged(before, same, "c2")).toBe(false);
  });

  it("sees a new update time", () => {
    const after = [entry("c1", "2026-11-27T10:05:00+0000", before[0].lastMessage), before[1]];
    expect(conversationChanged(before, after, "c1")).toBe(true);
    expect(conversationChanged(before, after, "c2")).toBe(false);
  });

  it("sees a new last message by its text or its time", () => {
    const text = [
      entry("c1", "2026-11-27T10:00:00+0000", { text: "Noch eine Frage", createdTime: "2026-11-27T10:00:00+0000" }),
      before[1],
    ];
    expect(conversationChanged(before, text, "c1")).toBe(true);
    const time = [
      entry("c1", "2026-11-27T10:00:00+0000", { text: "Hallo", createdTime: "2026-11-27T10:01:00+0000" }),
      before[1],
    ];
    expect(conversationChanged(before, time, "c1")).toBe(true);
  });

  it("sees a last message appear, and a conversation that is new", () => {
    const empty = [entry("c3", null, null)];
    expect(conversationChanged(empty, empty, "c3")).toBe(false);
    expect(conversationChanged(empty, [entry("c3", null)], "c3")).toBe(true);
    expect(conversationChanged([], before, "c1")).toBe(true);
  });

  it("has nothing to read for a conversation no longer listed", () => {
    expect(conversationChanged(before, [before[1]], "c1")).toBe(false);
  });
});

describe("mergeConversationPage", () => {
  const shown = ["a", "b", "c", "d"].map((id) => ({ id, v: "old" }));

  it("puts a timer read's page on top and keeps the older entries", () => {
    const page = [{ id: "c", v: "new" }, { id: "a", v: "new" }];
    expect(mergeConversationPage(shown, page)).toEqual([
      { id: "c", v: "new" },
      { id: "a", v: "new" },
      { id: "b", v: "old" },
      { id: "d", v: "old" },
    ]);
  });

  it("keeps the list's scope of 50", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `old-${i}` }));
    const merged = mergeConversationPage(many, [{ id: "new" }]);
    expect(merged).toHaveLength(50);
    expect(merged[0]).toEqual({ id: "new" });
    expect(merged.at(-1)).toEqual({ id: "old-48" });
  });
});

describe("inboxBudgetRetryAt", () => {
  const retryAt = "2026-11-27T11:00:00.000Z";

  it("reads the end of the pause from a refused read", () => {
    expect(
      inboxBudgetRetryAt(429, { success: false, code: "inbox_budget", retryAt })
    ).toBe(Date.parse(retryAt));
  });

  it("is null for every other answer", () => {
    expect(inboxBudgetRetryAt(200, { success: true, data: {} })).toBeNull();
    expect(inboxBudgetRetryAt(500, { success: false, code: "inbox_budget", retryAt })).toBeNull();
    expect(inboxBudgetRetryAt(429, { success: false, error: "Too many" })).toBeNull();
    expect(inboxBudgetRetryAt(429, { code: "inbox_budget", retryAt: "later" })).toBeNull();
    expect(inboxBudgetRetryAt(429, null)).toBeNull();
  });
});
