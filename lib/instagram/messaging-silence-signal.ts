/**
 * The messaging silence signal (A2): whether Instagram still passes on what
 * people do in their DMs, judged from the database alone.
 *
 * Seen live on 2026-11-25/26: after the Instagram account was linked to a
 * Facebook Page, Meta kept delivering comment webhooks but no messaging
 * webhooks at all, from 13:15 UTC until the reconnect with the Page the next
 * morning at 10:30 UTC. Every opening DM went out, every tap on its button
 * was lost, and A1's connection check stayed green: the account and its
 * comments could be read. Nothing noticed it.
 *
 * A check is silent when at least `minPeople` different people got an
 * opening DM (the comment's first DM of a campaign whose DM has a button)
 * that went out at least `minAge` and at most `window` ago, after the
 * account's last A1 incident ended, and no inbound messaging event arrived
 * for the account since the first of these DMs: no button tap, no DM that is
 * not an echo, no read receipt, no reaction, in `messaging` or in `standby`
 * (lib/meta/webhook.ts, inboundMessagingAccountIds). The worker's check
 * (lib/instagram/messaging-silence-check.ts) reads both from the database;
 * this module only decides.
 *
 * The defaults come from replaying the production timeline of 2026-11-20 to
 * 26 through the real check (__tests__/messaging-silence-calibration.test.ts):
 * - The silence: opening DMs to 3 people at 20:49 to 20:51 UTC after the A1
 *   reconnect, then nothing until the fix at 10:30. With 3 people, 12 hours
 *   and an 18-hour window the first silent check comes at 08:52 at the
 *   earliest, and the incident opens between 09:22 and 09:51 UTC depending on
 *   the minute the 30-minute sweep falls on (09:30 for sweeps on the hour and
 *   the half hour): 12.5 to 13 hours after the third DM, an hour before the
 *   fix.
 * - Before it, never a silent check, quiet nights included. The closest call
 *   was the night of 2026-11-24/25: five people got their opening DM between
 *   12:06 and 22:17 and nothing came back for 24 hours, until a read receipt
 *   at 07:16. Three of them within six hours (18:08 to 20:49) would have made
 *   a silent check from 08:50 on, 93 minutes after that receipt. Without the
 *   window (any age counts) the 12:06, 18:08 and 19:35 DMs would have made one
 *   from 07:35 on, only 18 minutes after it; with 2 people and no window it
 *   would have been a false alarm from 06:09 on. 4 people would not have fired
 *   before the fix: the fourth opening DM of the silence went out at 04:51.
 *
 * Client-safe: no database, queue or Meta import.
 */

/** What makes a check silent. */
export interface MessagingSilenceThresholds {
  /** Different people with an opening DM since the last inbound event, at least. */
  minPeople: number;
  /** How old each of their DMs is, at least: time to tap or read it. */
  minAgeMs: number;
  /** How old they are, at most: the people must have got them close together. */
  windowMs: number;
}

/**
 * The calibrated defaults (see above). The window defaults to six hours more
 * than the minimum age, so a different age keeps the six hours in which the
 * people must have got their DMs.
 */
export const MESSAGING_SILENCE_DEFAULTS = {
  minPeople: 3,
  minAgeHours: 12,
  windowBeyondAgeHours: 6,
} as const;

/** What MESSAGING_SILENCE_* may set: values outside are moved to the nearest bound. */
export const MESSAGING_SILENCE_BOUNDS = {
  minPeople: { min: 2, max: 10 },
  minAgeHours: { min: 4, max: 36 },
  /** The window reaches this much further back than the minimum age. */
  windowBeyondAgeHours: { min: 1, max: 48 },
} as const;

const HOUR = 60 * 60_000;

/**
 * How far back the check looks for the last inbound messaging event: it says
 * since when the silence lasts, and covers every window the bounds allow.
 */
export const INBOUND_LOOKBACK_MS = 7 * 24 * HOUR;

type Env = Record<string, string | undefined>;

function readNumber(
  env: Env,
  name: string,
  fallback: number,
  { min, max, integer }: { min: number; max: number; integer: boolean },
  notes: string[]
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    notes.push(`${name}=${raw} is not ${integer ? "a whole number" : "a number"}: using ${fallback}`);
    return fallback;
  }
  if (value < min || value > max) {
    const bounded = Math.min(max, Math.max(min, value));
    notes.push(`${name}=${raw} is outside ${min} to ${max}: using ${bounded}`);
    return bounded;
  }
  return value;
}

/**
 * The thresholds from MESSAGING_SILENCE_MIN_PEOPLE (default 3, 2 to 10),
 * MESSAGING_SILENCE_MIN_AGE_HOURS (default 12, 4 to 36) and
 * MESSAGING_SILENCE_WINDOW_HOURS (default the age plus 6, so 18; the age
 * plus 1 to 48), each falling back to its default when unset or not a
 * number (MIN_PEOPLE: not a whole number) and moved into its bounds when
 * outside them. `notes` says what was not taken as written.
 */
export function messagingSilenceThresholds(env: Env = process.env): {
  thresholds: MessagingSilenceThresholds;
  notes: string[];
} {
  const notes: string[] = [];
  const bounds = MESSAGING_SILENCE_BOUNDS;
  const minPeople = readNumber(
    env,
    "MESSAGING_SILENCE_MIN_PEOPLE",
    MESSAGING_SILENCE_DEFAULTS.minPeople,
    { ...bounds.minPeople, integer: true },
    notes
  );
  const minAgeHours = readNumber(
    env,
    "MESSAGING_SILENCE_MIN_AGE_HOURS",
    MESSAGING_SILENCE_DEFAULTS.minAgeHours,
    { ...bounds.minAgeHours, integer: false },
    notes
  );
  const windowHours = readNumber(
    env,
    "MESSAGING_SILENCE_WINDOW_HOURS",
    minAgeHours + MESSAGING_SILENCE_DEFAULTS.windowBeyondAgeHours,
    {
      min: minAgeHours + bounds.windowBeyondAgeHours.min,
      max: minAgeHours + bounds.windowBeyondAgeHours.max,
      integer: false,
    },
    notes
  );
  return {
    thresholds: {
      minPeople,
      minAgeMs: Math.round(minAgeHours * HOUR),
      windowMs: Math.round(windowHours * HOUR),
    },
    notes,
  };
}

/** An opening DM that went out: to whom, and when. */
export interface OpeningDm {
  /** The person's Instagram-scoped id (DmLog.commenterId). */
  recipientId: string;
  sentAt: Date;
}

/**
 * Which opening DMs can count at `now`: sent after `after` and at the latest
 * at `until`. The window and the minimum age set them, and none before the
 * end of the account's last A1 incident counts: while the connection was
 * lost no webhook arrived at all, so a tap of that time proves nothing.
 */
export function silenceDmBounds(
  now: number,
  thresholds: MessagingSilenceThresholds,
  notBefore: Date | null = null
): { after: Date; until: Date } {
  const windowStart = now - thresholds.windowMs;
  return {
    after: new Date(Math.max(windowStart, notBefore?.getTime() ?? windowStart)),
    until: new Date(now - thresholds.minAgeMs),
  };
}

export type SilenceJudgment =
  /** Enough people got an opening DM, and nothing came back since the first of them. */
  | { silent: true; people: number; firstDmAt: Date }
  | { silent: false; people: number };

/**
 * The judgment of one check: the opening DMs within the bounds that went out
 * after the last inbound messaging event (null: none within the look-back),
 * and whether they reached enough different people.
 */
export function judgeMessagingSilence({
  dms,
  lastInboundAt,
  bounds,
  minPeople,
}: {
  dms: readonly OpeningDm[];
  lastInboundAt: Date | null;
  bounds: { after: Date; until: Date };
  minPeople: number;
}): SilenceJudgment {
  const from = Math.max(bounds.after.getTime(), lastInboundAt?.getTime() ?? -Infinity);
  const until = bounds.until.getTime();
  const counted = dms.filter((dm) => {
    const at = dm.sentAt.getTime();
    return at > from && at <= until;
  });
  const people = new Set(counted.map((dm) => dm.recipientId)).size;
  if (people < minPeople) return { silent: false, people };
  const firstDmAt = new Date(Math.min(...counted.map((dm) => dm.sentAt.getTime())));
  return { silent: true, people, firstDmAt };
}

/** The part of the account row the two strikes are decided on. */
export interface SilenceState {
  messagingSilenceCheckAt: Date | null;
  messagingSilentSince: Date | null;
}

export type SilenceStep =
  /** Nothing to write. */
  | { kind: "none" }
  /** The first silent check: remember it. */
  | { kind: "strike" }
  /** A second silent check, far enough after the first: the incident opens. */
  | { kind: "open" }
  /** A check that is not silent after one that was: forget it. */
  | { kind: "clear-strike" }
  /** The incident goes on: only an inbound messaging event ends it. */
  | { kind: "still-silent" };

/**
 * What one judgment does to the account's state. Two silent checks in a
 * row, the second at least `strikeGapMs` after the first, open an incident
 * (A1's gap: lib/instagram/connection-check.ts, connectionStrikeGapMs). A
 * check that is not silent ends the run, but never an open incident: the
 * DMs that made it silent may simply have grown too old to count, and only
 * an event that arrived proves that Instagram passes them on again.
 */
export function nextSilenceStep(
  state: SilenceState,
  judgment: SilenceJudgment,
  now: number,
  strikeGapMs: number
): SilenceStep {
  if (state.messagingSilentSince) return { kind: "still-silent" };
  if (!judgment.silent) {
    return state.messagingSilenceCheckAt ? { kind: "clear-strike" } : { kind: "none" };
  }
  const first = state.messagingSilenceCheckAt;
  if (!first) return { kind: "strike" };
  return now - first.getTime() >= strikeGapMs ? { kind: "open" } : { kind: "none" };
}
