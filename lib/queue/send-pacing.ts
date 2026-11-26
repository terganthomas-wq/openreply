/**
 * Spacing private replies out per Instagram account.
 *
 * On 2026-11-21 Meta's app limit (code 4) stopped every call after about 25
 * private replies and 50 conversation reads in one hour. Sends that pile up
 * (the catch-up after a lost connection, a backlog that waited for an R1
 * pause, the owner clicking through the Kommentare page) must therefore go
 * out one after the other, not in a burst.
 *
 * A pace is a time slot in Redis per account and purpose: the last slot
 * handed out (epoch ms). reservePacedSlot hands out the next one, at least
 * `spacingMs` after it and never before `earliest`, in one step, so two
 * callers at once never get the same slot. A job is then queued with the
 * delay to its slot.
 *
 * - The catch-up (lib/instagram/connection-catch-up.ts) takes a slot for
 *   every comment job it queues, and a copy of one of its jobs (waiting for
 *   an R1 pause or for Meta's usage to drop, lib/queue/dm-worker.ts) takes
 *   the next free one: the copies line up after the jobs already planned,
 *   one per CATCH_UP_SPACING_MS, instead of all running in the minute after
 *   the pause. The comment sweep stands back until the last slot has passed
 *   (lib/polling/comment-reconciler.ts).
 * - Manual sends (lib/comments/server.ts) have a pace of their own, so they
 *   never wait behind hours of catch-up.
 * - So do the taps the search after a messaging silence continues
 *   (lib/instagram/lost-tap-search.ts): Instagram's 24 hours from a tap run
 *   out long before a catch-up's 7 days for a comment.
 */

import { getRedisConnection } from "./client";

// KEYS[1] the pace; ARGV[1] the earliest slot, ARGV[2] the spacing, ARGV[3]
// now, ARGV[4] how long the pace is kept after its slot (all ms). Returns
// the slot. Lua 5.1 numbers are doubles, exact for epoch ms; "%.0f" writes
// them without an exponent.
const PACE_SCRIPT = `-- openreply paced slot
local last = tonumber(redis.call("GET", KEYS[1]) or "")
local slot = tonumber(ARGV[1])
if last ~= nil and last + tonumber(ARGV[2]) > slot then
  slot = last + tonumber(ARGV[2])
end
local ttl = math.max(1, slot - tonumber(ARGV[3]) + tonumber(ARGV[4]))
redis.call("SET", KEYS[1], string.format("%.0f", slot), "PX", string.format("%.0f", ttl))
return string.format("%.0f", slot)
`;

/** A pace is forgotten this long after its last slot. */
const PACE_KEEP_MS = 60 * 60_000;

/**
 * The next slot of a pace (epoch ms): `earliest`, or `spacingMs` after the
 * last slot handed out when that is later. Throws when Redis cannot be asked.
 */
export async function reservePacedSlot(
  key: string,
  {
    earliest,
    spacingMs,
    now = Date.now(),
  }: { earliest: number; spacingMs: number; now?: number }
): Promise<number> {
  const reply = await getRedisConnection().eval(
    PACE_SCRIPT,
    1,
    key,
    String(Math.floor(earliest)),
    String(Math.max(0, Math.floor(spacingMs))),
    String(Math.floor(now)),
    String(PACE_KEEP_MS)
  );
  const slot = Number(reply);
  if (!Number.isFinite(slot)) throw new Error("The send pace gave no slot");
  return slot;
}

/** The last slot handed out of a pace (epoch ms), or null for none. */
export async function lastPacedSlot(key: string): Promise<number | null> {
  const value = await getRedisConnection().get(key);
  if (value === null || value === undefined) return null;
  const slot = Number(value);
  return Number.isFinite(slot) ? slot : null;
}

/** The catch-up's pace of an account (its comment jobs and their copies). */
export function recoveryPaceKey(instagramId: string): string {
  return `pace:recovery:${instagramId}`;
}

/** The manual sends' pace of an account. */
export function manualSendPaceKey(instagramId: string): string {
  return `pace:manual:${instagramId}`;
}

/** The pace of the lost taps an account's search after a messaging silence continues. */
export function lostTapPaceKey(instagramId: string): string {
  return `pace:taps:${instagramId}`;
}
