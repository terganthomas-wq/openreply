/**
 * The catch-up after a lost Instagram connection (A1) as it is stored on the
 * InstagramAccount row, and read back by the worker
 * (lib/instagram/connection-catch-up.ts), the comment sweep, Diagnostics and
 * the all-clear e-mail.
 *
 * - connectionCatchUpProgress: how far a catch-up that stopped early got
 *   (CatchUpProgress), so the next run goes on from there.
 * - connectionCatchUpResult: the last finished catch-up (CatchUpResult).
 *
 * Both are JSON the worker wrote; whatever does not read as this version's
 * shape counts as missing. Client-safe: no database, queue or Meta import.
 */

/** Posts the catch-up looks at, at most: the newest ones. */
export const CATCH_UP_MAX_POSTS = 300;
/** Pages of comments (50 each) it reads, at most, across every post. */
export const CATCH_UP_MAX_COMMENT_PAGES = 500;
/**
 * Its comment jobs run this far apart, the first one right away: 24 private
 * replies an hour at most. On 2026-11-21 about 25 private replies and 50
 * conversation reads in one hour ran into Meta's app limit (code 4), which
 * then paused every DM of the account, the button taps of people who had
 * just got their opening DM included. Copies of these jobs that waited for
 * an R1 pause or for Meta's usage to drop keep the same spacing
 * (lib/queue/send-pacing.ts).
 */
export const CATCH_UP_SPACING_MS = 150_000;
/** Comments the owner answered by hand that are kept with their text. */
export const CATCH_UP_MAX_LISTED = 100;
/** How long Diagnostics shows a finished catch-up: the private-reply window. */
export const CATCH_UP_REPORT_MS = 7 * 24 * 60 * 60_000;
/**
 * The sweep stands back for an account at most this long after its incident
 * ended, whatever the catch-up's state says: a catch-up that got stuck can
 * never switch the safety net off for good.
 */
export const CATCH_UP_SWEEP_HOLD_MAX_MS = 30 * 60 * 60_000;

/**
 * A comment the owner had already answered by hand when the catch-up read
 * it. It gets no automatic DM (the owner may have sent the guide by hand);
 * the all-clear e-mail and Diagnostics list it, and the Kommentare page can
 * send it.
 */
export interface OwnerAnsweredComment {
  commentId: string;
  /** The author's handle, without "@". */
  username: string | null;
  text: string;
  /** ISO time of the comment. */
  timestamp: string;
  /** The post's link on Instagram, when known. */
  permalink: string | null;
}

/** What a catch-up did not look at, and why. */
export interface CatchUpSkipped {
  /** The account has more posts than CATCH_UP_MAX_POSTS: older ones were not read. */
  olderPosts: boolean;
  /** Posts not read at all: the CATCH_UP_MAX_COMMENT_PAGES pages were used up. */
  postsNotRead: number;
  /** Posts whose older comment pages were not read, for the same reason. */
  postsPartial: number;
  /** Posts whose comments Meta would not give (a deleted post, an error). */
  postsFailed: number;
  /** Comments outside Instagram's 7 days for a private reply. */
  tooOld: number;
  /** Comments not queued because the catch-up had queued its maximum. */
  notQueued: number;
  /** The catch-up ran out of time and ended with what it had. */
  gaveUp: boolean;
}

/** A post the catch-up reads, in the order it reads them (newest first). */
export interface CatchUpPost {
  id: string;
  permalink: string | null;
  /** For an ad: the post it was made from, which campaigns are bound to. */
  originalMediaId?: string;
  /**
   * Among the account's posts as Meta listed them just before. A refusal of
   * such a post's comments may be the account's; a campaign's older post or
   * an ad may simply be gone.
   */
  listed?: boolean;
}

/** How far a catch-up got; written when a run stops early. */
export interface CatchUpProgress {
  v: 1;
  /** The connectionCatchUpFrom it belongs to (ISO). */
  from: string;
  /** The connectionRecoveredAt it belongs to (ISO). */
  recoveredAt: string;
  /** When the catch-up's first run began (ISO). */
  startedAt: string;
  /** The posts to read, once the list has been read. */
  posts: CatchUpPost[] | null;
  /** The index in `posts` of the next one to read. */
  next: number;
  /** Comment pages read so far. */
  pages: number;
  /** Comments whose job is queued. */
  queuedIds: string[];
  /** When the first and the last of those jobs run (ISO). */
  firstJobAt: string | null;
  lastJobAt: string | null;
  /** Comments the owner answered by hand: every id, and the first ones in full. */
  answeredIds: string[];
  answered: OwnerAnsweredComment[];
  /** Comments read inside the window, and of those the ones another job already handles. */
  seen: number;
  handled: number;
  skipped: CatchUpSkipped;
  /** How often a run stopped early. */
  stops: number;
  /** Not before this time (ISO): the run that stopped queued one for then. */
  resumeAt: string | null;
}

/** A finished catch-up, as Diagnostics and the all-clear e-mail show it. */
export interface CatchUpResult {
  v: 1;
  /** Since when the connection was lost: the incident's start (ISO). */
  lostAt: string;
  /** When it was back (ISO). */
  recoveredAt: string;
  finishedAt: string;
  /** Comments created since this time were looked at (ISO). */
  since: string;
  /** Comments whose DM was queued, one every CATCH_UP_SPACING_MS. */
  queued: number;
  firstJobAt: string | null;
  lastJobAt: string | null;
  /** Comments the owner answered by hand: the first CATCH_UP_MAX_LISTED, and how many in all. */
  ownerAnswered: OwnerAnsweredComment[];
  ownerAnsweredTotal: number;
  posts: number;
  pages: number;
  skipped: CatchUpSkipped;
  /** Nothing was skipped for the caps, a failed read or time. */
  complete: boolean;
}

export const EMPTY_SKIPPED: CatchUpSkipped = {
  olderPosts: false,
  postsNotRead: 0,
  postsPartial: 0,
  postsFailed: 0,
  tooOld: 0,
  notQueued: 0,
  gaveUp: false,
};

/** Whether nothing was left out for a cap, a failed read or time. */
export function catchUpComplete(skipped: CatchUpSkipped): boolean {
  return (
    !skipped.olderPosts &&
    skipped.postsNotRead === 0 &&
    skipped.postsPartial === 0 &&
    skipped.postsFailed === 0 &&
    skipped.notQueued === 0 &&
    !skipped.gaveUp
  );
}

/** Posts the catch-up did not read in full. */
export function skippedPosts(skipped: CatchUpSkipped): number {
  return skipped.postsNotRead + skipped.postsPartial + skipped.postsFailed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function timeOrNull(value: unknown): string | null {
  return isTime(value) ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readSkipped(value: unknown): CatchUpSkipped {
  const raw = isRecord(value) ? value : {};
  return {
    olderPosts: raw.olderPosts === true,
    postsNotRead: count(raw.postsNotRead),
    postsPartial: count(raw.postsPartial),
    postsFailed: count(raw.postsFailed),
    tooOld: count(raw.tooOld),
    notQueued: count(raw.notQueued),
    gaveUp: raw.gaveUp === true,
  };
}

function readAnswered(value: unknown): OwnerAnsweredComment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): OwnerAnsweredComment[] => {
    if (!isRecord(item) || typeof item.commentId !== "string" || !isTime(item.timestamp)) {
      return [];
    }
    return [
      {
        commentId: item.commentId,
        username: typeof item.username === "string" ? item.username : null,
        text: typeof item.text === "string" ? item.text : "",
        timestamp: item.timestamp,
        permalink: safePermalink(item.permalink),
      },
    ];
  });
}

function readPosts(value: unknown): CatchUpPost[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item): CatchUpPost[] => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    return [
      {
        id: item.id,
        permalink: safePermalink(item.permalink),
        ...(typeof item.originalMediaId === "string"
          ? { originalMediaId: item.originalMediaId }
          : {}),
        ...(item.listed === true ? { listed: true } : {}),
      },
    ];
  });
}

/**
 * A post's link as Meta gives it, if it is one: https on instagram.com. The
 * e-mail and Diagnostics link to it, so nothing else gets through.
 */
export function safePermalink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "instagram.com" || url.hostname === "www.instagram.com")
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** The stored progress, or null for none or one this version cannot read. */
export function readCatchUpProgress(value: unknown): CatchUpProgress | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (!isTime(value.from) || !isTime(value.recoveredAt) || !isTime(value.startedAt)) {
    return null;
  }
  return {
    v: 1,
    from: value.from,
    recoveredAt: value.recoveredAt,
    startedAt: value.startedAt,
    posts: readPosts(value.posts),
    next: count(value.next),
    pages: count(value.pages),
    queuedIds: strings(value.queuedIds),
    firstJobAt: timeOrNull(value.firstJobAt),
    lastJobAt: timeOrNull(value.lastJobAt),
    answeredIds: strings(value.answeredIds),
    answered: readAnswered(value.answered),
    seen: count(value.seen),
    handled: count(value.handled),
    skipped: readSkipped(value.skipped),
    stops: count(value.stops),
    resumeAt: timeOrNull(value.resumeAt),
  };
}

/** The stored result, or null for none or one this version cannot read. */
export function readCatchUpResult(value: unknown): CatchUpResult | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (
    !isTime(value.lostAt) ||
    !isTime(value.recoveredAt) ||
    !isTime(value.finishedAt) ||
    !isTime(value.since)
  ) {
    return null;
  }
  const skipped = readSkipped(value.skipped);
  const ownerAnswered = readAnswered(value.ownerAnswered);
  return {
    v: 1,
    lostAt: value.lostAt,
    recoveredAt: value.recoveredAt,
    finishedAt: value.finishedAt,
    since: value.since,
    queued: count(value.queued),
    firstJobAt: timeOrNull(value.firstJobAt),
    lastJobAt: timeOrNull(value.lastJobAt),
    ownerAnswered,
    ownerAnsweredTotal: Math.max(count(value.ownerAnsweredTotal), ownerAnswered.length),
    posts: count(value.posts),
    pages: count(value.pages),
    skipped,
    complete: catchUpComplete(skipped),
  };
}

/**
 * The id of the job that runs an account's catch-up:
 * `catchup_<account row>_<start in ms>`, the same for every request of one
 * catch-up (the check that ends the incident, the reconnect, the sweep's
 * reminder), so they queue it once while it waits or runs. A run that stops
 * early queues `…_<resume time in ms>` for when it may go on.
 */
export function catchUpJobId(
  accountId: string,
  from: Date,
  resumeAt?: number
): string {
  const base = `catchup_${accountId}_${from.getTime()}`;
  return resumeAt === undefined ? base : `${base}_${Math.floor(resumeAt)}`;
}

/** The fields of an account row that tell whether its catch-up is still going. */
export interface CatchUpHoldFields {
  connectionCatchUpFrom?: Date | null;
  connectionRecoveredAt?: Date | null;
  connectionCatchUpProgress?: unknown;
  connectionCatchUpResult?: unknown;
}

/**
 * Whether the comment sweep stands back for the account: while its catch-up
 * is owed or running, and until the last comment job it queued has run. The
 * catch-up reads every post since the incident began and spaces the DMs
 * CATCH_UP_SPACING_MS apart; the sweep would queue the same comments again
 * all at once, the burst that runs into Meta's limit. Never longer than
 * CATCH_UP_SWEEP_HOLD_MAX_MS after the incident ended. (Copies of the jobs
 * that waited for a pause may run later still: the sweep also asks the
 * catch-up's pace in Redis, lib/polling/comment-reconciler.ts.)
 */
export function catchUpHoldsSweep(
  account: CatchUpHoldFields,
  now: number = Date.now()
): boolean {
  const recoveredAt = account.connectionRecoveredAt;
  if (!recoveredAt || now - recoveredAt.getTime() > CATCH_UP_SWEEP_HOLD_MAX_MS) {
    return false;
  }
  if (account.connectionCatchUpFrom) return true;
  const lastJobAt =
    readCatchUpResult(account.connectionCatchUpResult)?.lastJobAt ??
    readCatchUpProgress(account.connectionCatchUpProgress)?.lastJobAt ??
    null;
  return lastJobAt !== null && Date.parse(lastJobAt) > now;
}
