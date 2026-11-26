/**
 * The search for lost taps after a messaging silence (A2 requirement 4).
 *
 * While Instagram passed on no messaging events (lib/instagram/messaging-silence-check.ts),
 * every opening DM went out, and every tap on its button was lost: the person
 * tapped "Ja, schick ihn mir" and nothing came. When the silence ends
 * (lib/instagram/messaging-silence-state.ts) the worker runs this once for
 * it, as the queue job `losttaps_<account>_<from>_<until>`:
 *
 * - The people: everyone who got an opening DM in the silence (a SENT comment
 *   row of a campaign whose DM has a button, sent after the silence's start
 *   and at the latest at its end) of a campaign that still answers taps
 *   (active, or paused but sent to this person by hand: M1), and who has no
 *   tap or link on record for that campaign since (lib/instagram/lost-tap-records.ts):
 *   whoever tapped again after the silence was answered the ordinary way. The
 *   newest opening DMs first, at most LOST_TAP_MAX_PEOPLE (50) people; the
 *   rest count as not checked.
 * - Their conversations: the list of the account's conversations, newest
 *   first, a page at a time, each matched by participant id, until every
 *   person is found or the list reaches back before the oldest opening DM
 *   still wanted (a tap would have moved the conversation up), at most
 *   LOST_TAP_MAX_LIST_PAGES pages. A conversation that did not change after
 *   the person's opening DM holds no tap and is not read. The others are read
 *   once each (the 20 newest messages).
 * - A lost tap is a message from the person whose text is the title of one
 *   of the campaign's buttons (the opening DM's, or a follow prompt's), newer
 *   than their opening DM of it (lib/instagram/lost-tap-state.ts). It is
 *   continued with exactly the postback job the tap would have produced: its
 *   payload rebuilt, tappedAt the message's time, mid the message's id, a
 *   deterministic job id, the oldest tap first, the first right away and
 *   then one every LOST_TAP_SPACING_MS in a pace of their own; every claim of
 *   a tap holds for it, and it stands back when the person tapped again or got
 *   the link since (lib/queue/dm-worker.ts). Only while Instagram's 24 hours
 *   from the tap leave at least an hour when the job runs; otherwise, and for
 *   a campaign that stopped answering taps meanwhile, the person is listed in
 *   the all-clear and Diagnostics (name, campaign, time).
 *
 * Exactly once per silence: the job id is the same for every request (the
 * end, the worker's sweep), the run holds a lease on the account row
 * (messagingTapSearchClaimedAt, renewed while it reads), its progress is kept
 * after every read (messagingTapSearchProgress), and its end is one
 * conditional update that sets messagingTapSearchFrom back to null with the
 * result. A tap continued twice is still one job (its id) and one link (the
 * tap's claim).
 *
 * Meta's limits, as A1's catch-up (lib/instagram/connection-catch-up.ts):
 * nothing is read while the account is paused (R1); a pause, a request limit
 * on a read, Meta reporting 60 % of a limit, or a worker shutdown stops the
 * run where it is and a job for later goes on from there. The reads are
 * LOST_TAP_READ_GAP_MS apart. After 24 hours of trying it ends with what it
 * has.
 *
 * Then the all-clear e-mail (lib/ops/messaging-silence-alert.ts).
 */

import { createHash } from "node:crypto";
import { Prisma } from "@/app/generated/prisma/client";
import { MANUAL_MATCHED_KEYWORD } from "@/lib/comments/manual";
import { prisma } from "@/lib/db/client";
import {
  CATCH_UP_BRAKE_WAIT_MS,
  CATCH_UP_GIVE_UP_MS,
  CATCH_UP_LEASE_MS,
  CATCH_UP_RETRY_MS,
  CATCH_UP_USAGE_BRAKE_PERCENT,
} from "@/lib/instagram/connection-catch-up";
import { classifyConnectionError } from "@/lib/instagram/connection-check";
import { createInstagramContext, type InstagramContext } from "@/lib/instagram/context";
import { isMetaThrottle, throttlePauseMs } from "@/lib/instagram/delivery-errors";
import { pairKey, recordedPairs } from "@/lib/instagram/lost-tap-records";
import {
  findLostTaps,
  LOST_TAP_FRESH_MS,
  LOST_TAP_LIST_PAGE_SIZE,
  LOST_TAP_MAX_LIST_PAGES,
  LOST_TAP_MAX_PEOPLE,
  LOST_TAP_READ_GAP_MS,
  LOST_TAP_SPACING_MS,
  lostTapSearchJobId,
  readLostTapProgress,
  tapWindowOpen,
  type FoundTap,
  type LostTapPerson,
  type LostTapProgress,
  type LostTapResult,
  type TapCampaign,
} from "@/lib/instagram/lost-tap-state";
import {
  readMessagingSilenceResult,
  type MessagingSilenceResult,
} from "@/lib/instagram/messaging-silence-incident";
import { queueLostTapSearch } from "@/lib/instagram/messaging-silence-state";
import {
  getConversationMessages,
  getConversationPage,
  MetaApiError,
  type ConversationPage,
  type InstagramMessage,
} from "@/lib/meta/client";
import { DEFAULT_THROTTLE_PAUSE_MINUTES } from "@/lib/meta/limits";
import { accountUsagePercent, latestMetaUsage } from "@/lib/meta/usage";
import { MESSAGING_TAP_SEARCH_EVENT } from "@/lib/ops/event-details";
import type { MailTransport } from "@/lib/ops/mail";
import { sendMessagingSilenceAllClear } from "@/lib/ops/messaging-silence-alert";
import { checkAccountPause, formatPauseTime, pausedRunAt } from "@/lib/queue/account-pause";
import { getDMQueue, POSTBACK_JOB_NAME, type ProcessPostbackJob } from "@/lib/queue/client";
import { formatError, logWorkerEvent } from "@/lib/queue/send-helpers";
import { lostTapPaceKey, reservePacedSlot } from "@/lib/queue/send-pacing";

// Opening DMs read for the people, at most: far more than any silence holds.
const MAX_OPENING_DMS = 2_000;
// How long one conversation read may take.
const READ_TIMEOUT_MS = 15_000;
// Conversation reads in a row that Meta refuses (a permission or a missing
// object, not the token) before the run stops as for a lost connection and
// reads those people again later: one refusal may be that conversation's.
const MAX_REFUSED_IN_ROW = 3;
// How long a run that stopped for a worker shutdown waits.
const SHUTDOWN_WAIT_MS = 60_000;
// A continuation may run this much before the time it was queued for.
const RESUME_TOLERANCE_MS = 30_000;
// The worker's sweep asks again for a continuation this long overdue.
const RESUME_GRACE_MS = 5 * 60_000;

/**
 * The postback job id of a continued tap: the account, the person and the
 * tap's id, hashed (an Instagram message id may hold characters BullMQ
 * refuses). The same tap found twice is one job.
 */
export function lostTapJobId(instagramId: string, userId: string, messageId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([instagramId, userId, messageId]))
    .digest("hex");
  return `losttap_${digest.slice(0, 40)}`;
}

const ACCOUNT_SELECT = {
  id: true,
  workspaceId: true,
  instagramId: true,
  username: true,
  provider: true,
  metaLogin: true,
  accessToken: true,
  zernioAccountId: true,
  connectionLostAt: true,
  messagingSilenceResult: true,
  messagingTapSearchFrom: true,
  messagingTapSearchUntil: true,
  messagingTapSearchClaimedAt: true,
  messagingTapSearchProgress: true,
} satisfies Prisma.InstagramAccountSelect;

type SearchAccount = Prisma.InstagramAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  isActive: true,
  requireFollow: true,
  openingDmEnabled: true,
  openingDmMessage: true,
  openingDmButtonLabel: true,
  followPromptButtonLabel: true,
  followPromptRetryButtonLabel: true,
} satisfies Prisma.AutomationSelect;

type Campaign = Prisma.AutomationGetPayload<{ select: typeof CAMPAIGN_SELECT }>;

export type LostTapOutcome =
  /** Nothing is owed. */
  | "none"
  /** The account's connection is lost (A1): the sweep asks again once it is back. */
  | "lost"
  /** A run that stopped early queued itself for later. */
  | "waiting"
  /** Another run holds the lease. */
  | "busy"
  /** The account is paused for a Meta limit (R1): goes on after the pause. */
  | "paused"
  /** Stopped early for a limit, the usage brake, an error or a shutdown: goes on later. */
  | "stopped"
  /** The lease was lost, or one more silence ended meanwhile: another run does it. */
  | "superseded"
  /** Finished; the all-clear e-mail is sent or owed. */
  | "done";

export interface LostTapSearchOptions {
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The all-clear's transport and settings (tests); the worker's by default. */
  transport?: MailTransport | null;
  env?: Record<string, string | undefined>;
}

type Stop = {
  kind: "stop";
  reason: "paused" | "limit" | "usage" | "lost" | "error" | "shutdown";
  /** When the run may go on (epoch ms). */
  resumeAt: number;
  detail?: string;
};
type Superseded = { kind: "superseded" };
type MetaContext = Extract<InstagramContext, { provider: "META" }>;

interface Run {
  account: SearchAccount;
  from: Date;
  until: Date;
  lease: Date;
  progress: LostTapProgress;
  campaigns: Map<string, Campaign>;
  startedAt: number;
  /** When this run read last (epoch ms): the next read waits for the gap. */
  lastReadAt: number | null;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
}

let shutdownRequested = false;

/**
 * The worker is shutting down: a search that reads stops before its next
 * read, keeps how far it got and queues itself for a minute later
 * (worker/dm-worker.ts).
 */
export function stopLostTapSearches(): void {
  shutdownRequested = true;
}

/** Tests: a new process. */
export function resetLostTapSearches(): void {
  shutdownRequested = false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** A campaign whose DM has a button: as the worker decides (lib/queue/dm-worker.ts, useOpeningDm). */
function hasOpeningDm(campaign: Campaign): boolean {
  return (
    campaign.openingDmEnabled &&
    Boolean(campaign.openingDmMessage) &&
    Boolean(campaign.openingDmButtonLabel)
  );
}

/** The progress that belongs to this search, or a fresh one. */
function progressFor(
  stored: LostTapProgress | null,
  from: Date,
  until: Date,
  now: number
): LostTapProgress {
  const fromIso = from.toISOString();
  const untilIso = until.toISOString();
  if (stored && stored.from === fromIso && stored.until === untilIso) return stored;
  const fresh: LostTapProgress = {
    v: 1,
    from: fromIso,
    until: untilIso,
    startedAt: iso(now),
    people: null,
    total: 0,
    answered: 0,
    list: { after: null, pageSize: LOST_TAP_LIST_PAGE_SIZE, pages: 0, done: false, blind: false },
    reads: 0,
    found: [],
    continued: [],
    listed: [],
    noTap: 0,
    notChecked: 0,
    stops: 0,
    resumeAt: null,
    gaveUp: false,
  };
  if (stored && stored.from === fromIso) {
    // One more silence ended while this search was owed: everybody of both
    // is looked at again, but what was continued stays continued (a tap
    // found again is the same job) and what was listed stays listed.
    return {
      ...fresh,
      continued: stored.continued,
      listed: stored.listed,
      reads: stored.reads,
      stops: stored.stops,
    };
  }
  return fresh;
}

/**
 * Run the account's search, or the part of it that is left. The job of
 * `losttaps_<account>_<from>_<until>` (lib/queue/dm-worker.ts) and its
 * continuations.
 */
export async function runLostTapSearch(
  accountId: string,
  options: LostTapSearchOptions = {}
): Promise<LostTapOutcome> {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const now = clock();
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: ACCOUNT_SELECT,
  });
  const from = account?.messagingTapSearchFrom;
  const until = account?.messagingTapSearchUntil;
  if (!account || !from || !until) return "none";
  // Meta refuses the account (A1): every read would fail. The worker's sweep
  // asks again once the connection is back.
  if (account.connectionLostAt) return "lost";

  const progress = progressFor(
    readLostTapProgress(account.messagingTapSearchProgress),
    from,
    until,
    now
  );
  if (progress.resumeAt && Date.parse(progress.resumeAt) > now + RESUME_TOLERANCE_MS) {
    return "waiting";
  }

  const lease = new Date(now);
  const claimed = await prisma.instagramAccount.updateMany({
    where: {
      id: account.id,
      messagingTapSearchFrom: from,
      messagingTapSearchUntil: until,
      OR: [
        { messagingTapSearchClaimedAt: null },
        { messagingTapSearchClaimedAt: { lt: new Date(now - CATCH_UP_LEASE_MS) } },
      ],
    },
    data: { messagingTapSearchClaimedAt: lease },
  });
  if (claimed.count !== 1) {
    // Another run holds the lease: should it have died with it, this one
    // tries again right after the lease runs out. Or the row changed since
    // it was read (one more silence ended): a fresh look in a moment.
    const heldSince = account.messagingTapSearchClaimedAt;
    const held = heldSince !== null && now - heldSince.getTime() < CATCH_UP_LEASE_MS;
    await queueLostTapSearch(account, from, until, {
      runAt: held ? heldSince.getTime() + CATCH_UP_LEASE_MS + 1_000 : now + 5_000,
      now,
    });
    return "busy";
  }

  progress.resumeAt = null;
  const run: Run = {
    account,
    from,
    until,
    lease,
    progress,
    campaigns: new Map(),
    startedAt: now,
    lastReadAt: null,
    clock,
    sleep,
  };

  try {
    run.campaigns = new Map(
      (
        await prisma.automation.findMany({
          where: { instagramAccountId: account.id },
          select: CAMPAIGN_SELECT,
        })
      ).map((campaign) => [campaign.id, campaign])
    );
    if (now - Date.parse(progress.startedAt) >= CATCH_UP_GIVE_UP_MS) {
      giveUp(run);
    } else {
      const step = await search(run);
      if (step.kind === "superseded") return await supersede(run);
      if (step.kind === "stop") return await stop(run, step);
    }
    await continueTaps(run);
    return await finish(run, options);
  } catch (error) {
    // The database or the queue: what was found and continued is kept and
    // the lease given back, so the job's retry need not wait for it.
    await saveProgress(run, { release: true }).catch(() => false);
    throw error;
  }
}

type SearchStep = { kind: "done" } | Stop | Superseded;

/** Find the people, their conversations and the taps in them. */
async function search(run: Run): Promise<SearchStep> {
  const { account, progress } = run;
  if (!progress.people) {
    const candidates = await peopleOf(run);
    progress.people = candidates.people;
    progress.total = candidates.total;
    progress.answered = candidates.answered;
    progress.notChecked += candidates.overCap;
    if (!(await saveProgress(run, { release: false }))) return { kind: "superseded" };
  }
  if (progress.people.every((person) => person.done)) return { kind: "done" };

  // Only an account connected through Meta can be read (the silence check
  // looks at no other): nobody could be looked at.
  if (account.provider !== "META" || !account.accessToken) {
    notCheckRest(run);
    return { kind: "done" };
  }
  let context: InstagramContext;
  try {
    context = await createInstagramContext(account);
  } catch (error) {
    return stopFor(run, "error", CATCH_UP_RETRY_MS, `token could not be read: ${formatError(error)}`);
  }
  if (context.provider !== "META") {
    notCheckRest(run);
    return { kind: "done" };
  }

  const listed = await findConversations(run, context);
  if (listed) return listed;
  return readConversations(run, context);
}

/**
 * The people who got an opening DM in the silence, newest first: SENT
 * comment rows (not "reveal:" or "dm:" rows) of campaigns whose DM has a
 * button, sent after `from` and at the latest at `until`, of a campaign that
 * still answers taps (active, or paused but sent to this person by hand),
 * each with the first opening DM of each campaign. Whoever has a tap or a
 * link on record since for every one of them is left out (answered), and
 * the cap leaves out the rest.
 */
async function peopleOf(run: Run): Promise<{
  people: LostTapPerson[];
  total: number;
  answered: number;
  overCap: number;
}> {
  const { account } = run;
  const ids = [...run.campaigns.values()].filter(hasOpeningDm).map((campaign) => campaign.id);
  if (ids.length === 0) return { people: [], total: 0, answered: 0, overCap: 0 };
  const rows = await prisma.dmLog.findMany({
    where: {
      instagramAccountId: account.id,
      automationId: { in: ids },
      status: "SENT",
      dmSentAt: { gt: run.from, lte: run.until },
      NOT: [{ commentId: { startsWith: "reveal:" } }, { commentId: { startsWith: "dm:" } }],
    },
    orderBy: { dmSentAt: "desc" },
    take: MAX_OPENING_DMS,
    select: {
      automationId: true,
      commenterId: true,
      commenterName: true,
      dmSentAt: true,
      matchedKeyword: true,
    },
  });
  const sorted = rows
    .flatMap((row) => (row.dmSentAt ? [{ ...row, at: row.dmSentAt.getTime() }] : []))
    .sort((a, b) => b.at - a.at);

  const byPerson = new Map<
    string,
    { userId: string; username: string | null; campaigns: Map<string, number> }
  >();
  for (const row of sorted) {
    if (!row.commenterId || row.commenterId === account.instagramId) continue;
    const campaign = run.campaigns.get(row.automationId);
    // A paused campaign answers no tap, unless the owner sent this person
    // its DM by hand (M1): the worker answers that person's taps then.
    if (!campaign || (!campaign.isActive && row.matchedKeyword !== MANUAL_MATCHED_KEYWORD)) {
      continue;
    }
    let person = byPerson.get(row.commenterId);
    if (!person) {
      person = { userId: row.commenterId, username: null, campaigns: new Map() };
      byPerson.set(row.commenterId, person);
    }
    person.username ??= row.commenterName ?? null;
    // Newest first: the last one written is the first of the silence.
    person.campaigns.set(row.automationId, row.at);
  }

  const pairs = [...byPerson.values()].flatMap((person) =>
    [...person.campaigns].map(([automationId, since]) => ({
      userId: person.userId,
      automationId,
      since,
    }))
  );
  const { recorded } = await recordedPairs(account, pairs);
  const people: LostTapPerson[] = [];
  let answered = 0;
  for (const person of byPerson.values()) {
    const campaigns = [...person.campaigns].filter(
      ([automationId]) => !recorded.has(pairKey(person.userId, automationId))
    );
    if (campaigns.length === 0) {
      answered += 1;
      continue;
    }
    people.push({
      userId: person.userId,
      username: person.username,
      campaigns: campaigns.map(([automationId, at]) => ({ automationId, openingDmAt: iso(at) })),
      conversationId: null,
      conversationUpdatedAt: null,
      done: false,
    });
  }
  const capped = people.slice(0, LOST_TAP_MAX_PEOPLE);
  return {
    people: capped,
    total: byPerson.size,
    answered,
    overCap: people.length - capped.length,
  };
}

/** The first opening DM of the silence among a person's campaigns (epoch ms). */
function firstOpeningDm(person: LostTapPerson): number {
  return Math.min(...person.campaigns.map((campaign) => Date.parse(campaign.openingDmAt)));
}

function notCheckRest(run: Run): void {
  for (const person of run.progress.people ?? []) {
    if (person.done) continue;
    person.done = true;
    run.progress.notChecked += 1;
  }
}

/** After 24 hours: whoever was not looked at yet stays so. */
function giveUp(run: Run): void {
  run.progress.gaveUp = true;
  notCheckRest(run);
}

function stopFor(run: Run, reason: Stop["reason"], waitMs: number, detail?: string): Stop {
  return { kind: "stop", reason, resumeAt: run.clock() + waitMs, detail };
}

function limitStop(run: Run, error: unknown): Stop {
  return stopFor(
    run,
    "limit",
    throttlePauseMs(error) || DEFAULT_THROTTLE_PAUSE_MINUTES * 60_000,
    formatError(error)
  );
}

function usageHigh(run: Run): boolean {
  const report = latestMetaUsage();
  return Boolean(
    report &&
      report.at >= run.startedAt &&
      accountUsagePercent(report.usage, run.account.instagramId) >= CATCH_UP_USAGE_BRAKE_PERCENT
  );
}

/**
 * Before every read: a shutdown, Meta reporting 60 % of a limit since this
 * run began, or the account's pause stops the run (no call to Meta while
 * paused); the read waits until LOST_TAP_READ_GAP_MS after the last one; and
 * the lease is renewed when due.
 */
async function beforeRead(run: Run): Promise<Stop | Superseded | null> {
  if (shutdownRequested) return stopFor(run, "shutdown", SHUTDOWN_WAIT_MS);
  if (run.lastReadAt !== null) {
    if (usageHigh(run)) return stopFor(run, "usage", CATCH_UP_BRAKE_WAIT_MS);
    const wait = run.lastReadAt + LOST_TAP_READ_GAP_MS - run.clock();
    if (wait > 0) await run.sleep(wait);
    if (shutdownRequested) return stopFor(run, "shutdown", SHUTDOWN_WAIT_MS);
  }
  const now = run.clock();
  const pausedUntil = await checkAccountPause(run.account.instagramId, now);
  if (pausedUntil !== null) {
    return {
      kind: "stop",
      reason: "paused",
      // After the pause, spread like every job that waits for it.
      resumeAt: pausedRunAt(
        pausedUntil,
        lostTapSearchJobId(run.account.id, run.from, run.until)
      ),
    };
  }
  if (now - run.lease.getTime() >= CATCH_UP_LEASE_MS / 3) {
    const renewed = new Date(now);
    const { count } = await prisma.instagramAccount.updateMany({
      where: { id: run.account.id, messagingTapSearchClaimedAt: run.lease },
      data: { messagingTapSearchClaimedAt: renewed },
    });
    if (count !== 1) return { kind: "superseded" };
    run.lease = renewed;
  }
  return null;
}

function afterRead(run: Run): void {
  run.progress.reads += 1;
  run.lastReadAt = run.clock();
}

/**
 * Find each person's conversation in the account's list, newest first, by
 * participant id. Returns a stop, or null once the list is through.
 */
async function findConversations(
  run: Run,
  context: MetaContext
): Promise<Stop | Superseded | null> {
  const { account, progress } = run;
  const list = progress.list;
  while (!list.done) {
    const wanted = new Map(
      (progress.people ?? [])
        .filter((person) => !person.done && !person.conversationId)
        .map((person) => [person.userId, person])
    );
    if (wanted.size === 0) {
      list.done = true;
      break;
    }
    if (list.pages >= LOST_TAP_MAX_LIST_PAGES) {
      // Not among the conversations the search reads: not checked.
      for (const person of wanted.values()) {
        person.done = true;
        progress.notChecked += 1;
      }
      list.done = true;
      break;
    }

    const guard = await beforeRead(run);
    if (guard) return guard;
    let page: ConversationPage;
    let blind = false;
    try {
      page = await getConversationPage(context, account.instagramId, {
        limit: list.pageSize,
        after: list.after,
      });
      afterRead(run);
    } catch (error) {
      afterRead(run);
      if (isMetaThrottle(error)) return limitStop(run, error);
      if (!(error instanceof MetaApiError) || error.code !== 1) {
        const refused = classifyConnectionError(error).outcome === "lost";
        return stopFor(run, refused ? "lost" : "error", CATCH_UP_RETRY_MS, formatError(error));
      }
      // Code 1: one entry of the page cannot be read with its participants
      // (seen with AI Studio chats, docs/conversation-recovery.md). Smaller
      // pages until it is alone, then step over it.
      if (list.pageSize > 1) {
        list.pageSize = Math.max(1, Math.floor(list.pageSize / 2));
        continue;
      }
      const again = await beforeRead(run);
      if (again) return again;
      try {
        page = await getConversationPage(context, account.instagramId, {
          limit: 1,
          after: list.after,
          fields: "id,updated_time",
        });
        afterRead(run);
      } catch (skipError) {
        afterRead(run);
        if (isMetaThrottle(skipError)) return limitStop(run, skipError);
        return stopFor(run, "error", CATCH_UP_RETRY_MS, formatError(skipError));
      }
      blind = true;
    }
    list.pages += 1;

    for (const conversation of page.data) {
      for (const participant of conversation.participants?.data ?? []) {
        if (participant.id === account.instagramId) continue;
        const person = wanted.get(participant.id);
        if (!person) continue;
        person.conversationId = conversation.id;
        const updated = timeOf(conversation.updated_time);
        person.conversationUpdatedAt = updated === null ? null : iso(updated);
        person.username ??= participant.username ?? null;
        wanted.delete(participant.id);
      }
    }
    // An entry read without its participants may be the conversation of
    // someone still wanted: they cannot be told to have no tap.
    const oldestWanted =
      wanted.size > 0 ? Math.min(...[...wanted.values()].map(firstOpeningDm)) : Infinity;
    if (blind && page.data.some((conversation) => (timeOf(conversation.updated_time) ?? Infinity) > oldestWanted)) {
      list.blind = true;
    }
    // Newest first: once a page reaches back before the oldest opening DM
    // still wanted, no later page holds a conversation that changed after
    // it, as one with a tap would have.
    const times = page.data.flatMap((conversation) => {
      const at = timeOf(conversation.updated_time);
      return at === null ? [] : [at];
    });
    const reachedBack = times.length > 0 && Math.min(...times) < oldestWanted;
    if (wanted.size === 0 || !page.after || page.data.length === 0 || reachedBack) {
      // Whoever is not in the list had no conversation that changed after
      // their opening DM: no tap.
      for (const person of wanted.values()) {
        person.done = true;
        if (list.blind) progress.notChecked += 1;
        else progress.noTap += 1;
      }
      list.done = true;
    } else {
      list.after = page.after;
    }
    // Back to full pages after one that got through.
    list.pageSize = blind ? 1 : Math.min(LOST_TAP_LIST_PAGE_SIZE, list.pageSize * 2);
    if (!(await saveProgress(run, { release: false }))) return { kind: "superseded" };
  }
  return null;
}

/** The person's campaigns as the tap rules need them. */
function tapCampaignsOf(run: Run, person: LostTapPerson): TapCampaign[] {
  return person.campaigns.flatMap((entry) => {
    const campaign = run.campaigns.get(entry.automationId);
    if (!campaign) return [];
    return [
      {
        automationId: campaign.id,
        openingDmAt: Date.parse(entry.openingDmAt),
        requireFollow: campaign.requireFollow,
        openingDmButtonLabel: campaign.openingDmButtonLabel,
        followPromptButtonLabel: campaign.followPromptButtonLabel,
        followPromptRetryButtonLabel: campaign.followPromptRetryButtonLabel,
      },
    ];
  });
}

/** Read each found conversation that changed after the opening DM, and note its lost taps. */
async function readConversations(run: Run, context: MetaContext): Promise<SearchStep> {
  const { progress } = run;
  const people = progress.people ?? [];
  // Conversations Meta refused in a row: maybe that conversation's, maybe
  // the account's. They stay open (read again by a later run) until a read
  // after them gets through, which makes them not checked.
  const refused: LostTapPerson[] = [];
  const settleRefused = () => {
    for (const person of refused) {
      person.done = true;
      progress.notChecked += 1;
    }
    refused.length = 0;
  };
  for (const person of people) {
    if (person.done) continue;
    if (!person.conversationId) {
      person.done = true;
      progress.noTap += 1;
      continue;
    }
    const updated = timeOf(person.conversationUpdatedAt);
    if (updated !== null && updated <= firstOpeningDm(person)) {
      // Nothing came after the opening DM: no tap, and no read needed.
      person.done = true;
      progress.noTap += 1;
      continue;
    }

    const guard = await beforeRead(run);
    if (guard) return guard;
    let messages: InstagramMessage[];
    try {
      messages = await getConversationMessages(context, person.conversationId, {
        timeoutMs: READ_TIMEOUT_MS,
      });
      afterRead(run);
    } catch (error) {
      afterRead(run);
      if (isMetaThrottle(error)) return limitStop(run, error);
      const classified = classifyConnectionError(error);
      if (classified.outcome === "lost") {
        if (classified.kind === "token" || refused.length + 1 >= MAX_REFUSED_IN_ROW) {
          // The account, not a conversation: these people are read again later.
          return stopFor(run, "lost", CATCH_UP_RETRY_MS, formatError(error));
        }
        refused.push(person);
        continue;
      }
      // This conversation only: on to the next one.
      console.warn(
        `[Lost taps] @${run.account.username}: a conversation could not be read (${formatError(error)})`
      );
      settleRefused();
      person.done = true;
      progress.notChecked += 1;
      if (!(await saveProgress(run, { release: false }))) return { kind: "superseded" };
      continue;
    }
    settleRefused();

    const taps = findLostTaps(person.userId, tapCampaignsOf(run, person), messages);
    for (const tap of taps) {
      const entry = person.campaigns.find((campaign) => campaign.automationId === tap.automationId);
      progress.found.push({
        userId: person.userId,
        username: person.username,
        automationId: tap.automationId,
        campaignName: run.campaigns.get(tap.automationId)?.name ?? "",
        openingDmAt: entry?.openingDmAt ?? iso(tap.tappedAt),
        messageId: tap.messageId,
        tappedAt: iso(tap.tappedAt),
        payload: tap.payload,
      });
    }
    if (taps.length === 0) progress.noTap += 1;
    person.done = true;
    if (!(await saveProgress(run, { release: false }))) return { kind: "superseded" };
  }
  settleRefused();
  return { kind: "done" };
}

/**
 * Whether the campaign still answers this person's taps, as the worker
 * decides (lib/queue/dm-worker.ts, findConversationCampaign): active, or
 * paused but sent to this person by hand.
 */
async function answersTaps(campaign: Campaign | undefined, userId: string): Promise<boolean> {
  if (!campaign) return false;
  if (campaign.isActive) return true;
  const manual = await prisma.dmLog.findFirst({
    where: {
      automationId: campaign.id,
      commenterId: userId,
      matchedKeyword: MANUAL_MATCHED_KEYWORD,
      OR: [{ status: "SENT" }, { dmDeliveryUnconfirmed: true }],
    },
    select: { id: true },
  });
  return manual !== null;
}

function listTap(run: Run, tap: FoundTap, reason: "window" | "campaign"): void {
  const { listed } = run.progress;
  const entry = {
    username: tap.username,
    campaign: run.campaigns.get(tap.automationId)?.name ?? tap.campaignName,
    tappedAt: tap.tappedAt,
    reason,
  };
  if (
    listed.some(
      (item) =>
        item.username === entry.username &&
        item.campaign === entry.campaign &&
        item.tappedAt === entry.tappedAt
    )
  ) {
    return;
  }
  listed.push(entry);
}

/**
 * Continue the lost taps found, the oldest first (its window closes first):
 * each as the postback job its tap would have produced, in the next slot of
 * the account's lost-tap pace, while Instagram's 24 hours from the tap leave
 * an hour; the others are listed. A tap the person made again in the
 * meantime, which arrived, was answered the ordinary way.
 */
async function continueTaps(run: Run): Promise<void> {
  const { account, progress } = run;
  if (progress.found.length === 0) return;
  const found = [...progress.found].sort(
    (a, b) => Date.parse(a.tappedAt) - Date.parse(b.tappedAt)
  );
  const { recorded } = await recordedPairs(
    account,
    found.map((tap) => ({
      userId: tap.userId,
      automationId: tap.automationId,
      since: Date.parse(tap.openingDmAt),
    }))
  );
  for (const tap of found) {
    const jobId = lostTapJobId(account.instagramId, tap.userId, tap.messageId);
    if (progress.continued.some((item) => item.jobId === jobId)) {
      progress.found = progress.found.filter((item) => item !== tap);
      continue;
    }
    if (recorded.has(pairKey(tap.userId, tap.automationId))) {
      progress.answered += 1;
    } else if (!(await answersTaps(run.campaigns.get(tap.automationId), tap.userId))) {
      listTap(run, tap, "campaign");
    } else {
      const tappedAt = Date.parse(tap.tappedAt);
      const now = run.clock();
      const earliest = Math.max(now, tappedAt + LOST_TAP_FRESH_MS);
      const runAt = tapWindowOpen(tappedAt, earliest)
        ? await reservePacedSlot(lostTapPaceKey(account.instagramId), {
            earliest,
            spacingMs: LOST_TAP_SPACING_MS,
            now,
          })
        : null;
      if (runAt === null || !tapWindowOpen(tappedAt, runAt)) {
        listTap(run, tap, "window");
      } else {
        const data: ProcessPostbackJob = {
          instagramAccountId: account.instagramId,
          accountConnectionId: account.id,
          userId: tap.userId,
          payload: tap.payload,
          mid: tap.messageId,
          tappedAt,
          lostTap: true,
        };
        await getDMQueue().add(POSTBACK_JOB_NAME, data, {
          jobId,
          delay: Math.max(0, runAt - now),
        });
        progress.continued.push({
          jobId,
          userId: tap.userId,
          automationId: tap.automationId,
          tappedAt: tap.tappedAt,
          runAt: iso(runAt),
        });
      }
    }
    progress.found = progress.found.filter((item) => item !== tap);
  }
}

/**
 * Keep how far the run got, on the row it holds the lease of: renewed, or
 * given back. False when the lease is no longer this run's.
 */
async function saveProgress(run: Run, { release }: { release: boolean }): Promise<boolean> {
  const renewed = new Date(run.clock());
  const { count } = await prisma.instagramAccount.updateMany({
    where: {
      id: run.account.id,
      messagingTapSearchFrom: run.from,
      messagingTapSearchUntil: run.until,
      messagingTapSearchClaimedAt: run.lease,
    },
    data: {
      messagingTapSearchProgress: asJson(run.progress),
      messagingTapSearchClaimedAt: release ? null : renewed,
    },
  });
  if (count === 1 && !release) run.lease = renewed;
  return count === 1;
}

/**
 * The row changed under the run. Either another run took the lease over
 * (this one's worker was thought dead): it does the rest. Or one more
 * silence ended and was merged into this search (its start kept, a later
 * end): the lease is given back with what this run found and continued, and
 * the search is asked for again, for both silences.
 */
async function supersede(run: Run): Promise<LostTapOutcome> {
  const { account } = run;
  const { count } = await prisma.instagramAccount.updateMany({
    where: { id: account.id, messagingTapSearchClaimedAt: run.lease },
    data: {
      messagingTapSearchProgress: asJson(run.progress),
      messagingTapSearchClaimedAt: null,
    },
  });
  if (count !== 1) return "superseded";
  const current = await prisma.instagramAccount.findUnique({
    where: { id: account.id },
    select: {
      connectionLostAt: true,
      messagingTapSearchFrom: true,
      messagingTapSearchUntil: true,
    },
  });
  if (current?.messagingTapSearchFrom && current.messagingTapSearchUntil && !current.connectionLostAt) {
    // Not before the gap after this run's last read.
    await queueLostTapSearch(
      account,
      current.messagingTapSearchFrom,
      current.messagingTapSearchUntil,
      { runAt: run.clock() + LOST_TAP_READ_GAP_MS, now: run.clock() }
    );
  }
  return "superseded";
}

/** Stop early: keep the progress, give the lease back, queue the rest for later. */
async function stop(run: Run, step: Stop): Promise<LostTapOutcome> {
  const { account, progress } = run;
  progress.resumeAt = iso(step.resumeAt);
  progress.stops += 1;
  if (!(await saveProgress(run, { release: true }))) return await supersede(run);
  await queueLostTapSearch(account, run.from, run.until, {
    runAt: step.resumeAt,
    now: run.clock(),
  });
  console.log(
    `[Lost taps] @${account.username}: stopped (${step.reason}${step.detail ? `: ${step.detail}` : ""}); goes on at ${formatPauseTime(step.resumeAt)}`
  );
  return step.reason === "paused" ? "paused" : "stopped";
}

/** The end: the result on the row, at most once, then the all-clear e-mail. */
async function finish(run: Run, options: LostTapSearchOptions): Promise<LostTapOutcome> {
  const { account, progress } = run;
  const finishedAt = new Date(run.clock());
  const runTimes = progress.continued.map((item) => Date.parse(item.runAt));
  const taps: LostTapResult = {
    v: 1,
    finishedAt: finishedAt.toISOString(),
    people: progress.total,
    continued: progress.continued.length,
    firstJobAt: runTimes.length > 0 ? iso(Math.min(...runTimes)) : null,
    lastJobAt: runTimes.length > 0 ? iso(Math.max(...runTimes)) : null,
    listed: progress.listed,
    noTap: progress.noTap,
    answered: progress.answered,
    notChecked: progress.notChecked,
    reads: progress.reads,
    gaveUp: progress.gaveUp,
    complete: progress.notChecked === 0 && !progress.gaveUp,
  };
  const silence: MessagingSilenceResult = readMessagingSilenceResult(
    account.messagingSilenceResult
  ) ?? {
    v: 1,
    since: run.from.toISOString(),
    endedAt: run.until.toISOString(),
    via: "check",
  };
  const { count } = await prisma.instagramAccount.updateMany({
    where: {
      id: account.id,
      messagingTapSearchFrom: run.from,
      messagingTapSearchUntil: run.until,
      messagingTapSearchClaimedAt: run.lease,
    },
    data: {
      messagingTapSearchFrom: null,
      messagingTapSearchUntil: null,
      messagingTapSearchClaimedAt: null,
      messagingTapSearchProgress: Prisma.DbNull,
      messagingSilenceResult: asJson({ ...silence, taps }),
      messagingAllClearDueAt: finishedAt,
    },
  });
  if (count !== 1) {
    // One more silence ended and was merged into this search (its start
    // kept): what was continued stays continued, and the search runs again
    // for both.
    return await supersede(run);
  }

  const message = `Search for lost taps after the messaging silence of @${account.username}: ${taps.continued} taps continued (one every ${LOST_TAP_SPACING_MS / 1000} s), ${taps.listed.length} too late or for a paused campaign, ${taps.noTap} people without a tap, ${taps.answered} answered after the silence${taps.notChecked > 0 ? `, ${taps.notChecked} not checked` : ""}${taps.gaveUp ? ", stopped after 24 hours" : ""}; ${taps.reads} conversation reads`;
  console.log(`[Lost taps] ${message}`);
  await logWorkerEvent({
    workspaceId: account.workspaceId,
    level: taps.complete ? "INFO" : "WARNING",
    message,
    payload: {
      kind: MESSAGING_TAP_SEARCH_EVENT,
      account: account.username,
      continued: taps.continued,
      listed: taps.listed.length,
      noTap: taps.noTap,
      notChecked: taps.notChecked,
      reads: taps.reads,
    },
  });

  try {
    await sendMessagingSilenceAllClear(account.id, {
      now: run.clock(),
      ...(options.transport !== undefined ? { transport: options.transport } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
  } catch (error) {
    // Still owed: the worker's next sweep sends it.
    console.error("[Lost taps] All-clear e-mail not sent yet:", formatError(error));
  }
  return "done";
}

/**
 * With every comment sweep (worker/dm-worker.ts): ask again for a search
 * that is owed and neither running nor queued for later (its request was
 * lost, or the worker restarted), unless the account's connection is lost.
 * Database reads only, no Meta call.
 */
export async function resumeLostTapSearches({
  clock = Date.now,
}: { clock?: () => number } = {}): Promise<{ requested: number }> {
  const now = clock();
  const accounts = await prisma.instagramAccount.findMany({
    where: {
      messagingTapSearchFrom: { not: null },
      messagingTapSearchUntil: { not: null },
    },
    select: {
      id: true,
      instagramId: true,
      username: true,
      connectionLostAt: true,
      messagingTapSearchFrom: true,
      messagingTapSearchUntil: true,
      messagingTapSearchClaimedAt: true,
      messagingTapSearchProgress: true,
    },
  });
  let requested = 0;
  for (const account of accounts) {
    try {
      const from = account.messagingTapSearchFrom;
      const until = account.messagingTapSearchUntil;
      const running =
        account.messagingTapSearchClaimedAt !== null &&
        now - account.messagingTapSearchClaimedAt.getTime() < CATCH_UP_LEASE_MS;
      if (!from || !until || account.connectionLostAt || running) continue;
      const stored = readLostTapProgress(account.messagingTapSearchProgress);
      const ours =
        stored && stored.from === from.toISOString() && stored.until === until.toISOString();
      const resumeAt = ours && stored.resumeAt ? Date.parse(stored.resumeAt) : null;
      if (resumeAt === null || now >= resumeAt + RESUME_GRACE_MS) {
        if (await queueLostTapSearch(account, from, until, { now })) requested += 1;
      }
    } catch (error) {
      console.error(
        `[Lost taps] @${account.username}: could not look at the search:`,
        formatError(error)
      );
    }
  }
  return { requested };
}
