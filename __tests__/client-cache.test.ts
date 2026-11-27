/**
 * The browser copies of lib/client-cache.ts: pruneCache removes the stale
 * entries of the prefixes a page names (the Inbox's lists and threads, which
 * it paints only while they are younger than a minute and which can hold a
 * message unsent since), and leaves every other key alone.
 *
 * sessionStorage is an in-memory stand-in; the clock is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneCache, readCache, writeCache } from "../lib/client-cache";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");
const MINUTE = 60_000;
const INBOX = ["inbox:convs:", "inbox:msgs:"];

class MemoryStorage {
  readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  storage = new MemoryStorage();
  vi.stubGlobal("window", { sessionStorage: storage });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pruneCache", () => {
  it("removes the Inbox's stale copies and keeps the fresh ones", () => {
    writeCache("inbox:msgs:thread_a", [{ text: "Unsent later" }]);
    writeCache("inbox:convs:account_1", [{ id: "thread_a" }]);
    vi.setSystemTime(NOW + 2 * MINUTE);
    writeCache("inbox:msgs:thread_b", [{ text: "Fresh" }]);

    pruneCache(INBOX, MINUTE);

    expect([...storage.items.keys()]).toEqual(["inbox:msgs:thread_b"]);
    expect(readCache("inbox:msgs:thread_b", MINUTE)).toMatchObject({
      data: [{ text: "Fresh" }],
      stale: false,
      ts: NOW + 2 * MINUTE,
    });
  });

  it("keeps every other key, however old", () => {
    storage.setItem("inbox:selectedAccount", "account_1");
    writeCache("posts:account_1", ["post"]);
    writeCache("inbox:msgs:thread_a", ["old"]);
    vi.setSystemTime(NOW + 60 * MINUTE);

    pruneCache(INBOX, MINUTE);

    expect(storage.getItem("inbox:selectedAccount")).toBe("account_1");
    expect(storage.getItem("posts:account_1")).not.toBeNull();
    expect(storage.getItem("inbox:msgs:thread_a")).toBeNull();
  });

  it("removes an entry it cannot read", () => {
    storage.setItem("inbox:convs:account_1", "{not json");
    storage.setItem("inbox:msgs:thread_a", JSON.stringify({ data: ["no time"] }));

    pruneCache(INBOX, MINUTE);

    expect(storage.items.size).toBe(0);
  });

  it("never throws, also when the storage does", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): never {
        throw new Error("SecurityError");
      },
    });
    expect(() => pruneCache(INBOX, MINUTE)).not.toThrow();
  });
});
