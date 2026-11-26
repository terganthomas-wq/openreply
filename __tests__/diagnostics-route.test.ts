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
        id: true,
        instagramId: true,
        username: true,
        // A1: the lost-connection incident of each account.
        connectionLostAt: true,
        connectionLostReason: true,
        connectionAlertSentAt: true,
        connectionAlertCount: true,
        // A1: its catch-up, running or finished.
        connectionCatchUpFrom: true,
        connectionCatchUpResult: true,
        // A2: the messaging silence, open or ended, and the search for its
        // lost taps.
        messagingSilentSince: true,
        messagingAlertSentAt: true,
        messagingAlertCount: true,
        messagingSilenceResult: true,
        messagingTapSearchFrom: true,
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

  it("shows the catch-up after an incident: running, or finished in the last 7 days with the comments answered by hand", async () => {
    const answered = {
      commentId: "c_anna",
      username: "anna",
      text: "Guide bitte",
      timestamp: "2026-11-21T10:02:00.000Z",
      permalink: "https://www.instagram.com/p/p1/",
    };
    const finished = (finishedAt: string) => ({
      v: 1,
      lostAt: "2026-11-21T09:45:00.000Z",
      recoveredAt: "2026-11-21T11:50:00.000Z",
      finishedAt,
      since: "2026-11-21T09:00:00.000Z",
      queued: 2,
      firstJobAt: null,
      lastJobAt: null,
      ownerAnswered: [answered],
      ownerAnsweredTotal: 1,
      posts: 30,
      pages: 30,
      skipped: {},
    });
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      {
        id: "a1",
        instagramId: "ig_1",
        username: "studio",
        connectionLostAt: null,
        connectionCatchUpFrom: null,
        connectionCatchUpResult: finished("2026-11-21T12:05:00.000Z"),
      },
      {
        id: "a2",
        instagramId: "ig_2",
        username: "running",
        connectionLostAt: null,
        connectionCatchUpFrom: new Date("2026-11-21T12:00:00.000Z"),
        connectionCatchUpResult: null,
      },
      {
        id: "a3",
        instagramId: "ig_3",
        username: "old",
        connectionLostAt: null,
        connectionCatchUpFrom: null,
        connectionCatchUpResult: finished("2026-11-10T12:05:00.000Z"),
      },
    ]);

    const { connectionCatchUps } = await diagnostics();
    expect(connectionCatchUps).toEqual([
      {
        accountId: "a1",
        username: "studio",
        running: false,
        last: {
          lostAt: "2026-11-21T09:45:00.000Z",
          recoveredAt: "2026-11-21T11:50:00.000Z",
          finishedAt: "2026-11-21T12:05:00.000Z",
          queued: 2,
          ownerAnswered: [answered],
          ownerAnsweredTotal: 1,
          complete: true,
        },
      },
      { accountId: "a2", username: "running", running: true, last: null },
    ]);
    expect(JSON.stringify(connectionCatchUps)).not.toContain("ig_");
  });
});

// A2: accounts whose button taps, DMs and read receipts do not arrive.
describe("Diagnostics and a messaging silence", () => {
  it("lists no silence while messaging events arrive", async () => {
    const data = await diagnostics();
    expect(data.messagingSilences).toEqual([]);
    expect(data.endedMessagingSilences).toEqual([]);
  });

  it("lists each open silence since when and whether the e-mail went out, not one a lost connection covers", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      {
        id: "a1",
        instagramId: "ig_1",
        username: "studio",
        connectionLostAt: null,
        messagingSilentSince: new Date("2026-11-20T13:15:16.000Z"),
        messagingAlertSentAt: new Date("2026-11-21T09:30:00.000Z"),
        messagingAlertCount: 1,
      },
      {
        id: "a2",
        instagramId: "ig_2",
        username: "other",
        connectionLostAt: null,
        messagingSilentSince: new Date("2026-11-21T01:00:00.000Z"),
        // An e-mail about an earlier silence: none about this one yet.
        messagingAlertSentAt: new Date("2026-11-19T09:30:00.000Z"),
        messagingAlertCount: 0,
      },
      {
        id: "a3",
        instagramId: "ig_3",
        username: "lost",
        connectionLostAt: new Date("2026-11-21T12:00:00.000Z"),
        connectionLostReason: "missing (Meta 100/33)",
        connectionAlertCount: 0,
        messagingSilentSince: new Date("2026-11-21T02:00:00.000Z"),
        messagingAlertCount: 0,
      },
    ]);

    const data = await diagnostics();
    expect(data.messagingSilences).toEqual([
      {
        username: "studio",
        since: "2026-11-20T13:15:16.000Z",
        alertSentAt: "2026-11-21T09:30:00.000Z",
      },
      { username: "other", since: "2026-11-21T01:00:00.000Z", alertSentAt: null },
    ]);
    expect(data.connectionIncidents.map((incident: { username: string }) => incident.username)).toEqual(["lost"]);
    expect(JSON.stringify(data.messagingSilences)).not.toContain("ig_");
  });

  it("shows the last silence for 7 days after it ended", async () => {
    const ended = (endedAt: string) => ({
      v: 1,
      since: "2026-11-19T13:15:16.000Z",
      endedAt,
      via: "webhook",
    });
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "a1", instagramId: "ig_1", username: "studio", messagingSilentSince: null, messagingSilenceResult: ended("2026-11-20T10:30:57.000Z") },
      { id: "a2", instagramId: "ig_2", username: "old", messagingSilentSince: null, messagingSilenceResult: ended("2026-11-10T10:30:57.000Z") },
      // Silent again: the open silence is what to show.
      { id: "a3", instagramId: "ig_3", username: "again", messagingSilentSince: new Date("2026-11-21T01:00:00.000Z"), messagingSilenceResult: ended("2026-11-20T10:30:57.000Z") },
      { id: "a4", instagramId: "ig_4", username: "unreadable", messagingSilentSince: null, messagingSilenceResult: { v: 2 } },
    ]);

    expect((await diagnostics()).endedMessagingSilences).toEqual([
      {
        accountId: "a1",
        username: "studio",
        since: "2026-11-19T13:15:16.000Z",
        endedAt: "2026-11-20T10:30:57.000Z",
        earlier: [],
        searching: false,
        taps: null,
      },
    ]);
  });

  it("shows the search for lost taps after it: running, then what it found, with names and never an id", async () => {
    const result = {
      v: 1,
      since: "2026-11-20T13:15:16.000Z",
      endedAt: "2026-11-21T10:30:57.000Z",
      via: "webhook",
    };
    const taps = {
      v: 1,
      finishedAt: "2026-11-21T10:40:00.000Z",
      people: 4,
      continued: 1,
      firstJobAt: "2026-11-21T10:40:00.000Z",
      lastJobAt: "2026-11-21T10:40:00.000Z",
      listed: [
        { username: "gerd", campaign: "Guide", tappedAt: "2026-11-20T13:21:00.000Z", reason: "window" },
      ],
      noTap: 2,
      answered: 0,
      notChecked: 0,
      reads: 3,
      gaveUp: false,
      complete: true,
    };
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      {
        id: "a1",
        instagramId: "ig_1",
        username: "studio",
        messagingSilentSince: null,
        messagingSilenceResult: result,
        messagingTapSearchFrom: new Date(result.since),
      },
      {
        id: "a2",
        instagramId: "ig_2",
        username: "other",
        messagingSilentSince: null,
        messagingSilenceResult: { ...result, taps },
        messagingTapSearchFrom: null,
      },
    ]);
    const { endedMessagingSilences } = await diagnostics();
    expect(endedMessagingSilences).toEqual([
      { accountId: "a1", username: "studio", since: result.since, endedAt: result.endedAt, earlier: [], searching: true, taps: null },
      { accountId: "a2", username: "other", since: result.since, endedAt: result.endedAt, earlier: [], searching: false, taps },
    ]);
    expect(JSON.stringify(endedMessagingSilences)).not.toContain("ig_");
  });

  it("hands the page what it needs to name the silence events", async () => {
    mockPrisma.operationalEvent.findMany.mockResolvedValue([
      {
        id: "e1",
        source: "WORKER",
        level: "WARNING",
        message: "Instagram passes on no button taps, DMs or read receipts for @studio since …",
        createdAt: new Date(NOW),
        resolvedAt: null,
        payload: {
          kind: "messaging-silent",
          instagramAccountId: "ig_1",
          account: "studio",
          since: "2026-11-20T13:15:16.000Z",
          firstDmAt: "2026-11-20T20:49:23.000Z",
          people: 3,
        },
      },
      {
        id: "e2",
        source: "SYSTEM",
        level: "INFO",
        message: "Instagram passes on button taps, DMs and read receipts for @studio again …",
        createdAt: new Date(NOW),
        resolvedAt: null,
        payload: { kind: "messaging-back", account: "studio", since: "2026-11-20T13:15:16.000Z", via: "webhook" },
      },
      {
        id: "e3",
        source: "WORKER",
        level: "INFO",
        message: "Messaging silence alert e-mail for @studio sent to 2 people (resend)",
        createdAt: new Date(NOW),
        resolvedAt: null,
        payload: { kind: "messaging-alert", account: "studio", reminder: false, recipients: 2 },
      },
      {
        id: "e4",
        source: "WORKER",
        level: "INFO",
        message: "Messaging all-clear e-mail for @studio sent to 2 people (resend)",
        createdAt: new Date(NOW),
        resolvedAt: null,
        payload: { kind: "messaging-all-clear", account: "studio", recipients: 2 },
      },
    ]);
    const { operationalEvents } = await diagnostics();
    expect(operationalEvents.map((event: { detail: unknown }) => event.detail)).toEqual([
      { kind: "messaging-silent", account: "studio", since: "2026-11-20T13:15:16.000Z" },
      { kind: "messaging-back", account: "studio" },
      { kind: "messaging-alert", account: "studio", recipients: 2, reminder: false },
      { kind: "messaging-all-clear", account: "studio", recipients: 2 },
    ]);
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
