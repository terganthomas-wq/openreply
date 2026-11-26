import { MANUAL_SEND_FEATURE } from "@/lib/comments/manual";
import { getRedisConnection } from "@/lib/queue/client";

const WORKER_HEALTH_KEY = "health:worker:dm";
const WORKER_ALERTS_KEY = "alerts:worker:dm";
const WORKER_HEARTBEAT_TTL_SECONDS = 120;

/**
 * What this worker can do beyond what every worker before it could, named in
 * its heartbeat. The web app and the worker are updated one after the other
 * (deploy/README.de.md, Updates): a feature whose jobs an older worker would
 * misread waits until the running worker names it.
 */
export const WORKER_FEATURES: readonly string[] = [MANUAL_SEND_FEATURE];

export interface WorkerHeartbeat {
  status: "running";
  worker: "dm";
  pid: number;
  hostname?: string;
  startedAt?: string;
  checkedAt: string;
  // Absent in the heartbeat of a worker from before features were named.
  features?: string[];
}

export interface WorkerHealth {
  healthy: boolean;
  heartbeat: WorkerHeartbeat | null;
  ageMs: number | null;
}

export interface WorkerAlert {
  level: "warning" | "error";
  message: string;
  jobId?: string;
  instagramAccountId?: string;
  commentId?: string;
  createdAt: string;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function recordWorkerHeartbeat(
  heartbeat: Omit<WorkerHeartbeat, "checkedAt" | "status" | "worker" | "features">
) {
  const payload: WorkerHeartbeat = {
    ...heartbeat,
    status: "running",
    worker: "dm",
    checkedAt: new Date().toISOString(),
    features: [...WORKER_FEATURES],
  };

  await getRedisConnection().set(
    WORKER_HEALTH_KEY,
    JSON.stringify(payload),
    "EX",
    WORKER_HEARTBEAT_TTL_SECONDS
  );
}

export async function getWorkerHealth(): Promise<WorkerHealth> {
  const heartbeat = parseJson<WorkerHeartbeat>(
    await getRedisConnection().get(WORKER_HEALTH_KEY)
  );

  if (!heartbeat) {
    return { healthy: false, heartbeat: null, ageMs: null };
  }

  const ageMs = Date.now() - new Date(heartbeat.checkedAt).getTime();
  return {
    healthy: ageMs <= WORKER_HEARTBEAT_TTL_SECONDS * 1000,
    heartbeat,
    ageMs,
  };
}

/**
 * Whether the worker that runs right now is one from before `feature`: its
 * heartbeat is fresh and does not name it (WORKER_FEATURES). Without a fresh
 * heartbeat (no worker running, or Redis unreadable) nothing is known: false,
 * and a queued job waits for whichever worker comes next.
 */
export async function runningWorkerLacks(feature: string): Promise<boolean> {
  try {
    const health = await getWorkerHealth();
    return Boolean(
      health.healthy &&
        health.heartbeat &&
        !(health.heartbeat.features ?? []).includes(feature)
    );
  } catch {
    return false;
  }
}

export async function recordWorkerAlert(alert: Omit<WorkerAlert, "createdAt">) {
  const payload: WorkerAlert = {
    ...alert,
    createdAt: new Date().toISOString(),
  };

  const redis = getRedisConnection();
  await redis.lpush(WORKER_ALERTS_KEY, JSON.stringify(payload));
  await redis.ltrim(WORKER_ALERTS_KEY, 0, 24);
}

export async function getWorkerAlerts(limit = 10): Promise<WorkerAlert[]> {
  const values = await getRedisConnection().lrange(
    WORKER_ALERTS_KEY,
    0,
    Math.max(0, limit - 1)
  );

  return values
    .map((value) => parseJson<WorkerAlert>(value))
    .filter((value): value is WorkerAlert => Boolean(value));
}
