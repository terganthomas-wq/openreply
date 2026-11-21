/**
 * Diagnostics on Meta's request limits (R1): which of the workspace's
 * accounts are paused, until when and how many jobs wait, and what the page
 * needs to show the limit events in the reader's language. Event payloads
 * themselves stay on the server. Also the service keys that need a new one
 * (R1 item 9).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis } from "./helpers/fake-redis";

const { mockPrisma, redis, workspaceId } = vi.hoisted(() => ({
  mockPrisma: {
    webhookEvent: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { findMany: vi.fn() },
    instagramAccount: { findMany: vi.fn() },
    serviceKey: { findMany: vi.fn() },
  },
  redis: { current: null as unknown },
  workspaceId: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: workspaceId }));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => redis.current,
  getDMQueue: () => ({
    getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 2, failed: 0 }),
  }),
}));
vi.mock("@/lib/ops/worker-health", () => ({
  getWorkerHealth: async () => ({ healthy: true, heartbeat: null, ageMs: 1000 }),
  getWorkerAlerts: async () => [],
}));

import { GET } from "../app/api/admin/diagnostics/route";

const NOW = new Date("2026-11-21T13:00:00.000Z").getTime();
let fake: FakeRedis;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = new FakeRedis();
  redis.current = fake;
  workspaceId.mockReset().mockResolvedValue("workspace");
  mockPrisma.webhookEvent.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.dmLog.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.operationalEvent.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.instagramAccount.findMany.mockReset().mockResolvedValue([
    { instagramId: "ig_1", username: "studio" },
    { instagramId: "ig_2", username: "other" },
  ]);
  mockPrisma.serviceKey.findMany.mockReset().mockResolvedValue([]);
});

async function diagnostics() {
  const response = await GET();
  return (await response.json()).data;
}

describe("Diagnostics and Meta's request limits", () => {
  it("shows no pause when no account is paused", async () => {
    expect((await diagnostics()).accountPauses).toEqual([]);
  });

  it("shows the paused account of this workspace, until when and how many jobs wait", async () => {
    await fake.set("meta:pause:ig_1", String(NOW + 20 * 60_000), "PX", 20 * 60_000);
    await fake
      .pipeline()
      .zadd("meta:paused-jobs:ig_1", NOW + 20 * 60_000 + 5_000, "comment_ig_1_c1_pause_1")
      .zadd("meta:paused-jobs:ig_1", NOW + 20 * 60_000 + 9_000, "comment_ig_1_c2_pause_1")
      .exec();

    expect((await diagnostics()).accountPauses).toEqual([
      { username: "studio", resumeAt: "2026-11-21T13:20:00.000Z", waiting: 2 },
    ]);
    expect(mockPrisma.instagramAccount.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace" },
      select: { instagramId: true, username: true },
    });
  });

  it("hands the page what it needs to translate a limit event, never the payload", async () => {
    mockPrisma.operationalEvent.findMany.mockResolvedValue([
      {
        id: "e1",
        source: "WORKER",
        level: "WARNING",
        message: "Instagram request limit reached for @studio: sending paused until 13:20 UTC",
        createdAt: new Date(NOW),
        resolvedAt: null,
        payload: {
          kind: "meta-pause",
          instagramAccountId: "ig_1",
          account: "studio",
          resumeAt: "2026-11-21T13:20:00.000Z",
          error: "RateLimitError 4: (#4) Application request limit reached",
        },
      },
      {
        id: "e2",
        source: "WORKER",
        level: "INFO",
        message: "Offer skipped: messaging window closed",
        createdAt: new Date(NOW),
        resolvedAt: null,
        payload: { automationId: "a", userId: "person" },
      },
    ]);

    const { operationalEvents } = await diagnostics();

    expect(operationalEvents).toEqual([
      {
        id: "e1",
        source: "WORKER",
        level: "WARNING",
        message: "Instagram request limit reached for @studio: sending paused until 13:20 UTC",
        createdAt: "2026-11-21T13:00:00.000Z",
        resolvedAt: null,
        detail: {
          kind: "meta-pause",
          resumeAt: "2026-11-21T13:20:00.000Z",
          account: "studio",
        },
      },
      {
        id: "e2",
        source: "WORKER",
        level: "INFO",
        message: "Offer skipped: messaging window closed",
        createdAt: "2026-11-21T13:00:00.000Z",
        resolvedAt: null,
        detail: null,
      },
    ]);
    expect(JSON.stringify(operationalEvents)).not.toContain("person");
  });

  it("still answers when Redis cannot be read", async () => {
    redis.current = {
      get: async () => {
        throw new Error("Connection is closed.");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await diagnostics()).accountPauses).toEqual([]);
    error.mockRestore();
  });

  it("refuses without a workspace", async () => {
    workspaceId.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(mockPrisma.serviceKey.findMany).not.toHaveBeenCalled();
  });
});

describe("Diagnostics and expiring service keys", () => {
  const DAY = 86_400_000;
  const at = (days: number) => new Date(NOW + days * DAY);

  it("shows no key when none needs a new one", async () => {
    expect((await diagnostics()).keyWarnings).toEqual([]);
  });

  it("asks for this workspace's unrevoked keys that expire within 14 days or expired while in use", async () => {
    await diagnostics();

    expect(mockPrisma.serviceKey.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace",
        revokedAt: null,
        OR: [
          { expiresAt: { gt: at(0), lte: at(14) } },
          { expiresAt: { lte: at(0) }, lastUsedAt: { gte: at(-30) } },
        ],
      },
      orderBy: { expiresAt: "asc" },
      take: 20,
      select: {
        id: true,
        name: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    });
  });

  it("names each key, its kind, its expiry and why, never when it was used", async () => {
    mockPrisma.serviceKey.findMany.mockResolvedValue([
      { id: "k1", name: "Landingpage", scopes: ["signups:write"], expiresAt: at(-2), revokedAt: null, lastUsedAt: at(-3) },
      { id: "k2", name: "Claude", scopes: ["campaigns:read"], expiresAt: at(5), revokedAt: null, lastUsedAt: null },
      // Read in a race with its revocation, or out of bounds: left out.
      { id: "k3", name: "Old", scopes: ["campaigns:read"], expiresAt: at(-40), revokedAt: null, lastUsedAt: at(-41) },
    ]);

    const { keyWarnings } = await diagnostics();

    expect(keyWarnings).toEqual([
      { id: "k1", name: "Landingpage", scopes: ["signups:write"], expiresAt: at(-2).toISOString(), warning: "expired" },
      { id: "k2", name: "Claude", scopes: ["campaigns:read"], expiresAt: at(5).toISOString(), warning: "expiring" },
    ]);
    expect(JSON.stringify(keyWarnings)).not.toContain("lastUsedAt");
  });
});
