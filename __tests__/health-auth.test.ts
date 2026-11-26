/**
 * Health endpoint — access control
 *
 * /api/health only reports with `Authorization: Bearer <CRON_SECRET>`, and an
 * unauthorised call must not run any check (no database wake-up, no Redis ops).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const queryRaw = vi.fn();
const findLostAccounts = vi.fn();
const ping = vi.fn();
const getJobCounts = vi.fn();
const getWorkerHealth = vi.fn();

vi.mock("@/lib/db/client", () => ({
  prisma: { $queryRaw: queryRaw, instagramAccount: { findMany: findLostAccounts } },
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({ ping }),
  getDMQueue: () => ({ getJobCounts }),
}));
vi.mock("@/lib/ops/worker-health", () => ({ getWorkerHealth }));

const { GET } = await import("../app/api/health/route");

function request(authorization?: string): Request {
  return new Request("https://example.test/api/health", {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "health-test-secret");
  queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  ping.mockResolvedValue("PONG");
  getJobCounts.mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 0 });
  getWorkerHealth.mockResolvedValue({ healthy: true, heartbeat: null, ageMs: 1000 });
  findLostAccounts.mockResolvedValue([]);
});

describe("GET /api/health", () => {
  it("rejects a call without credentials and runs no check", async () => {
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(findLostAccounts).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
    expect(getWorkerHealth).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    const response = await GET(request("Bearer wrong"));
    expect(response.status).toBe(401);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("rejects everything when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await GET(request("Bearer "));
    expect(response.status).toBe(401);
  });

  it("reports the full status with the right secret", async () => {
    const response = await GET(request("Bearer health-test-secret"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.checks.worker.healthy).toBe(true);
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it("answers 503 when the worker heartbeat is missing", async () => {
    getWorkerHealth.mockResolvedValue({ healthy: false, heartbeat: null, ageMs: null });
    const response = await GET(request("Bearer health-test-secret"));
    expect(response.status).toBe(503);
    expect((await response.json()).status).toBe("degraded");
  });
});

// A1: a lost Instagram connection is a degraded check in the JSON, never a
// change of the HTTP status or the top-level status.
describe("GET /api/health and a lost Instagram connection", () => {
  const lostAccount = {
    username: "thomas.tergan",
    connectionLostAt: new Date("2026-11-25T16:45:00.000Z"),
    connectionLostReason: "missing (Meta 100/33)",
    connectionAlertSentAt: new Date("2026-11-25T17:15:00.000Z"),
    connectionAlertCount: 1,
  };

  it("reports the Instagram connections as ok while none is lost", async () => {
    const body = await (await GET(request("Bearer health-test-secret"))).json();
    expect(body.checks.instagram).toEqual({ status: "ok" });
    // One query for both: A1's lost connections and A2's silences.
    expect(findLostAccounts).toHaveBeenCalledWith({
      where: {
        OR: [{ connectionLostAt: { not: null } }, { messagingSilentSince: { not: null } }],
      },
      orderBy: { connectionLostAt: "asc" },
      take: 50,
      select: {
        username: true,
        connectionLostAt: true,
        connectionLostReason: true,
        connectionAlertSentAt: true,
        connectionAlertCount: true,
        messagingSilentSince: true,
        messagingAlertSentAt: true,
        messagingAlertCount: true,
      },
    });
  });

  it("reports an incident as degraded, with 200 and status ok as before", async () => {
    findLostAccounts.mockResolvedValue([
      lostAccount,
      // An e-mail about an earlier incident: none about this one yet.
      { ...lostAccount, username: "second", connectionAlertCount: 0 },
    ]);
    const response = await GET(request("Bearer health-test-secret"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.checks.instagram).toEqual({
      status: "degraded",
      incidents: [
        {
          account: "thomas.tergan",
          lostAt: "2026-11-25T16:45:00.000Z",
          reason: "missing",
          code: "Meta 100/33",
          alertSentAt: "2026-11-25T17:15:00.000Z",
        },
        {
          account: "second",
          lostAt: "2026-11-25T16:45:00.000Z",
          reason: "missing",
          code: "Meta 100/33",
          alertSentAt: null,
        },
      ],
    });
  });

  it("keeps 503 for a missing worker, incident or not", async () => {
    findLostAccounts.mockResolvedValue([lostAccount]);
    getWorkerHealth.mockResolvedValue({ healthy: false, heartbeat: null, ageMs: null });
    const response = await GET(request("Bearer health-test-secret"));
    expect(response.status).toBe(503);
    expect((await response.json()).checks.instagram.status).toBe("degraded");
  });

  it("does not fail health when the incidents cannot be read", async () => {
    findLostAccounts.mockRejectedValue(new Error("relation does not exist"));
    const response = await GET(request("Bearer health-test-secret"));
    expect(response.status).toBe(200);
    expect((await response.json()).checks.instagram).toEqual({
      status: "error",
      detail: "relation does not exist",
    });
  });
});

// A2: Instagram passing on no button taps, DMs or read receipts is degraded
// with its own reason, the same way: never a change of the HTTP status.
describe("GET /api/health and a messaging silence", () => {
  const silentAccount = {
    username: "thomas.tergan",
    connectionLostAt: null,
    connectionLostReason: null,
    connectionAlertSentAt: null,
    connectionAlertCount: 0,
    messagingSilentSince: new Date("2026-11-25T13:15:16.000Z"),
    messagingAlertSentAt: new Date("2026-11-26T09:30:00.000Z"),
    messagingAlertCount: 1,
  };

  it("reports a silence as degraded with its own reason, with 200 and status ok as before", async () => {
    findLostAccounts.mockResolvedValue([
      silentAccount,
      // An e-mail about an earlier silence: none about this one yet.
      { ...silentAccount, username: "second", messagingAlertCount: 0 },
    ]);
    const response = await GET(request("Bearer health-test-secret"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.checks.instagram).toEqual({
      status: "degraded",
      silences: [
        {
          account: "thomas.tergan",
          since: "2026-11-25T13:15:16.000Z",
          reason: "messaging-silence",
          alertSentAt: "2026-11-26T09:30:00.000Z",
        },
        {
          account: "second",
          since: "2026-11-25T13:15:16.000Z",
          reason: "messaging-silence",
          alertSentAt: null,
        },
      ],
    });
  });

  it("lists a lost connection and a silence each under its own reason", async () => {
    findLostAccounts.mockResolvedValue([
      {
        ...silentAccount,
        username: "lost",
        connectionLostAt: new Date("2026-11-25T16:45:00.000Z"),
        connectionLostReason: "missing (Meta 100/33)",
        messagingSilentSince: null,
        messagingAlertCount: 0,
      },
      silentAccount,
    ]);
    const body = await (await GET(request("Bearer health-test-secret"))).json();
    expect(body.checks.instagram.status).toBe("degraded");
    expect(body.checks.instagram.incidents).toEqual([
      {
        account: "lost",
        lostAt: "2026-11-25T16:45:00.000Z",
        reason: "missing",
        code: "Meta 100/33",
        alertSentAt: null,
      },
    ]);
    expect(body.checks.instagram.silences).toEqual([
      expect.objectContaining({ account: "thomas.tergan", reason: "messaging-silence" }),
    ]);
  });
});
