/**
 * Health endpoint — access control
 *
 * /api/health only reports with `Authorization: Bearer <CRON_SECRET>`, and an
 * unauthorised call must not run any check (no database wake-up, no Redis ops).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const queryRaw = vi.fn();
const ping = vi.fn();
const getJobCounts = vi.fn();
const getWorkerHealth = vi.fn();

vi.mock("@/lib/db/client", () => ({ prisma: { $queryRaw: queryRaw } }));
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
});

describe("GET /api/health", () => {
  it("rejects a call without credentials and runs no check", async () => {
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(queryRaw).not.toHaveBeenCalled();
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
