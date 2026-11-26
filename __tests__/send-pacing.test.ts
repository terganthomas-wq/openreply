/**
 * The send pace (lib/queue/send-pacing.ts): the slots it hands out per
 * account and purpose, at least the spacing apart and never before the
 * earliest time asked for, with Redis an in-memory stand-in that runs the
 * script the way its Lua does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis } from "./helpers/fake-redis";

const redis = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => redis.current }));

import {
  lastPacedSlot,
  manualSendPaceKey,
  recoveryPaceKey,
  reservePacedSlot,
} from "../lib/queue/send-pacing";

const NOW = new Date("2026-11-25T21:00:00.000Z").getTime();
const SPACING = 150_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  redis.current = new FakeRedis();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the send pace", () => {
  it("hands out the first slot right away, then one every spacing", async () => {
    const key = recoveryPaceKey("ig_1");
    const slots = [];
    for (let i = 0; i < 3; i++) {
      slots.push(await reservePacedSlot(key, { earliest: NOW, spacingMs: SPACING }));
    }
    expect(slots).toEqual([NOW, NOW + SPACING, NOW + 2 * SPACING]);
    expect(await lastPacedSlot(key)).toBe(NOW + 2 * SPACING);
  });

  it("never hands out a slot before the earliest time asked for", async () => {
    const key = recoveryPaceKey("ig_1");
    await reservePacedSlot(key, { earliest: NOW, spacingMs: SPACING });
    // A copy that may only run after a pause 20 minutes from now.
    expect(await reservePacedSlot(key, { earliest: NOW + 20 * 60_000, spacingMs: SPACING })).toBe(
      NOW + 20 * 60_000
    );
    // The next one lines up behind it.
    expect(await reservePacedSlot(key, { earliest: NOW, spacingMs: SPACING })).toBe(
      NOW + 20 * 60_000 + SPACING
    );
  });

  it("keeps each account's and each purpose's pace apart", async () => {
    await reservePacedSlot(recoveryPaceKey("ig_1"), { earliest: NOW, spacingMs: SPACING });
    expect(await reservePacedSlot(recoveryPaceKey("ig_2"), { earliest: NOW, spacingMs: SPACING })).toBe(NOW);
    expect(await reservePacedSlot(manualSendPaceKey("ig_1"), { earliest: NOW, spacingMs: 20_000 })).toBe(NOW);
  });

  it("forgets a pace an hour after its last slot", async () => {
    const key = manualSendPaceKey("ig_1");
    await reservePacedSlot(key, { earliest: NOW, spacingMs: 20_000 });
    vi.setSystemTime(NOW + 61 * 60_000);
    expect(await lastPacedSlot(key)).toBeNull();
    expect(await reservePacedSlot(key, { earliest: Date.now(), spacingMs: 20_000 })).toBe(Date.now());
  });

  it("throws when Redis cannot be asked", async () => {
    redis.current = { eval: async () => { throw new Error("Redis is down"); } };
    await expect(
      reservePacedSlot(recoveryPaceKey("ig_1"), { earliest: NOW, spacingMs: SPACING })
    ).rejects.toThrow("Redis is down");
  });
});
