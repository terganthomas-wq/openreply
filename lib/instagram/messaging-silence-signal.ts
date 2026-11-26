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
 * A check is silent when no inbound messaging event arrived for the account
 * (no button tap, no DM that is not an echo, no read receipt, no reaction, in
 * `messaging` or in `standby`: lib/meta/webhook.ts, inboundMessagingAccountIds)
 * since the first of enough opening DMs (the comment's first DM of a campaign
 * whose DM has a button), each at least `minAge` old and sent after the
 * account's last A1 incident ended. Enough is either rule:
 * - the window: at least `minPeople` different people got theirs at most
 *   `window` ago, close together;
 * - the spread: at least `spreadMinPeople` different people got theirs
 *   since the last inbound event, however far apart. Opening DMs spread
 *   thinly over the day (about six a day in production outside bursts) never
 *   put three people into one window, and a silence on such traffic would
 *   otherwise not be noticed for days, or never.
 * The worker's check (lib/instagram/messaging-silence-check.ts) reads both
 * from the database; this module only decides.
 *
 * Two silent checks in a row open an incident, and the second is judged on
 * the first one's evidence: the opening DMs as they counted at the first
 * check, with every inbound event that arrived up to now. Only an event that
 * arrived (or a lost connection in between, A1) undoes a first silent check;
 * DMs that grow too old to count meanwhile never do, or a thin silence would
 * strike and be forgotten again with every sweep.
 *
 * The defaults come from replaying the production timeline of 2026-11-20 to
 * 26 through the real check (__tests__/messaging-silence-calibration.test.ts):
 * - The silence: opening DMs to 3 people at 20:49 to 20:51 UTC after the A1
 *   reconnect, then nothing until the fix at 10:30. With 3 people, 12 hours
 *   and an 18-hour window the first silent check comes at 08:52 at the
 *   earliest, and the incident opens between 09:22 and 09:51 UTC depending on
 *   the minute the 30-minute sweep falls on (09:30 for sweeps on the hour and
 *   the half hour): 12.5 to 13 hours after the third DM, an hour before the
 *   fix. The spread rule changes nothing here: the fourth opening DM of the
 *   silence went out at 04:51.
 * - Before it, never a silent check, quiet nights included. The closest call
 *   was the night of 2026-11-24/25: five people got their opening DM between
 *   12:06 and 22:17 and nothing came back for 24 hours, until a read receipt
 *   at 07:16. Three of them within six hours (18:08 to 20:49) would have made
 *   a silent check from 08:50 on, 93 minutes after that receipt. Without the
 *   window (any age counts) the 12:06, 18:08 and 19:35 DMs would have made one
 *   from 07:35 on, only 18 minutes after it; with 2 people and no window it
 *   would have been a false alarm from 06:09 on. All five would have made a
 *   spread check from 10:17 on, three hours after it: 5 people keep it quiet,
 *   and as with every other change of the timeline tried (one person's or two
 *   people's events removed, every event up to two hours later) the spread
 *   rule adds no false alarm to the window's.
 * - A silence on thin traffic: replayed for a silence starting every two
 *   hours from 2026-11-20 to 25 (every event after its start dropped), it
 *   took more than 36 hours to be reported for 29 of the 67 starts while a
 *   check that was not silent forgot the first one; judged on the first
 *   check's evidence 20, with the spread rule 19.
 *
 * Client-safe: no database, queue or Meta import.
 */

/** What makes a check silent. */
export interface MessagingSilenceThresholds {
  /** The window rule: different people with an opening DM since the last inbound event, at least. */
  minPeople: number;
  /** How old each of their DMs is, at least: time to tap or read it. */
  minAgeMs: number;
  /** The window rule: how old they are, at most: the people must have got them close together. */
  windowMs: number;
  /** The spread rule: different people with an opening DM since the last inbound event, however far apart, at least. */
  spreadMinPeople: number;
}

/**
 * The calibrated defaults (see above). The window defaults to six hours more
 * than the minimum age, so a different age keeps the six hours in which the
 * people must have got their DMs; the spread rule to two people more than
 * the window's.
 */
export const MESSAGING_SILENCE_DEFAULTS = {
  minPeople: 3,
  minAgeHours: 12,
  windowBeyondAgeHours: 6,
  spreadBeyondPeople: 2,
} as const;

/** What MESSAGING_SILENCE_* may set: values outside are moved to the nearest bound. */
export const MESSAGING_SILENCE_BOUNDS = {
  minPeople: { min: 2, max: 10 },
  minAgeHours: { min: 4, max: 36 },
  /** The window reaches this much further back than the minimum age. */
  windowBeyondAgeHours: { min: 1, max: 48 },
  /** The spread rule needs this many more people than the window's. */
  spreadBeyondPeople: { min: 1, max: 20 },
} as const;

const HOUR = 60 * 60_000;

/**
 * How far back the check looks for the last inbound messaging event: it says
 * since when the silence lasts, covers every window the bounds allow, and is
 * as far as the spread rule reaches.
 */
export const INBOUND_LOOKBACK_MS = 7 * 24 * HOUR;

/**
 * How long a first silent check counts for the second, at most. Normally the
 * second comes one sweep later; it is delayed only by checks that cannot
 * judge (no active campaign, a lost or doubtful connection, an R1 pause).
 * After a day the evidence is old: the check starts over.
 */
export const SILENCE_STRIKE_MAX_AGE_MS = 24 * HOUR;

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
 * MESSAGING_SILENCE_MIN_AGE_HOURS (default 12, 4 to 36),
 * MESSAGING_SILENCE_WINDOW_HOURS (default the age plus 6, so 18; the age
 * plus 1 to 48) and MESSAGING_SILENCE_SPREAD_MIN_PEOPLE (default the people
 * plus 2, so 5; the people plus 1 to 20), each falling back to its default
 * when unset or not a number (the people: not a whole number) and moved into
 * its bounds when outside them. `notes` says what was not taken as written.
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
  const spreadMinPeople = readNumber(
    env,
    "MESSAGING_SILENCE_SPREAD_MIN_PEOPLE",
    minPeople + MESSAGING_SILENCE_DEFAULTS.spreadBeyondPeople,
    {
      min: minPeople + bounds.spreadBeyondPeople.min,
      max: minPeople + bounds.spreadBeyondPeople.max,
      integer: true,
    },
    notes
  );
  return {
    thresholds: {
      minPeople,
      minAgeMs: Math.round(minAgeHours * HOUR),
      windowMs: Math.round(windowHours * HOUR),
      spreadMinPeople,
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

/** Which opening DMs a judgment counts (see silenceDmBounds). */
export interface SilenceDmBounds {
  /** The window rule: DMs sent after this. */
  after: Date;
  /** The spread rule: DMs sent after this; never later than `after`. */
  spreadAfter: Date;
  /** Both rules: DMs sent at the latest at this, the minimum age before the judged time. */
  until: Date;
}

/**
 * Which opening DMs a judgment at `at` counts (the check's own time, or its
 * first silent check's: silenceJudgedAt): sent at least the minimum age
 * before `at`, and after the window before `at` (the window rule) or after
 * the look-back before `now`, the check's own time (the spread rule: as far
 * as the inbound events are read). None before the end of the account's last
 * A1 incident counts: while the connection was lost no webhook arrived at
 * all, so a tap of that time proves nothing.
 */
export function silenceDmBounds(
  at: number,
  thresholds: MessagingSilenceThresholds,
  notBefore: Date | null = null,
  now: number = at
): SilenceDmBounds {
  const floor = notBefore?.getTime() ?? -Infinity;
  const until = at - thresholds.minAgeMs;
  const after = Math.max(at - thresholds.windowMs, floor);
  const spreadAfter = Math.min(after, Math.max(now - INBOUND_LOOKBACK_MS, floor));
  return { after: new Date(after), spreadAfter: new Date(spreadAfter), until: new Date(until) };
}

export type SilenceJudgment =
  /**
   * Enough people got an opening DM, and nothing came back since the first
   * of them: by the window rule, or else by the spread rule (`people` is that
   * rule's count).
   */
  | { silent: true; rule: "window" | "spread"; people: number; firstDmAt: Date }
  /** `people`: how many the window rule counted. */
  | { silent: false; people: number };

/**
 * The judgment of one check: the opening DMs within the bounds that went out
 * after the last inbound messaging event (null: none within the look-back),
 * and whether they reached enough different people by either rule.
 */
export function judgeMessagingSilence({
  dms,
  lastInboundAt,
  bounds,
  thresholds,
}: {
  dms: readonly OpeningDm[];
  lastInboundAt: Date | null;
  bounds: SilenceDmBounds;
  thresholds: Pick<MessagingSilenceThresholds, "minPeople" | "spreadMinPeople">;
}): SilenceJudgment {
  const last = lastInboundAt?.getTime() ?? -Infinity;
  const until = bounds.until.getTime();
  const counted = (after: number) =>
    dms.filter((dm) => {
      const sent = dm.sentAt.getTime();
      return sent > Math.max(after, last) && sent <= until;
    });
  const verdict = (rule: "window" | "spread", among: OpeningDm[]): SilenceJudgment => ({
    silent: true,
    rule,
    people: new Set(among.map((dm) => dm.recipientId)).size,
    firstDmAt: new Date(Math.min(...among.map((dm) => dm.sentAt.getTime()))),
  });

  const windowed = counted(bounds.after.getTime());
  const people = new Set(windowed.map((dm) => dm.recipientId)).size;
  if (people >= thresholds.minPeople) return verdict("window", windowed);
  const spread = counted(bounds.spreadAfter.getTime());
  if (new Set(spread.map((dm) => dm.recipientId)).size >= thresholds.spreadMinPeople) {
    return verdict("spread", spread);
  }
  return { silent: false, people };
}

/**
 * When a check judges, and on which first silent check: while one waits for
 * its second (`strikeAt`), at its time, so the second is judged on the same
 * evidence (the opening DMs as they counted then, with every inbound event up
 * to now). A first check from before the end of the account's last lost
 * connection (A1), or older than SILENCE_STRIKE_MAX_AGE_MS, no longer
 * counts: then at `now`, as a first check, with `strike` null.
 */
export function silenceJudgedAt(
  strikeAt: Date | null,
  now: number,
  recoveredAt: Date | null
): { at: number; strike: Date | null } {
  if (
    !strikeAt ||
    (recoveredAt !== null && recoveredAt.getTime() >= strikeAt.getTime()) ||
    now - strikeAt.getTime() > SILENCE_STRIKE_MAX_AGE_MS ||
    strikeAt.getTime() > now
  ) {
    return { at: now, strike: null };
  }
  return { at: strikeAt.getTime(), strike: strikeAt };
}

/** The part of the account row the two strikes are decided on. */
export interface SilenceState {
  messagingSilenceCheckAt: Date | null;
  messagingSilentSince: Date | null;
}

export type SilenceStep =
  /** Nothing to write. */
  | { kind: "none" }
  /** The first silent check: remember it (in place of one that no longer counts). */
  | { kind: "strike" }
  /** A second silent check, far enough after the first: the incident opens. */
  | { kind: "open" }
  /** Forget the first silent check: an event arrived since, or it no longer counts. */
  | { kind: "clear-strike" }
  /** The incident goes on: only an inbound messaging event ends it. */
  | { kind: "still-silent" };

/**
 * What one judgment does to the account's state. `strike` is the first
 * silent check the judgment was made on (silenceJudgedAt): with one, the
 * judgment is its second, and opens the incident when it is still silent and
 * at least `strikeGapMs` after it (A1's gap: lib/instagram/connection-check.ts,
 * connectionStrikeGapMs). Judged on the first check's own evidence, a check
 * that is not silent means that an event arrived since: the first check is
 * forgotten. Without one, a silent judgment is the first; a stored first
 * check that no longer counts is replaced or forgotten. A judgment never ends
 * an open incident: the DMs that made it silent may simply have grown too
 * old to count, and only an event that arrived proves that Instagram passes
 * them on again.
 */
export function nextSilenceStep(
  state: SilenceState,
  judgment: SilenceJudgment,
  now: number,
  strikeGapMs: number,
  strike: Date | null = state.messagingSilenceCheckAt
): SilenceStep {
  if (state.messagingSilentSince) return { kind: "still-silent" };
  if (strike) {
    if (!judgment.silent) return { kind: "clear-strike" };
    return now - strike.getTime() >= strikeGapMs ? { kind: "open" } : { kind: "none" };
  }
  if (judgment.silent) return { kind: "strike" };
  return state.messagingSilenceCheckAt ? { kind: "clear-strike" } : { kind: "none" };
}
