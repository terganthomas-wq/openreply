/**
 * Meta's request limits.
 *
 * When an app, a token, a page or the messaging API makes too many calls in
 * Meta's rolling window, Meta refuses further calls with one of the codes
 * below and processes nothing. The refusal costs time, not the message: the
 * same call goes through once the window has moved on. Seen live on
 * 2026-11-21, code 4 ("Application request limit reached") refused every send
 * for about an hour after a burst of private replies and heavy reads.
 *
 * No database, queue or client import, so the code lists can be used
 * anywhere, test mocks of the Meta client included.
 */

/**
 * Throttles: 4 application limit, 17 user (token) limit, 32 page limit,
 * 613 the limit of one API, 80002 Instagram's business use case limit,
 * 80006 the messaging limit.
 */
export const META_THROTTLE_CODES: readonly number[] = [4, 17, 32, 613, 80002, 80006];

/**
 * 368: the account is temporarily blocked from an action (Meta's spam and
 * policy brake). Also a request limit, but one that lasts longer.
 */
export const META_BLOCK_CODE = 368;

/** Whether Meta's error code is one of its request limits, block included. */
export function isMetaLimitCode(code: unknown): boolean {
  return (
    typeof code === "number" &&
    (code === META_BLOCK_CODE || META_THROTTLE_CODES.includes(code))
  );
}

/** How long an account pauses after a throttle, unless configured. */
export const DEFAULT_THROTTLE_PAUSE_MINUTES = 20;
/** How long an account pauses after a block (368), unless configured. */
export const DEFAULT_BLOCK_PAUSE_MINUTES = 60;
// A pause ends with a send that tries again; a longer wait is never needed to
// find out whether the limit is over. The bound also keeps the comment path's
// capped requeues (12) well inside Instagram's 7-day private-reply window.
const MIN_PAUSE_MINUTES = 1;
const MAX_PAUSE_MINUTES = 240;

/**
 * A pause length in minutes from an environment value
 * (META_THROTTLE_PAUSE_MINUTES, META_BLOCK_PAUSE_MINUTES): a number of
 * minutes from 1 to 240, rounded down; anything else gives the default.
 */
export function pauseMinutesFromEnv(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return fallback;
  return Math.min(
    MAX_PAUSE_MINUTES,
    Math.max(MIN_PAUSE_MINUTES, Math.floor(minutes))
  );
}
