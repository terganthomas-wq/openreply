/**
 * The account pause: a circuit breaker for Meta's request limits.
 *
 * When Meta refuses a messaging call of an Instagram account with a request
 * limit (a throttle or a block, lib/instagram/delivery-errors.ts), further
 * calls are refused as well until Meta's rolling window has moved on. Trying
 * again every few minutes only keeps the limit going and uses up retries, so
 * the account pauses instead:
 *
 * - `meta:pause:<instagramId>` (the Instagram business id) holds the resume
 *   time in epoch ms and expires with it. pauseAccountForLimit sets it after
 *   a throttle or a block, or extends it; a pause is never shortened.
 * - Before a messaging call a job asks checkAccountPause. While the account
 *   is paused it does not call Meta and puts itself back on the queue for the
 *   resume time plus up to a minute (requeueForPause). The extra time is
 *   spread by the job's id, so a backlog does not go out in one burst.
 * - Whoever starts a pause records it in Diagnostics, once per pause, not
 *   once per job.
 *
 * The comment path uses these helpers (lib/queue/dm-worker.ts). They are
 * meant for every other messaging path as well: button taps, DM replies,
 * follow-ups and offer messages.
 */

import { createHash } from "node:crypto";
import {
  isMetaBlock,
  isMetaThrottle,
  throttlePauseMs,
} from "@/lib/instagram/delivery-errors";
import { DEFAULT_THROTTLE_PAUSE_MINUTES } from "@/lib/meta/limits";
import { META_PAUSE_EVENT } from "@/lib/ops/event-details";
import { getDMQueue, getRedisConnection, type DmQueueJob } from "./client";
import { formatError, logWorkerEvent } from "./send-helpers";

/** A job waits this much at most after a pause ends, spread by its id. */
export const PAUSE_JITTER_MS = 60_000;

/**
 * How often a job may be put back for a pause before it gives up: 12 waits,
 * about four hours of throttles.
 */
export const MAX_PAUSE_REQUEUES = 12;

// Jobs held back for an account's pause, by the time they run, so Diagnostics
// can say how many wait. The set outlives its last job by a few hours at most.
const WAITING_KEY_TTL_MS = 6 * 60 * 60_000;

/** The Redis key of an account's pause: its resume time in epoch ms. */
export function accountPauseKey(instagramAccountId: string): string {
  return `meta:pause:${instagramAccountId}`;
}

function waitingKey(instagramAccountId: string): string {
  return `meta:paused-jobs:${instagramAccountId}`;
}

// Set or extend a pause in one step, so two jobs refused at the same moment
// cannot shorten each other's pause. KEYS[1] the pause; ARGV[1] the wanted
// resume time, ARGV[2] now, ARGV[3] the milliseconds until ARGV[1]. Returns
// {state, resume time}: 0 a pause that lasts as long or longer stays as it
// is, 1 a pause started, 2 a running pause that would have ended sooner was
// extended.
const PAUSE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
local currentAt = tonumber(current) or 0
if currentAt >= tonumber(ARGV[1]) then
  return {0, current}
end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[3])
if currentAt > tonumber(ARGV[2]) then
  return {2, ARGV[1]}
end
return {1, ARGV[1]}
`;

/** A time for log lines and messages: "14:05 UTC". */
export function formatPauseTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/**
 * The resume time (epoch ms) of the account's pause, or null when its
 * messaging is not paused. Asked before every messaging call. When Redis
 * cannot be read the call goes ahead as it would without the pause, and Meta
 * itself says whether the limit still holds.
 */
export async function checkAccountPause(
  instagramAccountId: string,
  now: number = Date.now()
): Promise<number | null> {
  try {
    const value = await getRedisConnection().get(
      accountPauseKey(instagramAccountId)
    );
    if (value === null || value === undefined) return null;
    const resumeAt = Number(value);
    return Number.isFinite(resumeAt) && resumeAt > now ? resumeAt : null;
  } catch (error) {
    console.error(
      "[Pause] Could not read the account pause, sending as usual:",
      formatError(error)
    );
    return null;
  }
}

export interface AccountPause {
  /** When the account's messaging resumes (epoch ms). */
  resumeAt: number;
  /** This call started the pause, and recorded it. */
  started: boolean;
}

/**
 * Pause the account's messaging after Meta refused a call with a request
 * limit: 20 minutes for a throttle, 60 for a block, or as configured
 * (throttlePauseMs). A pause that lasts longer already stays as it is. The
 * call that starts the pause records one WARNING, "Instagram request limit
 * reached: sending paused until …".
 *
 * Never throws. When Redis cannot be written the pause is not stored, and the
 * resume time is still returned, so the caller's own job waits for it.
 */
export async function pauseAccountForLimit({
  instagramAccountId,
  workspaceId,
  account = null,
  error,
  now = Date.now(),
}: {
  /** The Instagram business id, as in the job data. */
  instagramAccountId: string;
  workspaceId: string | null;
  /** The account's username, for the event. */
  account?: string | null;
  /** What Meta answered: a throttle or a block (isMetaThrottle). */
  error: unknown;
  now?: number;
}): Promise<AccountPause> {
  const pauseMs =
    throttlePauseMs(error) || DEFAULT_THROTTLE_PAUSE_MINUTES * 60_000;
  const wanted = now + pauseMs;
  let reply: unknown;
  try {
    reply = await getRedisConnection().eval(
      PAUSE_SCRIPT,
      1,
      accountPauseKey(instagramAccountId),
      String(wanted),
      String(now),
      String(pauseMs)
    );
  } catch (redisError) {
    console.error(
      "[Pause] Could not store the account pause:",
      formatError(redisError)
    );
    return { resumeAt: wanted, started: false };
  }

  const [state, stored] = Array.isArray(reply) ? reply : [];
  const storedAt = Number(stored);
  const resumeAt = Number.isFinite(storedAt) && storedAt > 0 ? storedAt : wanted;
  const started = Number(state) === 1;
  if (started) {
    await logWorkerEvent({
      workspaceId,
      level: "WARNING",
      message: `Instagram request limit reached${account ? ` for @${account}` : ""}: sending paused until ${formatPauseTime(resumeAt)}`,
      payload: {
        kind: META_PAUSE_EVENT,
        instagramAccountId,
        account,
        resumeAt: new Date(resumeAt).toISOString(),
        pauseMinutes: Math.round(pauseMs / 60_000),
        code: isMetaThrottle(error) ? error.code : null,
        block: isMetaBlock(error),
        error: formatError(error),
      },
    });
  }
  return { resumeAt, started };
}

/**
 * Up to a minute (0 to 59,999 ms) after a pause ends, derived from the job's
 * id: the same job always waits the same, a backlog of different jobs spreads
 * over the minute.
 */
export function pauseJitterMs(seed: string): number {
  return (
    createHash("sha256").update(seed).digest().readUInt32BE(0) %
    PAUSE_JITTER_MS
  );
}

/** When a job held back for a pause runs: the resume time plus its jitter. */
export function pausedRunAt(resumeAt: number, jobId: string): number {
  return resumeAt + pauseJitterMs(jobId);
}

/**
 * Put a job back on the queue for the end of the account's pause, at
 * pausedRunAt under its own deterministic id: the same job held back twice
 * for one pause stays one job. Returns when it runs (epoch ms).
 *
 * The copy is removed once it completes, as offer jobs are. The queue keeps
 * the last 1,000 completed jobs and drops an add whose id it still holds, so
 * a retained copy would swallow the same id in a later pause.
 */
export async function requeueForPause({
  name,
  data,
  jobId,
  instagramAccountId,
  resumeAt,
  now = Date.now(),
}: {
  name: string;
  data: DmQueueJob;
  /** Deterministic, without ":" (BullMQ forbids it in custom ids). */
  jobId: string;
  instagramAccountId: string;
  resumeAt: number;
  now?: number;
}): Promise<number> {
  const runAt = pausedRunAt(resumeAt, jobId);
  await getDMQueue().add(name, data, {
    jobId,
    delay: Math.max(0, runAt - now),
    removeOnComplete: true,
  });
  await noteWaitingJob(instagramAccountId, jobId, runAt, now);
  return runAt;
}

// Best effort: the count is only shown in Diagnostics.
async function noteWaitingJob(
  instagramAccountId: string,
  jobId: string,
  runAt: number,
  now: number
): Promise<void> {
  try {
    const key = waitingKey(instagramAccountId);
    await getRedisConnection()
      .pipeline()
      .zadd(key, runAt, jobId)
      .zremrangebyscore(key, "-inf", now)
      .pexpireat(key, runAt + WAITING_KEY_TTL_MS)
      .exec();
  } catch (error) {
    console.error("[Pause] Could not count a waiting job:", formatError(error));
  }
}

/** How many jobs wait for the account's pause to end. */
export async function countPausedJobs(
  instagramAccountId: string,
  now: number = Date.now()
): Promise<number> {
  return Number(
    await getRedisConnection().zcount(
      waitingKey(instagramAccountId),
      `(${now}`,
      "+inf"
    )
  );
}

export interface ActiveAccountPause {
  username: string;
  /** ISO time the account's messaging resumes. */
  resumeAt: string;
  /** Jobs waiting for it; null when that could not be read. */
  waiting: number | null;
}

/** The accounts among these whose messaging is paused right now. */
export async function readAccountPauses(
  accounts: { instagramId: string; username: string }[],
  now: number = Date.now()
): Promise<ActiveAccountPause[]> {
  const pauses = await Promise.all(
    accounts.map(async (account): Promise<ActiveAccountPause | null> => {
      const resumeAt = await checkAccountPause(account.instagramId, now);
      if (resumeAt === null) return null;
      const waiting = await countPausedJobs(account.instagramId, now).catch(
        () => null
      );
      return {
        username: account.username,
        resumeAt: new Date(resumeAt).toISOString(),
        waiting,
      };
    })
  );
  return pauses.filter((pause): pause is ActiveAccountPause => pause !== null);
}

/**
 * A job that kept running into the account's pause and gave up
 * (MAX_PAUSE_REQUEUES). Thrown like any refused send, so BullMQ retries the
 * job later; a retry that still finds the pause sends nothing.
 */
export class AccountPausedError extends Error {
  readonly resumeAt: number;

  constructor(message: string, resumeAt: number) {
    super(message);
    this.name = "AccountPausedError";
    this.resumeAt = resumeAt;
  }
}
