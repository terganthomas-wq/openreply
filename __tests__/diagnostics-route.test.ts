/**
 * Diagnostics on Meta's request limits (R1): which of the workspace's
 * accounts are paused, until when and how many jobs wait, and what the page
 * needs to show the limit events in the reader's language. Event payloads
 * themselves stay on the server. Also the service keys that need a new one
 * (R1 item 9).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis } from "./helpers/fake-redis";

const { mockPrisma, redis, workspaceContext } = vi.hoisted(() => ({
  mockPrisma: {
    webhookEvent: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { findMany: vi.fn() },
    instagramAccount: { findMany: vi.fn() },
    serviceKey: { findMany: vi.fn() },
  },
  redis: { current: null as unknown },
  workspaceContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
// Keeps next-auth out of the test; the context below stands in for it.
vi.mock("@/lib/auth", () => ({
  getCurrentUserId: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
}));
// The real role check; only the signed-in context is replaced.
vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/workspace-access")>()),
  getCurrentWorkspaceContext: workspaceContext,
}));
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

// A signed-in reader of the workspace, in a role.
function signedIn(role: "OWNER" | "ADMIN" | "MEMBER") {
  return {
    userId: "user",
    workspaceId: "workspace",
    workspace: { id: "workspace" },
    role,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = new FakeRedis();
  redis.current = fake;
  workspaceContext.mockReset().mockResolvedValue(signedIn("OWNER"));
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
      select: {
        instagramId: true,
        username: true,
        // A1: the lost-connection incident of each account.
        connectionLostAt: true,
        connectionLostReason: true,
        connectionAlertSentAt: true,
        connectionAlertCount: true,
      },
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
    workspaceContext.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(mockPrisma.serviceKey.findMany).not.toHaveBeenCalled();
  });
});

// A1: accounts whose connection Meta dropped, from the worker's check.
describe("Diagnostics and a lost Instagram connection", () => {
  it("lists no incident while every connection works", async () => {
    expect((await diagnostics()).connectionIncidents).toEqual([]);
  });

  it("lists each open incident: since when, why, Meta's code and the e-mail", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      {
        instagramId: "ig_1",
        username: "studio",
        connectionLostAt: new Date("2026-11-21T11:45:00.000Z"),
        connectionLostReason: "missing (Meta 100/33)",
        connectionAlertSentAt: new Date("2026-11-21T12:15:00.000Z"),
        connectionAlertCount: 1,
      },
      {
        instagramId: "ig_2",
        username: "other",
        connectionLostAt: new Date("2026-11-21T12:30:00.000Z"),
        connectionLostReason: "token (Meta 190)",
        // An e-mail about an earlier incident: none about this one yet.
        connectionAlertSentAt: new Date("2026-11-21T02:00:00.000Z"),
        connectionAlertCount: 0,
      },
      {
        instagramId: "ig_3",
        username: "fine",
        connectionLostAt: null,
        connectionLostReason: null,
        connectionAlertSentAt: null,
        connectionAlertCount: 0,
      },
    ]);

    const data = await diagnostics();
    expect(data.connectionIncidents).toEqual([
      {
        username: "studio",
        since: "2026-11-21T11:45:00.000Z",
        reason: "missing",
        code: "Meta 100/33",
        alertSentAt: "2026-11-21T12:15:00.000Z",
      },
      {
        username: "other",
        since: "2026-11-21T12:30:00.000Z",
        reason: "token",
        code: "Meta 190",
        alertSentAt: null,
      },
    ]);
    expect(JSON.stringify(data.connectionIncidents)).not.toContain("ig_");
  });

  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["MEMBER", false],
  ] as const)("tells whether a reader with the role %s can reconnect", async (role, canReconnect) => {
    workspaceContext.mockResolvedValue(signedIn(role));
    expect((await diagnostics()).canReconnect).toBe(canReconnect);
  });

  it("hands the page what it needs to name the connection events", async () => {
    mockPrisma.operationalEvent.findMany.mockResolvedValue([
      {
        id: "e1",
        source: "WORKER",
        level: "WARNING",
        message: "Instagram connection lost for @studio since 2026-11-21T11:45:00.000Z (missing (Meta 100/33)): …",
        createdAt: new Date(NOW),
        resolvedAt: null,
        payload: {
          kind: "connection-lost",
          instagramAccountId: "ig_1",
          account: "studio",
          lostAt: "2026-11-21T11:45:00.000Z",
          reason: "missing (Meta 100/33)",
        },
      },
    ]);
    const { operationalEvents } = await diagnostics();
    expect(operationalEvents[0].detail).toEqual({
      kind: "connection-lost",
      account: "studio",
      lostAt: "2026-11-21T11:45:00.000Z",
    });
    expect(JSON.stringify(operationalEvents)).not.toContain("ig_1");
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

  // Every member sees Diagnostics, but only owners and admins may create and
  // revoke keys: the notice asks a member to have one of them do it.
  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["MEMBER", false],
  ] as const)("tells whether a reader with the role %s can replace a key", async (role, canManage) => {
    workspaceContext.mockResolvedValue(signedIn(role));
    mockPrisma.serviceKey.findMany.mockResolvedValue([
      { id: "k1", name: "Landingpage", scopes: ["signups:write"], expiresAt: at(5), revokedAt: null, lastUsedAt: null },
    ]);

    const data = await diagnostics();

    expect(data.canManageKeys).toBe(canManage);
    // The warning itself is the same for everyone.
    expect(data.keyWarnings).toHaveLength(1);
    expect(mockPrisma.serviceKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: "workspace" }) })
    );
  });
});
