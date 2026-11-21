/**
 * The account pause (R1): set or extend, never shorten, one event per pause,
 * and jobs held back until the pause ends, spread by their ids.
 *
 * Redis is an in-memory stand-in that runs the pause script's logic; the Lua
 * itself was run against the same cases in a Lua VM while writing it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis } from "./helpers/fake-redis";

const { redis, queueAdd, eventCreate } = vi.hoisted(() => ({
  redis: { current: null as unknown },
  queueAdd: vi.fn(),
  eventCreate: vi.fn(),
}));

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => redis.current,
  getDMQueue: () => ({ add: queueAdd }),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: { operationalEvent: { create: eventCreate } },
}));

import { RateLimitError } from "../lib/meta/client";
import {
  accountPauseKey,
  checkAccountPause,
  countPausedJobs,
  MAX_PAUSE_REQUEUES,
  PAUSE_JITTER_MS,
  pauseAccountForLimit,
  pauseJitterMs,
  pausedRunAt,
  readAccountPauses,
  requeueForPause,
} from "../lib/queue/account-pause";

const NOW = new Date("2026-11-21T13:00:00.000Z").getTime();
const MINUTE = 60_000;
const throttle = new RateLimitError(
  "(#4) Application request limit reached (/v25.0/ig/messages) [code=4 sub=- type=OAuthException trace=t]",
  "t",
  undefined,
  4
);
const block = new RateLimitError("temporarily blocked", "t", undefined, 368);

let fake: FakeRedis;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = new FakeRedis();
  redis.current = fake;
  queueAdd.mockReset().mockResolvedValue({});
  eventCreate.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function pause(error: unknown = throttle, now = Date.now()) {
  return pauseAccountForLimit({
    instagramAccountId: "ig_1",
    workspaceId: "workspace",
    account: "studio",
    error,
    now,
  });
}

describe("pausing an account", () => {
  it("stores the resume time with the pause's lifetime", async () => {
    const result = await pause();
    expect(result).toEqual({ resumeAt: NOW + 20 * MINUTE, started: true });
    await expect(fake.get("meta:pause:ig_1")).resolves.toBe(String(NOW + 20 * MINUTE));
    expect(fake.pttl("meta:pause:ig_1")).toBe(20 * MINUTE);
    expect(accountPauseKey("ig_1")).toBe("meta:pause:ig_1");
  });

  it("records one WARNING when the pause starts, with what Meta said", async () => {
    await pause();
    expect(eventCreate).toHaveBeenCalledTimes(1);
    expect(eventCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace",
        source: "WORKER",
        level: "WARNING",
        message:
          "Instagram request limit reached for @studio: sending paused until 13:20 UTC",
        payload: {
          kind: "meta-pause",
          instagramAccountId: "ig_1",
          account: "studio",
          resumeAt: "2026-11-21T13:20:00.000Z",
          pauseMinutes: 20,
          code: 4,
          block: false,
          error: expect.stringContaining("code=4"),
        },
      },
    });
  });

  it("records nothing more for further refusals while it lasts", async () => {
    await pause();
    vi.setSystemTime(NOW + MINUTE);
    const again = await pause();
    expect(again.started).toBe(false);
    // Extended by the minute that passed, never shortened.
    expect(again.resumeAt).toBe(NOW + 21 * MINUTE);
    expect(eventCreate).toHaveBeenCalledTimes(1);
  });

  it("extends a throttle's pause for a block", async () => {
    await pause(throttle);
    vi.setSystemTime(NOW + 5 * MINUTE);
    const result = await pause(block);
    expect(result).toEqual({ resumeAt: NOW + 65 * MINUTE, started: false });
    expect(fake.pttl("meta:pause:ig_1")).toBe(60 * MINUTE);
  });

  it("never shortens a block's pause for a throttle", async () => {
    await pause(block);
    vi.setSystemTime(NOW + 10 * MINUTE);
    const result = await pause(throttle);
    expect(result).toEqual({ resumeAt: NOW + 60 * MINUTE, started: false });
    await expect(fake.get("meta:pause:ig_1")).resolves.toBe(String(NOW + 60 * MINUTE));
    expect(fake.pttl("meta:pause:ig_1")).toBe(50 * MINUTE);
  });

  it("starts a new pause, and records it, once the last one is over", async () => {
    await pause();
    vi.setSystemTime(NOW + 21 * MINUTE);
    const result = await pause();
    expect(result).toEqual({ resumeAt: NOW + 41 * MINUTE, started: true });
    expect(eventCreate).toHaveBeenCalledTimes(2);
  });

  it("pauses each account on its own", async () => {
    await pause();
    const other = await pauseAccountForLimit({
      instagramAccountId: "ig_2",
      workspaceId: "workspace",
      error: throttle,
    });
    expect(other.started).toBe(true);
    await expect(checkAccountPause("ig_2")).resolves.toBe(NOW + 20 * MINUTE);
  });

  it("takes the configured length", async () => {
    vi.stubEnv("META_BLOCK_PAUSE_MINUTES", "90");
    const result = await pause(block);
    expect(result.resumeAt).toBe(NOW + 90 * MINUTE);
  });

  it("still gives the caller a resume time when Redis fails, without an event", async () => {
    redis.current = {
      eval: async () => {
        throw new Error("Connection is closed.");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(pause()).resolves.toEqual({
      resumeAt: NOW + 20 * MINUTE,
      started: false,
    });
    expect(eventCreate).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("keeps going when the event cannot be written", async () => {
    eventCreate.mockRejectedValue(new Error("database down"));
    await expect(pause()).resolves.toMatchObject({ started: true });
  });
});

describe("checking for a pause before calling Meta", () => {
  it("knows no pause for an account that has none", async () => {
    await expect(checkAccountPause("ig_1")).resolves.toBeNull();
  });

  it("returns the resume time while the pause lasts, and nothing after it", async () => {
    await pause();
    await expect(checkAccountPause("ig_1")).resolves.toBe(NOW + 20 * MINUTE);
    vi.setSystemTime(NOW + 20 * MINUTE);
    await expect(checkAccountPause("ig_1")).resolves.toBeNull();
  });

  it("sends as usual when Redis cannot be read", async () => {
    redis.current = {
      get: async () => {
        throw new Error("Connection is closed.");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(checkAccountPause("ig_1")).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("ignores a value that is not a time", async () => {
    await fake.set("meta:pause:ig_1", "garbage", "PX", 60_000);
    await expect(checkAccountPause("ig_1")).resolves.toBeNull();
  });
});

describe("the jitter after a pause", () => {
  it("is the same for the same job", () => {
    expect(pauseJitterMs("comment_ig_c1_pause_1")).toBe(
      pauseJitterMs("comment_ig_c1_pause_1")
    );
  });

  it("stays within a minute and spreads a backlog over it", () => {
    const jitters = Array.from({ length: 300 }, (_, i) =>
      pauseJitterMs(`comment_ig_c${i}_pause_1`)
    );
    for (const jitter of jitters) {
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(PAUSE_JITTER_MS);
    }
    // Not one burst: the backlog covers most of the minute, in many steps.
    expect(Math.max(...jitters) - Math.min(...jitters)).toBeGreaterThan(50_000);
    expect(new Set(jitters.map((j) => Math.floor(j / 1000))).size).toBeGreaterThan(40);
    expect(pausedRunAt(NOW, "x")).toBe(NOW + pauseJitterMs("x"));
  });
});

describe("putting a job back for the pause", () => {
  const data = {
    instagramAccountId: "ig_1",
    commentId: "c1",
    commentText: "LINK",
    commenterId: "person",
    mediaId: "media",
    pauseRequeue: 1,
  };

  it("queues it under its id for the resume time plus its jitter, removed once done", async () => {
    const resumeAt = NOW + 20 * MINUTE;
    const runAt = await requeueForPause({
      name: "process-comment",
      data,
      jobId: "comment_ig_1_c1_pause_1",
      instagramAccountId: "ig_1",
      resumeAt,
    });
    expect(runAt).toBe(resumeAt + pauseJitterMs("comment_ig_1_c1_pause_1"));
    expect(queueAdd).toHaveBeenCalledWith("process-comment", data, {
      jobId: "comment_ig_1_c1_pause_1",
      delay: runAt - NOW,
      removeOnComplete: true,
    });
  });

  it("counts the jobs that wait, until each has run", async () => {
    await requeueForPause({
      name: "process-comment",
      data,
      jobId: "a",
      instagramAccountId: "ig_1",
      resumeAt: NOW + 20 * MINUTE,
    });
    await requeueForPause({
      name: "process-comment",
      data,
      jobId: "b",
      instagramAccountId: "ig_1",
      resumeAt: NOW + 20 * MINUTE,
    });
    // The same job twice counts once.
    await requeueForPause({
      name: "process-comment",
      data,
      jobId: "b",
      instagramAccountId: "ig_1",
      resumeAt: NOW + 20 * MINUTE,
    });
    await expect(countPausedJobs("ig_1")).resolves.toBe(2);
    await expect(countPausedJobs("ig_2")).resolves.toBe(0);
    vi.setSystemTime(NOW + 22 * MINUTE);
    await expect(countPausedJobs("ig_1")).resolves.toBe(0);
  });

  it("still queues the job when it cannot be counted", async () => {
    redis.current = {
      pipeline: () => {
        throw new Error("Connection is closed.");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await requeueForPause({
      name: "process-comment",
      data,
      jobId: "a",
      instagramAccountId: "ig_1",
      resumeAt: NOW,
    });
    expect(queueAdd).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("caps the waits at twelve, about four hours of throttles", () => {
    expect(MAX_PAUSE_REQUEUES).toBe(12);
  });
});

describe("what Diagnostics shows", () => {
  it("lists only the paused accounts, until when and how many jobs wait", async () => {
    await pause();
    await requeueForPause({
      name: "process-comment",
      data: {
        instagramAccountId: "ig_1",
        commentId: "c1",
        commentText: "LINK",
        commenterId: "person",
        mediaId: "media",
      },
      jobId: "comment_ig_1_c1_pause_1",
      instagramAccountId: "ig_1",
      resumeAt: NOW + 20 * MINUTE,
    });
    await expect(
      readAccountPauses([
        { instagramId: "ig_1", username: "studio" },
        { instagramId: "ig_2", username: "other" },
      ])
    ).resolves.toEqual([
      { username: "studio", resumeAt: "2026-11-21T13:20:00.000Z", waiting: 1 },
    ]);
  });
});
