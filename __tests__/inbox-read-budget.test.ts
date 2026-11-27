/**
 * The Inbox's Meta read budget (lib/inbox/read-budget.ts; Meta submission
 * plan, part B, S1b): 40 reads an hour per account row, counted from the
 * window's first read, and a Redis that fails or hangs never blocks a read.
 *
 * Redis is the in-memory stand-in, with expiry on the faked clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ redis: null as unknown }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => state.redis }));

import {
  INBOX_READS_PER_HOUR,
  INBOX_READ_WINDOW_MS,
  inboxBudgetResponse,
  inboxReadKey,
  reserveInboxRead,
} from "../lib/inbox/read-budget";
import { FakeRedis } from "./helpers/fake-redis";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");
const MINUTE = 60_000;
let redis: FakeRedis;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  redis = new FakeRedis();
  state.redis = redis;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reserveInboxRead", () => {
  it("allows 40 reads an hour and refuses the 41st with the window's end", async () => {
    expect(INBOX_READS_PER_HOUR).toBe(40);
    expect(INBOX_READ_WINDOW_MS).toBe(60 * MINUTE);
    for (let i = 0; i < 40; i++) {
      // Spread over 30 minutes: the window counts from its first read.
      vi.setSystemTime(NOW + i * 45_000);
      expect(await reserveInboxRead("account_1"), `read ${i + 1}`).toEqual({ allowed: true });
    }
    vi.setSystemTime(NOW + 30 * MINUTE);
    expect(await reserveInboxRead("account_1")).toEqual({
      allowed: false,
      retryAt: new Date(NOW + 60 * MINUTE),
    });
    expect(redis.commands).toContain(`EVAL counter ${inboxReadKey("account_1")} ${60 * MINUTE}`);
  });

  it("allows reads again once the hour from the first read is over", async () => {
    for (let i = 0; i < 41; i++) await reserveInboxRead("account_1");
    vi.setSystemTime(NOW + 60 * MINUTE - 1);
    expect((await reserveInboxRead("account_1")).allowed).toBe(false);
    vi.setSystemTime(NOW + 60 * MINUTE);
    expect(await reserveInboxRead("account_1")).toEqual({ allowed: true });
  });

  it("keeps a budget per account row", async () => {
    for (let i = 0; i < 40; i++) await reserveInboxRead("account_1");
    expect((await reserveInboxRead("account_1")).allowed).toBe(false);
    expect(await reserveInboxRead("account_2")).toEqual({ allowed: true });
  });

  it("waits the whole window when Redis cannot say how much is left", async () => {
    for (let i = 0; i < 40; i++) await reserveInboxRead("account_1");
    vi.spyOn(redis, "pttl").mockImplementation(() => {
      throw new Error("pttl failed");
    });
    vi.setSystemTime(NOW + 10 * MINUTE);
    expect(await reserveInboxRead("account_1")).toEqual({
      allowed: false,
      retryAt: new Date(NOW + 70 * MINUTE),
    });
  });

  it("allows the read and warns, without details, when Redis fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.redis = {
      eval: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED redis.example.test:6379")),
    };
    expect(await reserveInboxRead("account_1")).toEqual({ allowed: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("redis.example.test");
  });

  it("allows the read after 3 seconds when Redis does not answer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.redis = { eval: vi.fn(() => new Promise(() => {})) };
    let result: unknown = "pending";
    void reserveInboxRead("account_1").then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(result).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ allowed: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("inboxBudgetResponse", () => {
  it("answers 429 with code inbox_budget, the time and Retry-After", async () => {
    const response = inboxBudgetResponse(new Date(NOW + 12 * MINUTE + 500));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(12 * 60 + 1));
    expect(await response.json()).toMatchObject({
      success: false,
      code: "inbox_budget",
      retryAt: new Date(NOW + 12 * MINUTE + 500).toISOString(),
    });
  });
});
