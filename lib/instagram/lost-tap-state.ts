/**
 * The search for lost taps after a messaging silence (A2 requirement 4): the
 * rules that decide, from one conversation, which button tap Instagram
 * swallowed and what it would have set off, and the search as it is stored
 * on the InstagramAccount row and read back by the worker
 * (lib/instagram/lost-tap-search.ts), Diagnostics and the all-clear e-mail.
 *
 * - messagingTapSearchProgress: how far a search that stopped early got
 *   (LostTapProgress), so the next run goes on from there.
 * - messagingSilenceResult.taps: the finished search (LostTapResult), next to
 *   the silence it belongs to (lib/instagram/messaging-silence-incident.ts).
 *
 * A tap shows up in the Conversations API as a message from the person whose
 * text is the button's title (verified on 2026-11-26 with the test account).
 * Whatever does not read as this version's shape counts as missing.
 *
 * Client-safe: no database, queue or Meta import.
 */

import { CATCH_UP_SPACING_MS } from "@/lib/instagram/catch-up-state";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** People whose conversation one search reads, at most, per incident. */
export const LOST_TAP_MAX_PEOPLE = 50;
/**
 * The time between two Conversations API reads of a search. On 2026-11-21
 * about 25 private replies and 50 conversation reads in one hour ran into
 * Meta's app limit (code 4): the reads stay few (one per person, and none
 * for a conversation that did not change after the opening DM) and spread
 * out, well above the 2 seconds A1's catch-up keeps between its reads.
 */
export const LOST_TAP_READ_GAP_MS = 5_000;
/** Conversations one page of the list asks for (Meta's most). */
export const LOST_TAP_LIST_PAGE_SIZE = 50;
/**
 * Pages of the conversation list a search reads, at most: newest first, so
 * they reach back to the silence for any account that is not flooded with
 * DMs. A person whose conversation was not among them counts as not checked.
 */
export const LOST_TAP_MAX_LIST_PAGES = 10;
/** Instagram lets the account message a person this long after their tap. */
export const MESSAGING_WINDOW_MS = 24 * HOUR;
/** A lost tap is continued only if its window has this much left when its job runs. */
export const LOST_TAP_WINDOW_MARGIN_MS = HOUR;
/**
 * The continued taps go out this far apart, the first right away: the pace
 * of A1's catch-up (24 an hour), for the same reason as the reads. They have
 * a pace of their own (lib/queue/send-pacing.ts, lostTapPaceKey), so they
 * never wait behind a catch-up's comments.
 */
export const LOST_TAP_SPACING_MS = CATCH_UP_SPACING_MS;
/**
 * A tap this fresh may still be on its way as a webhook: its job runs at the
 * earliest this long after it, by which time the webhook's own job has
 * answered it and this one stands back (lib/instagram/lost-tap-records.ts).
 */
export const LOST_TAP_FRESH_MS = 2 * MINUTE;
/** How long Diagnostics shows a finished search: as the silence, 7 days. */
export const LOST_TAP_REPORT_MS = 7 * 24 * HOUR;
/**
 * Opening DMs this long before the silence began are searched as well: a
 * tap on one of them in the silence got lost the same way, and people do tap
 * the next day (of the first taps on an opening DM from 2026-11-20 to 25, two
 * came 15 and 25 hours after it). Only taps in the silence count for them.
 */
export const LOST_TAP_LOOKBACK_MS = 24 * HOUR;

/** The follow prompt's button when the campaign names none (lib/queue/dm-worker.ts). */
export const DEFAULT_FOLLOW_BUTTON = "i'm following";

/** What a campaign's buttons are, for telling a tap on them. */
export interface TapCampaign {
  automationId: string;
  /** A tap counts only after this (epoch ms): the person's first opening DM of the campaign in the silence. */
  openingDmAt: number;
  requireFollow: boolean;
  openingDmButtonLabel: string | null;
  followPromptButtonLabel: string | null;
  followPromptRetryButtonLabel: string | null;
}

/** A message of a conversation, as the Conversations API gives it. */
export interface ConversationMessage {
  id?: string;
  created_time?: string;
  message?: string;
  from?: { id?: string };
}

/** Which button of a campaign a tap was on. */
export type TapButton = "open" | "follow" | "retry";

/** A tap found in a conversation: what the webhook would have brought. */
export interface LostTap {
  automationId: string;
  /** Instagram's id of the tap, as the conversation shows it. */
  messageId: string;
  /** When the person tapped (epoch ms). */
  tappedAt: number;
  /** The button's postback payload, as the campaign sends it. */
  payload: string;
  /**
   * Not this campaign's for sure: a button of another campaign says the
   * same, and the tap went to that one (findLostTaps). Listed, never
   * continued.
   */
  unclear?: true;
}

function normalized(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Whether a message's text is a button's title: the label as written, or as
 * the button showed it (Meta takes the first 20 characters of a title,
 * lib/meta/client.ts).
 */
function isTitleOf(label: string | null | undefined, text: string): boolean {
  if (!label || !normalized(label)) return false;
  return normalized(label) === text || normalized(label.slice(0, 20)) === text;
}

/**
 * Which of the campaign's buttons a message with this text was a tap on, or
 * null: the opening DM's button, or (for a campaign with a follow gate) the
 * follow prompt's or the second follow request's, with the defaults the
 * worker sends (lib/queue/dm-worker.ts). The opening DM's button wins a tie.
 */
export function tapButton(campaign: TapCampaign, text: string): TapButton | null {
  const said = normalized(text);
  if (!said) return null;
  if (isTitleOf(campaign.openingDmButtonLabel, said)) return "open";
  if (!campaign.requireFollow) return null;
  const first = campaign.followPromptButtonLabel || DEFAULT_FOLLOW_BUTTON;
  if (isTitleOf(first, said)) return "follow";
  const retry =
    campaign.followPromptRetryButtonLabel ||
    campaign.followPromptButtonLabel ||
    DEFAULT_FOLLOW_BUTTON;
  return isTitleOf(retry, said) ? "retry" : null;
}

/**
 * The postback payload of a campaign's button, exactly as the worker sends
 * it (lib/queue/dm-worker.ts): the opening DM's
 * `${requireFollow ? "followcheck" : "reveal"}:<campaign>:open`, the follow
 * prompt's `followcheck:<campaign>`, the second follow request's
 * `followcheck:<campaign>:retry`.
 */
export function tapPayload(
  campaign: Pick<TapCampaign, "automationId" | "requireFollow">,
  button: TapButton
): string {
  switch (button) {
    case "open":
      return `${campaign.requireFollow ? "followcheck" : "reveal"}:${campaign.automationId}:open`;
    case "follow":
      return `followcheck:${campaign.automationId}`;
    case "retry":
      return `followcheck:${campaign.automationId}:retry`;
  }
}

/** The campaign a button tap's payload names (reveal:<id>…, followcheck:<id>…), or null. */
export function campaignOfTapPayload(payload: unknown): string | null {
  if (typeof payload !== "string") return null;
  const match = /^(?:reveal|followcheck):([^:]+)/.exec(payload);
  return match ? match[1] : null;
}

function timeOfMessage(message: ConversationMessage): number {
  return message.created_time ? Date.parse(message.created_time) : Number.NaN;
}

/**
 * The lost taps in one person's conversation, oldest first, at most one per
 * campaign: a message from the person (no one else's, never the account's
 * own) whose text is the title of one of the campaign's buttons and that is
 * newer than the person's opening DM of that campaign, and than `after`
 * (epoch ms: the silence's start; a tap before it arrived, or would have).
 *
 * The resource campaigns all say "Ja, schick ihn mir", so one text may be a
 * tap on the buttons of several campaigns whose opening DMs the person got.
 * The taps go to distinct campaigns, the newest first, each to the campaign
 * with the latest opening DM before it that has none yet: two taps after two
 * such DMs are one for each, and of several taps on one campaign the newest
 * counts (it opened the latest window, and every tap asked for the same). A
 * campaign that one of the taps may have been for but that got none is
 * returned too, marked `unclear`, with the newest such tap: it is listed,
 * never continued, as nothing tells whether the person meant it.
 */
export function findLostTaps(
  userId: string,
  campaigns: readonly TapCampaign[],
  messages: readonly ConversationMessage[],
  { after = -Infinity }: { after?: number } = {}
): LostTap[] {
  const taps = messages
    .flatMap((message) => {
      const text = message.message;
      if (message.from?.id !== userId || !message.id || typeof text !== "string") return [];
      const at = timeOfMessage(message);
      if (!Number.isFinite(at) || at <= after) return [];
      const candidates = campaigns.flatMap((campaign) => {
        if (at <= campaign.openingDmAt) return [];
        const button = tapButton(campaign, text);
        return button ? [{ campaign, button }] : [];
      });
      return candidates.length > 0 ? [{ id: message.id, at, candidates }] : [];
    })
    // Newest first; the same second in the conversation's order.
    .sort((a, b) => b.at - a.at);

  const given = new Map<string, LostTap>();
  const maybe = new Map<string, LostTap>();
  for (const tap of taps) {
    const free = tap.candidates
      .filter((candidate) => !given.has(candidate.campaign.automationId))
      .sort((a, b) => b.campaign.openingDmAt - a.campaign.openingDmAt);
    const chosen = free[0];
    if (chosen) {
      given.set(chosen.campaign.automationId, {
        automationId: chosen.campaign.automationId,
        messageId: tap.id,
        tappedAt: tap.at,
        payload: tapPayload(chosen.campaign, chosen.button),
      });
    }
    for (const candidate of tap.candidates) {
      const id = candidate.campaign.automationId;
      if (candidate === chosen || maybe.has(id)) continue;
      maybe.set(id, {
        automationId: id,
        messageId: tap.id,
        tappedAt: tap.at,
        payload: tapPayload(candidate.campaign, candidate.button),
        unclear: true,
      });
    }
  }
  const unclear = [...maybe.values()].filter((tap) => !given.has(tap.automationId));
  return [...given.values(), ...unclear].sort((a, b) => a.tappedAt - b.tappedAt);
}

/** A stretch in which OpenReply itself sent the person up to `count` messages (epoch ms). */
export interface OwnSends {
  from: number;
  until: number;
  count: number;
}

/**
 * How far from a send of OpenReply's own that the database records a
 * message may be and still be that send: the record is written right after
 * Instagram took the message.
 */
export const OWN_SEND_TOLERANCE_MS = 2 * MINUTE;

/**
 * The messages of a conversation newer than `after` (epoch ms) that are not
 * from the person and that none of OpenReply's own sends to them explains:
 * someone wrote to them, by hand in Instagram or in OpenReply's inbox, or
 * another tool. Each stretch of own sends explains at most its `count`
 * messages within OWN_SEND_TOLERANCE_MS of it, each message the stretch that
 * ends first (which explains as many as can be). A message without its time
 * or its sender counts as such a message: a tap answered by hand must never
 * be answered once more.
 */
export function unexplainedReplies(
  userId: string,
  after: number,
  messages: readonly ConversationMessage[],
  own: readonly OwnSends[]
): ConversationMessage[] {
  const replies = messages
    .filter((message) => message.from?.id !== userId)
    .map((message) => ({ message, at: timeOfMessage(message) }))
    .filter(({ at }) => !Number.isFinite(at) || at > after)
    .sort((a, b) => (Number.isFinite(a.at) ? a.at : Infinity) - (Number.isFinite(b.at) ? b.at : Infinity));
  const stretches = own.map((send) => ({
    from: send.from - OWN_SEND_TOLERANCE_MS,
    until: send.until + OWN_SEND_TOLERANCE_MS,
    left: send.count,
  }));
  const unexplained: ConversationMessage[] = [];
  for (const { message, at } of replies) {
    const stretch = Number.isFinite(at)
      ? stretches
          .filter((item) => item.left > 0 && item.from <= at && at <= item.until)
          .sort((a, b) => a.until - b.until)[0]
      : undefined;
    if (stretch) stretch.left -= 1;
    else unexplained.push(message);
  }
  return unexplained;
}

/**
 * Whether a tap at `tappedAt` can still be answered by a job that runs at
 * `runAt`: Instagram's 24 hours from the tap leave at least an hour.
 */
export function tapWindowOpen(tappedAt: number, runAt: number): boolean {
  return tappedAt + MESSAGING_WINDOW_MS - runAt >= LOST_TAP_WINDOW_MARGIN_MS;
}

/**
 * The id of the job that runs an account's search:
 * `losttaps_<account row>_<from in ms>_<until in ms>`, the same for every
 * request of one search (the end of the silence, the worker's sweep), so
 * they queue it once while it waits or runs. A run that stops early queues
 * `…_<resume time in ms>` for when it may go on.
 */
export function lostTapSearchJobId(
  accountId: string,
  from: Date,
  until: Date,
  resumeAt?: number
): string {
  const base = `losttaps_${accountId}_${from.getTime()}_${until.getTime()}`;
  return resumeAt === undefined ? base : `${base}_${Math.floor(resumeAt)}`;
}

/** One campaign whose opening DM a person got in the silence. */
export interface LostTapPersonCampaign {
  automationId: string;
  /** Their first opening DM of the campaign in the silence (ISO). */
  openingDmAt: string;
}

/** A person the search looks at. */
export interface LostTapPerson {
  /** The person's Instagram-scoped id (DmLog.commenterId). */
  userId: string;
  /** Their handle, without "@", when known. */
  username: string | null;
  campaigns: LostTapPersonCampaign[];
  /** Their conversation with the account, once the list found it. */
  conversationId: string | null;
  /** When that conversation last changed (ISO), as the list said. */
  conversationUpdatedAt: string | null;
  /** Looked at: nothing more to do for them. */
  done: boolean;
}

/** A lost tap the search found, before it is continued or listed. */
export interface FoundTap {
  userId: string;
  username: string | null;
  automationId: string;
  /** The campaign's name when the tap was found, for the list. */
  campaignName: string;
  /** The opening DM the tap followed (ISO): a tap or link on record since settles it. */
  openingDmAt: string;
  messageId: string;
  /** ISO */
  tappedAt: string;
  payload: string;
  /**
   * Listed, never continued: someone wrote to the person after the tap
   * ("replied"), or the tap may have been another campaign's ("unclear").
   */
  listOnly?: "replied" | "unclear";
}

/** A lost tap whose flow goes on: its postback job is queued. */
export interface ContinuedTap {
  jobId: string;
  userId: string;
  automationId: string;
  /** ISO */
  tappedAt: string;
  /** When its job runs (ISO). */
  runAt: string;
}

/** Why a lost tap is listed instead of continued (ListedTap). */
export type ListedReason = "window" | "campaign" | "replied" | "unclear";

/** Every reason, for reading one back. */
const LISTED_REASONS: readonly ListedReason[] = ["window", "campaign", "replied", "unclear"];

/**
 * A lost tap that is not continued, as the all-clear and Diagnostics list
 * it: Instagram's 24 hours from the tap leave less than an hour ("window"),
 * the campaign no longer answers taps (paused or gone, "campaign"), someone
 * wrote to the person after the tap, maybe the link by hand ("replied"), or
 * a button of another of the person's campaigns says the same, and the tap
 * may have been for that one ("unclear").
 */
export interface ListedTap {
  /** The person's handle, without "@", when known. */
  username: string | null;
  /** The campaign's name. */
  campaign: string;
  /** When they tapped (ISO). */
  tappedAt: string;
  reason: ListedReason;
}

/** How far a search got; written when a run stops early. */
export interface LostTapProgress {
  v: 1;
  /** The messagingTapSearchFrom and messagingTapSearchUntil it belongs to (ISO). */
  from: string;
  until: string;
  /** When the search's first run began (ISO). */
  startedAt: string;
  /** The people to look at, newest opening DM first, once read from the database. */
  people: LostTapPerson[] | null;
  /** People with an opening DM in the silence, in all (the ones over the cap included). */
  total: number;
  /** People who tapped again or got the link after the silence: nothing to search. */
  answered: number;
  /**
   * The conversation list: the cursor of its next page, its page size, the
   * pages read, whether it is through, and whether an entry that may be a
   * wanted person's could not be read with its participants (then a person
   * not found in it is not checked rather than without a tap).
   */
  list: { after: string | null; pageSize: number; pages: number; done: boolean; blind: boolean };
  /** Conversations API reads so far. */
  reads: number;
  /** Lost taps found and not yet continued or listed. */
  found: FoundTap[];
  continued: ContinuedTap[];
  listed: ListedTap[];
  /** People looked at without a lost tap. */
  noTap: number;
  /** People not looked at: over the cap, their conversation not found or not readable, out of time. */
  notChecked: number;
  /** How often a run stopped early. */
  stops: number;
  /** Not before this time (ISO): the run that stopped queued one for then. */
  resumeAt: string | null;
  /** The search ran out of time and ended with what it had. */
  gaveUp: boolean;
}

/** A finished search, as Diagnostics and the all-clear e-mail show it. */
export interface LostTapResult {
  v: 1;
  finishedAt: string;
  /** People who got an opening DM in the silence. */
  people: number;
  /** Lost taps whose flow goes on now, one every LOST_TAP_SPACING_MS. */
  continued: number;
  firstJobAt: string | null;
  lastJobAt: string | null;
  /** Lost taps that could not be continued. */
  listed: ListedTap[];
  /** People looked at who had not tapped. */
  noTap: number;
  /** People who tapped again or got the link after the silence. */
  answered: number;
  /** People who could not be looked at. */
  notChecked: number;
  reads: number;
  gaveUp: boolean;
  /** Everybody was looked at. */
  complete: boolean;
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

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function list<T>(value: unknown, read: (item: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = isRecord(item) ? read(item) : null;
    return parsed === null ? [] : [parsed];
  });
}

function readListed(item: Record<string, unknown>): ListedTap | null {
  if (typeof item.campaign !== "string" || !isTime(item.tappedAt)) return null;
  return {
    username: textOrNull(item.username),
    campaign: item.campaign,
    tappedAt: item.tappedAt,
    reason: LISTED_REASONS.find((reason) => reason === item.reason) ?? "window",
  };
}

function readPerson(item: Record<string, unknown>): LostTapPerson | null {
  if (typeof item.userId !== "string" || !item.userId) return null;
  const campaigns = list(item.campaigns, (campaign) =>
    typeof campaign.automationId === "string" && isTime(campaign.openingDmAt)
      ? { automationId: campaign.automationId, openingDmAt: campaign.openingDmAt }
      : null
  );
  if (campaigns.length === 0) return null;
  return {
    userId: item.userId,
    username: textOrNull(item.username),
    campaigns,
    conversationId: textOrNull(item.conversationId),
    conversationUpdatedAt: timeOrNull(item.conversationUpdatedAt),
    done: item.done === true,
  };
}

function readFound(item: Record<string, unknown>): FoundTap | null {
  if (
    typeof item.userId !== "string" ||
    typeof item.automationId !== "string" ||
    typeof item.messageId !== "string" ||
    typeof item.payload !== "string" ||
    !isTime(item.tappedAt) ||
    !isTime(item.openingDmAt)
  ) {
    return null;
  }
  return {
    userId: item.userId,
    username: textOrNull(item.username),
    automationId: item.automationId,
    campaignName: typeof item.campaignName === "string" ? item.campaignName : "",
    openingDmAt: item.openingDmAt,
    messageId: item.messageId,
    tappedAt: item.tappedAt,
    payload: item.payload,
    ...(item.listOnly === "replied" || item.listOnly === "unclear"
      ? { listOnly: item.listOnly }
      : {}),
  };
}

function readContinued(item: Record<string, unknown>): ContinuedTap | null {
  if (
    typeof item.jobId !== "string" ||
    typeof item.userId !== "string" ||
    typeof item.automationId !== "string" ||
    !isTime(item.tappedAt) ||
    !isTime(item.runAt)
  ) {
    return null;
  }
  return {
    jobId: item.jobId,
    userId: item.userId,
    automationId: item.automationId,
    tappedAt: item.tappedAt,
    runAt: item.runAt,
  };
}

/** The stored progress, or null for none or one this version cannot read. */
export function readLostTapProgress(value: unknown): LostTapProgress | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (!isTime(value.from) || !isTime(value.until) || !isTime(value.startedAt)) return null;
  const rawList = isRecord(value.list) ? value.list : {};
  const pageSize = count(rawList.pageSize);
  return {
    v: 1,
    from: value.from,
    until: value.until,
    startedAt: value.startedAt,
    people: Array.isArray(value.people) ? list(value.people, readPerson) : null,
    total: count(value.total),
    answered: count(value.answered),
    list: {
      after: textOrNull(rawList.after),
      pageSize: pageSize > 0 ? Math.min(pageSize, LOST_TAP_LIST_PAGE_SIZE) : LOST_TAP_LIST_PAGE_SIZE,
      pages: count(rawList.pages),
      done: rawList.done === true,
      blind: rawList.blind === true,
    },
    reads: count(value.reads),
    found: list(value.found, readFound),
    continued: list(value.continued, readContinued),
    listed: list(value.listed, readListed),
    noTap: count(value.noTap),
    notChecked: count(value.notChecked),
    stops: count(value.stops),
    resumeAt: timeOrNull(value.resumeAt),
    gaveUp: value.gaveUp === true,
  };
}

/** The stored result, or null for none or one this version cannot read. */
export function readLostTapResult(value: unknown): LostTapResult | null {
  if (!isRecord(value) || value.v !== 1 || !isTime(value.finishedAt)) return null;
  const notChecked = count(value.notChecked);
  const gaveUp = value.gaveUp === true;
  return {
    v: 1,
    finishedAt: value.finishedAt,
    people: count(value.people),
    continued: count(value.continued),
    firstJobAt: timeOrNull(value.firstJobAt),
    lastJobAt: timeOrNull(value.lastJobAt),
    listed: list(value.listed, readListed),
    noTap: count(value.noTap),
    answered: count(value.answered),
    notChecked,
    reads: count(value.reads),
    gaveUp,
    complete: notChecked === 0 && !gaveUp,
  };
}

function earliest(a: string | null, b: string | null): string | null {
  if (!a || !b) return a ?? b;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function latest(a: string | null, b: string | null): string | null {
  if (!a || !b) return a ?? b;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Two finished searches as one, for the all-clear that reports both: the
 * search after an earlier silence whose all-clear never went out (a new
 * silence was open by then) and the one after the silence it is reported
 * with (lib/instagram/messaging-silence-state.ts). Counts add up, the lists
 * join (each tap once), and it finished with the later one.
 */
export function mergeLostTapResults(earlier: LostTapResult, later: LostTapResult): LostTapResult {
  const listed = [...earlier.listed];
  for (const entry of later.listed) {
    if (
      !listed.some(
        (item) =>
          item.username === entry.username &&
          item.campaign === entry.campaign &&
          item.tappedAt === entry.tappedAt
      )
    ) {
      listed.push(entry);
    }
  }
  const notChecked = earlier.notChecked + later.notChecked;
  const gaveUp = earlier.gaveUp || later.gaveUp;
  return {
    v: 1,
    finishedAt: latest(earlier.finishedAt, later.finishedAt) ?? later.finishedAt,
    people: earlier.people + later.people,
    continued: earlier.continued + later.continued,
    firstJobAt: earliest(earlier.firstJobAt, later.firstJobAt),
    lastJobAt: latest(earlier.lastJobAt, later.lastJobAt),
    listed,
    noTap: earlier.noTap + later.noTap,
    answered: earlier.answered + later.answered,
    notChecked,
    reads: earlier.reads + later.reads,
    gaveUp,
    complete: notChecked === 0 && !gaveUp,
  };
}
