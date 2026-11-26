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

/**
 * The lost taps in one person's conversation, oldest first, at most one per
 * campaign: a message from the person (no one else's, never the account's
 * own) whose text is the title of one of the campaign's buttons and that is
 * newer than the person's opening DM of that campaign. Of several, the
 * newest: it opened the latest window, and every tap asked for the same.
 * A text that two campaigns' buttons share is the tap on the one whose
 * opening DM came last before it.
 */
export function findLostTaps(
  userId: string,
  campaigns: readonly TapCampaign[],
  messages: readonly ConversationMessage[]
): LostTap[] {
  const newest = new Map<string, LostTap>();
  for (const message of messages) {
    if (message.from?.id !== userId || !message.id || typeof message.message !== "string") {
      continue;
    }
    const at = message.created_time ? Date.parse(message.created_time) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    let chosen: { campaign: TapCampaign; button: TapButton } | null = null;
    for (const campaign of campaigns) {
      if (at <= campaign.openingDmAt) continue;
      const button = tapButton(campaign, message.message);
      if (!button) continue;
      if (!chosen || campaign.openingDmAt > chosen.campaign.openingDmAt) {
        chosen = { campaign, button };
      }
    }
    if (!chosen) continue;
    const current = newest.get(chosen.campaign.automationId);
    if (current && current.tappedAt >= at) continue;
    newest.set(chosen.campaign.automationId, {
      automationId: chosen.campaign.automationId,
      messageId: message.id,
      tappedAt: at,
      payload: tapPayload(chosen.campaign, chosen.button),
    });
  }
  return [...newest.values()].sort((a, b) => a.tappedAt - b.tappedAt);
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

/**
 * A lost tap that is not continued, as the all-clear and Diagnostics list
 * it: Instagram's 24 hours from the tap leave less than an hour ("window"),
 * or the campaign no longer answers taps (paused or gone, "campaign").
 */
export interface ListedTap {
  /** The person's handle, without "@", when known. */
  username: string | null;
  /** The campaign's name. */
  campaign: string;
  /** When they tapped (ISO). */
  tappedAt: string;
  reason: "window" | "campaign";
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
    reason: item.reason === "campaign" ? "campaign" : "window",
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
