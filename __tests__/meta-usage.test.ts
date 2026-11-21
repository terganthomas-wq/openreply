/**
 * The warning before Meta's request limit (R1): from 80 % of any limit a
 * WARNING with the percentages, at most once per 10 minutes per account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis } from "./helpers/fake-redis";

const { redis, eventCreate, accountFind } = vi.hoisted(() => ({
  redis: { current: null as unknown },
  eventCreate: vi.fn(),
  accountFind: vi.fn(),
}));

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => redis.current,
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    operationalEvent: { create: eventCreate },
    instagramAccount: { findUnique: accountFind },
  },
}));

import { sendDirectMessage } from "../lib/meta/client";
import { eventDetail } from "../lib/ops/event-details";
import {
  reportMetaUsage,
  resetMetaUsageWarnings,
  startMetaUsageReports,
} from "../lib/ops/meta-usage";
import { observeMetaUsage, type MetaUsage } from "../lib/meta/usage";

const NOW = new Date("2026-11-21T13:00:00.000Z").getTime();
const MINUTE = 60_000;
let fake: FakeRedis;

const usage = (callCount: number, business: MetaUsage["business"] = []): MetaUsage => ({
  app: { callCount, totalCputime: 12, totalTime: 30 },
  business,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = new FakeRedis();
  redis.current = fake;
  eventCreate.mockReset().mockResolvedValue({});
  accountFind.mockReset().mockResolvedValue({
    workspaceId: "workspace",
    username: "studio",
  });
  resetMetaUsageWarnings();
});

afterEach(() => {
  observeMetaUsage(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the usage warning", () => {
  it("stays quiet below 80 %", async () => {
    await expect(
      reportMetaUsage({ usage: usage(79.9), instagramId: "ig_1" })
    ).resolves.toBe(false);
    expect(eventCreate).not.toHaveBeenCalled();
    expect(fake.commands).toEqual([]);
  });

  it("records a WARNING with the percentages from 80 % on", async () => {
    await expect(
      reportMetaUsage({
        usage: usage(85, [
          {
            id: "ig_1",
            type: "instagram",
            callCount: 3,
            totalCputime: 1,
            totalTime: 2,
            estimatedTimeToRegainAccess: 0,
          },
        ]),
        instagramId: "ig_1",
      })
    ).resolves.toBe(true);
    expect(eventCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace",
        source: "WORKER",
        level: "WARNING",
        message:
          "Instagram request usage at 85 % for @studio (app: calls 85 %, CPU 12 %, time 30 %; instagram ig_1: calls 3 %, CPU 1 %, time 2 %); from 100 % on Meta refuses messages",
        payload: {
          kind: "meta-usage",
          instagramAccountId: "ig_1",
          account: "studio",
          highestPercent: 85,
          app: { callCount: 85, totalCputime: 12, totalTime: 30 },
          business: [
            {
              id: "ig_1",
              type: "instagram",
              callCount: 3,
              totalCputime: 1,
              totalTime: 2,
              estimatedTimeToRegainAccess: 0,
            },
          ],
        },
      },
    });
  });

  it("counts any share of any limit, the business use case too", async () => {
    await expect(
      reportMetaUsage({
        usage: {
          app: null,
          business: [{ id: "ig_1", totalCputime: 92 }],
        },
        instagramId: "ig_1",
      })
    ).resolves.toBe(true);
  });

  it("warns at most once per 10 minutes per account", async () => {
    await reportMetaUsage({ usage: usage(85), instagramId: "ig_1" });
    vi.setSystemTime(NOW + 9 * MINUTE);
    await expect(
      reportMetaUsage({ usage: usage(95), instagramId: "ig_1" })
    ).resolves.toBe(false);
    // Another account has its own warning.
    await expect(
      reportMetaUsage({ usage: usage(95), instagramId: "ig_2" })
    ).resolves.toBe(true);
    vi.setSystemTime(NOW + 10 * MINUTE);
    await expect(
      reportMetaUsage({ usage: usage(95), instagramId: "ig_1" })
    ).resolves.toBe(true);
    expect(eventCreate).toHaveBeenCalledTimes(3);
  });

  it("leaves the warning to the process that recorded it first", async () => {
    // Another worker process warned a minute ago (Redis remembers it).
    await fake.set("meta:usage-warning:ig_1", "x", "PX", 10 * MINUTE);
    await expect(
      reportMetaUsage({ usage: usage(85), instagramId: "ig_1" })
    ).resolves.toBe(false);
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("names no account and no account ids when the account is not known here", async () => {
    accountFind.mockResolvedValue(null);
    await reportMetaUsage({
      usage: usage(90, [{ id: "foreign", callCount: 90 }]),
      instagramId: "foreign",
    });
    const { data } = eventCreate.mock.calls[0][0];
    expect(data.workspaceId).toBeNull();
    expect(data.payload.instagramAccountId).toBeNull();
    expect(data.payload.business[0].id).toBeNull();
    expect(data.message).not.toContain("foreign");
  });

  it("gives Diagnostics what it needs to translate the warning", async () => {
    await reportMetaUsage({ usage: usage(85.4), instagramId: "ig_1" });
    expect(eventDetail(eventCreate.mock.calls[0][0].data.payload)).toEqual({
      kind: "meta-usage",
      percent: 85,
      account: "studio",
    });
  });
});

describe("the worker's usage reports", () => {
  it("record a warning for a Meta response at 80 % or more, never with the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ recipient_id: "u", message_id: "m" }), {
          headers: {
            "x-app-usage": JSON.stringify({
              call_count: 97,
              total_cputime: 10,
              total_time: 10,
            }),
          },
        })
      )
    );
    startMetaUsageReports();

    await sendDirectMessage(
      { accessToken: "secret-token-value", instagramId: "ig_1" },
      "ig_1",
      "person",
      "hi"
    );
    await vi.waitFor(() => expect(eventCreate).toHaveBeenCalledTimes(1));

    const { data } = eventCreate.mock.calls[0][0];
    expect(data.payload.highestPercent).toBe(97);
    expect(JSON.stringify(data)).not.toContain("secret-token-value");
  });

  it("ask nothing of Redis for a response below 80 %", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ recipient_id: "u", message_id: "m" }), {
          headers: { "x-app-usage": JSON.stringify({ call_count: 5 }) },
        })
      )
    );
    startMetaUsageReports();

    await sendDirectMessage({ accessToken: "t", instagramId: "ig_1" }, "ig_1", "p", "hi");

    expect(fake.commands).toEqual([]);
    expect(eventCreate).not.toHaveBeenCalled();
  });
});

describe("events Diagnostics translates", () => {
  it("reads a pause, a usage warning and a stopped sweep", () => {
    expect(
      eventDetail({
        kind: "meta-pause",
        resumeAt: "2026-11-21T13:20:00.000Z",
        account: "studio",
        error: "kept on the server",
      })
    ).toEqual({
      kind: "meta-pause",
      resumeAt: "2026-11-21T13:20:00.000Z",
      account: "studio",
    });
    expect(eventDetail({ kind: "meta-pause", resumeAt: "2026-11-21T13:20:00.000Z" })).toEqual({
      kind: "meta-pause",
      resumeAt: "2026-11-21T13:20:00.000Z",
      account: null,
    });
    expect(eventDetail({ kind: "sweep-limit", account: "studio" })).toEqual({
      kind: "sweep-limit",
      account: "studio",
    });
  });

  it("leaves every other event to its stored message", () => {
    for (const payload of [
      null,
      "text",
      [1, 2],
      {},
      { kind: "other" },
      { kind: "meta-pause" },
      { kind: "meta-pause", resumeAt: "not a time" },
      { kind: "meta-usage", highestPercent: "85" },
    ]) {
      expect(eventDetail(payload)).toBeNull();
    }
  });
});
