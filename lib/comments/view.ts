/**
 * What the Kommentare page shows (components/comments-view.tsx): the shape
 * of GET /api/instagram/comments, and the rules for a row's state, its
 * defaults and why a manual send is not possible right now.
 *
 * Pure and client-safe: the page renders with it, the API builds its answer
 * to these types, and the tests check the rules without a browser.
 */

import { withinPrivateReplyWindow } from "./manual";

/**
 * The comment's DM went out (sent), is on its way right now (sending: a job
 * holds the claim), or may have gone out (unconfirmed). Each rules out
 * another DM: Instagram allows one private reply per comment.
 */
export type DeliveryState = "sent" | "sending" | "unconfirmed";

export interface CommentDelivery {
  state: DeliveryState;
  campaignId: string;
  campaignName: string;
  /** Sent from the Kommentare page ("(manuell)"). */
  manual: boolean;
}

/** One campaign's DmLog row for the comment. */
export interface CommentLog {
  automationId: string;
  campaignName: string;
  /** DmStatus: PENDING, SENT, FAILED, SKIPPED_… */
  status: string;
  /** The campaign used up its send attempts for this comment. */
  exhausted: boolean;
  /** What the worker recorded (English, technical), shortened. */
  errorMessage: string | null;
  updatedAt: string;
  manual: boolean;
}

/** Where the comment's DM stands: the part of a row a poll refreshes. */
export interface CommentStatus {
  delivery: CommentDelivery | null;
  logs: CommentLog[];
}

export interface CommentRow extends CommentStatus {
  id: string;
  text: string;
  /** ISO time of the comment. */
  timestamp: string;
  username: string | null;
  mediaId: string;
  permalink: string | null;
  /** The account answered the comment in public. */
  ownerReplied: boolean;
  /** Has a question mark: campaigns with the question filter leave it out. */
  question: boolean;
  /** The campaign that would answer it on its own (the sweep's rule). */
  match: { id: string; name: string } | null;
}

/** A campaign the page can send: the account's campaigns with a DM text. */
export interface CampaignOption {
  id: string;
  name: string;
  isActive: boolean;
  /** Has a public reply text to post. */
  hasPublicReply: boolean;
}

export interface CommentsPageData {
  account: { id: string; username: string };
  /** The account's sending is paused for a Meta request limit until then. */
  pausedUntil: string | null;
  /**
   * Since when the account's connection is lost (A1): nothing is read from
   * Instagram and nothing can be sent until it is reconnected.
   */
  connectionLostAt: string | null;
  campaigns: CampaignOption[];
  /** Newest first; only comments within the 7-day private-reply window. */
  comments: CommentRow[];
  /** How many posts were read, and whether there are more. */
  posts: number;
  hasMore: boolean;
  /** A Meta request limit stopped the reads: some posts are missing. */
  readLimited: boolean;
  /** Posts whose comments could not be read for another reason. */
  failedPosts: number;
  /** The server's time for this answer, which the page renders against. */
  generatedAt: string;
}

/** Why "DM senden" is not possible for a row right now, or null. */
export type SendBlock =
  | { kind: "sent" }
  | { kind: "sending" }
  | { kind: "too-old" }
  | { kind: "connection-lost" }
  | { kind: "paused"; until: string }
  | { kind: "attempts" }
  | { kind: "no-campaign" };

/** The row as the page shows it: a poll's newer status over the loaded one. */
export function withStatus(
  row: CommentRow,
  status: CommentStatus | undefined
): CommentRow {
  return status ? { ...row, delivery: status.delivery, logs: status.logs } : row;
}

/** The campaign preselected for a row: the one that would answer it. */
export function defaultCampaignId(
  row: CommentRow,
  campaigns: CampaignOption[]
): string {
  const id = row.delivery?.campaignId ?? row.match?.id ?? "";
  return campaigns.some((campaign) => campaign.id === id) ? id : "";
}

/** "Öffentlich antworten" starts on, and off where the account replied. */
export function defaultPublicReply(row: CommentRow): boolean {
  return !row.ownerReplied;
}

/**
 * Why the row cannot be sent right now. In this order: its DM went out or
 * may have (Instagram allows one per comment), the 7 days are over, the
 * account's connection is lost (A1: reconnect first), the account is paused
 * for a Meta limit, a send is under way, no campaign is chosen, the chosen
 * campaign used up its attempts for this comment.
 */
export function sendBlock({
  row,
  campaignId,
  pausedUntil,
  connectionLostAt = null,
  sending,
  now,
}: {
  row: CommentRow;
  campaignId: string;
  pausedUntil: string | null;
  connectionLostAt?: string | null;
  sending: boolean;
  now: number;
}): SendBlock | null {
  if (row.delivery) {
    return row.delivery.state === "sending" ? { kind: "sending" } : { kind: "sent" };
  }
  if (!withinPrivateReplyWindow(row.timestamp, now)) return { kind: "too-old" };
  if (connectionLostAt) return { kind: "connection-lost" };
  if (pausedUntil && Date.parse(pausedUntil) > now) {
    return { kind: "paused", until: pausedUntil };
  }
  if (sending) return { kind: "sending" };
  if (!campaignId) return { kind: "no-campaign" };
  const log = row.logs.find((entry) => entry.automationId === campaignId);
  if (log?.exhausted) return { kind: "attempts" };
  return null;
}

/**
 * The row's last outcome without a DM, for its status line: the campaign
 * row that changed last, or null.
 */
export function lastAttempt(row: CommentRow): CommentLog | null {
  if (row.delivery) return null;
  return row.logs.reduce<CommentLog | null>(
    (latest, log) =>
      !latest || Date.parse(log.updatedAt) > Date.parse(latest.updatedAt)
        ? log
        : latest,
    null
  );
}

/** A manual send the page waits for: the campaign, and its row before. */
export interface PendingSend {
  automationId: string;
  /** The campaign row's updatedAt when the send was queued (null: none). */
  previousUpdatedAt: string | null;
  polls: number;
}

/**
 * Whether a manual send has an outcome in the comment's status: its DM went
 * out (or may have), or the campaign's row changed to something other than
 * the claim on its way (a refusal, a skip, or a wait with its reason).
 * Compared by the row's own updatedAt, so the server's and the worker's
 * clocks never matter.
 */
export function manualSendSettled(
  status: CommentStatus | undefined,
  pending: PendingSend
): boolean {
  if (!status) return false;
  if (status.delivery) return status.delivery.state !== "sending";
  const log = status.logs.find((entry) => entry.automationId === pending.automationId);
  if (!log || log.updatedAt === pending.previousUpdatedAt) return false;
  return log.status !== "PENDING" || Boolean(log.errorMessage);
}

/**
 * "vor 5 Minuten", "gestern": the comment's age in the reader's language,
 * against the answer's time (the page renders without a clock of its own).
 */
export function relativeTime(
  iso: string,
  now: number,
  locale: string
): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}
