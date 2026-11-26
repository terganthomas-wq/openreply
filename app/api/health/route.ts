import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import {
  connectionLostCode,
  connectionLostKind,
} from "@/lib/instagram/connection-incident";

export const runtime = "nodejs";
// Health must reflect live state (worker heartbeat, queue depth), never a
// cached response, or it reports stale worker start times.
export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "error";

interface HealthCheck {
  status: CheckStatus;
  detail?: string;
}

async function checkDatabase(): Promise<HealthCheck> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Database check failed",
    };
  }
}

async function checkRedis(): Promise<HealthCheck> {
  try {
    const pong = await getRedisConnection().ping();
    return { status: pong === "PONG" ? "ok" : "error", detail: pong };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Redis check failed",
    };
  }
}

// A fresh heartbeat does not mean the worker is still doing anything. The
// heartbeat runs on its own interval, so BullMQ's consumer can stop taking jobs
// — a dropped queue connection, a crashed consumer loop — while the process,
// and its heartbeat, stay perfectly alive. Health then keeps answering 200
// while the backlog grows and nobody is served. Seen in production: 385 jobs
// waiting for hours behind an uptime monitor that never once alerted.
//
// A backlog with nothing in flight is the signal, and it is unambiguous: a
// healthy worker with a concurrency of 5 never leaves jobs waiting with zero
// active. The threshold only exists to ride out the moment between a job being
// enqueued and the worker picking it up.
const STUCK_QUEUE_MIN_WAITING = Number(
  process.env.HEALTH_STUCK_QUEUE_WAITING ?? 25
);

async function checkQueue(): Promise<HealthCheck & { counts?: unknown }> {
  try {
    const counts = await getDMQueue().getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed"
    );
    const waiting = counts.waiting ?? 0;
    const active = counts.active ?? 0;
    if (waiting >= STUCK_QUEUE_MIN_WAITING && active === 0) {
      return {
        status: "error",
        detail: `${waiting} jobs waiting with none active — the worker is not consuming`,
        counts,
      };
    }
    return { status: "ok", counts };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Queue check failed",
    };
  }
}

// A1: Instagram accounts whose connection Meta dropped (the worker's check,
// lib/instagram/connection-check.ts). Degraded while any incident is open,
// but it never changes the HTTP status or the top-level status: an external
// monitor would flap with every incident, and the owners get an e-mail and
// the dashboard's banner anyway. A monitor that wants to know reads
// checks.instagram.status.
interface InstagramConnectionCheck {
  status: "ok" | "degraded" | "error";
  incidents?: {
    account: string;
    lostAt: string;
    reason: string;
    code: string | null;
    alertSentAt: string | null;
  }[];
  detail?: string;
}

async function checkInstagramConnections(): Promise<InstagramConnectionCheck> {
  try {
    const lost = await prisma.instagramAccount.findMany({
      where: { connectionLostAt: { not: null } },
      orderBy: { connectionLostAt: "asc" },
      take: 50,
      select: {
        username: true,
        connectionLostAt: true,
        connectionLostReason: true,
        connectionAlertSentAt: true,
        connectionAlertCount: true,
      },
    });
    if (lost.length === 0) return { status: "ok" };
    return {
      status: "degraded",
      incidents: lost.map((account) => ({
        account: account.username,
        lostAt: account.connectionLostAt!.toISOString(),
        reason: connectionLostKind(account.connectionLostReason),
        code: connectionLostCode(account.connectionLostReason),
        // Only an e-mail about this incident: the time stays from earlier ones.
        alertSentAt:
          account.connectionAlertCount > 0 && account.connectionAlertSentAt
            ? account.connectionAlertSentAt.toISOString()
            : null,
      })),
    };
  } catch (error) {
    return {
      status: "error",
      detail:
        error instanceof Error ? error.message : "Instagram connection check failed",
    };
  }
}

// Health answers only with `Authorization: Bearer <CRON_SECRET>`. Unauthorised
// calls get a 401 before any check runs: the full report names the worker host
// and raw DB/Redis errors, and every check wakes the database and spends Redis
// operations, which matters on free tiers that meter compute time.
function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [database, redis, queue, worker, instagram] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkQueue(),
    getWorkerHealth().catch((error) => ({
      healthy: false,
      heartbeat: null,
      ageMs: null,
      error: error instanceof Error ? error.message : "Worker check failed",
    })),
    checkInstagramConnections(),
  ]);

  // Not the Instagram connections: see checkInstagramConnections.
  const healthy =
    database.status === "ok" &&
    redis.status === "ok" &&
    queue.status === "ok" &&
    worker.healthy;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: {
        database,
        redis,
        queue,
        worker,
        instagram,
      },
    },
    { status: healthy ? 200 : 503 }
  );
}
