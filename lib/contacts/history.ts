/**
 * One contact's history as a single timeline (R10): their comments, button
 * taps and DMs as the DM log has them, every stage of the offers they got
 * (a sign-up their landing page reported included), the tags they got and
 * their clicks on campaign links, newest first.
 *
 * Pure and client-safe: the Contacts API builds it from database rows, and
 * timestamps may be Dates or ISO strings. Contacts outlive campaigns (R16):
 * an offer row whose campaign was deleted keeps its stages, and its entries
 * say so instead of naming a campaign.
 */

type Time = Date | string;

// A history shows the person's latest DM log rows and campaign link clicks;
// their tags and offers are few and come in full.
export const HISTORY_MESSAGE_LIMIT = 100;
export const HISTORY_CLICK_LIMIT = 50;

/** A DmLog row of the contact. */
export interface HistoryMessage {
  id: string;
  /** "reveal:<igsid>" for a button tap, "dm:<mid>" for a DM, else the comment's id. */
  commentId: string;
  commentText: string;
  status: string;
  createdAt: Time;
  automationId: string | null;
  automation: { name: string } | null;
}

/** A ContactOffer row of the contact, with its offer and campaign. */
export interface HistoryOffer {
  id: string;
  offerId: string;
  automationId: string | null;
  offeredAt: Time;
  pitchSentAt: Time | null;
  interestedAt: Time | null;
  sentAt: Time | null;
  sentVia: string | null;
  reminderSentAt: Time | null;
  clickedAt: Time | null;
  /** The landing page reported the sign-up. */
  signedUpAt: Time | null;
  /** The confirmation of the sign-up went out in the chat. */
  signupMessageSentAt: Time | null;
  stoppedAt: Time | null;
  stopReason: string | null;
  offer: { name: string; archivedAt: Time | null };
  automation: { name: string } | null;
}

export interface HistoryTag {
  id: string;
  tag: string;
  createdAt: Time;
}

/** A LinkClick row: a click on one of a campaign's tracked links. */
export interface HistoryClick {
  id: string;
  createdAt: Time;
  automationId: string | null;
  automation: { name: string } | null;
  trackedLink: { destinationUrl: string } | null;
}

export type MessageKind = "comment" | "tap" | "dm";

export type OfferStage =
  | "offered"
  | "pitched"
  | "interested"
  | "sent"
  | "reminded"
  | "clicked"
  | "signedUp"
  | "signupConfirmed"
  | "stopped";

/** Where an entry came from. A deleted campaign has neither id nor name. */
export interface CampaignFields {
  campaignId: string | null;
  campaign: string | null;
  campaignDeleted: boolean;
}

export type ContactTimelineEvent =
  | ({
      kind: MessageKind;
      key: string;
      at: string;
      status: string;
      /** The comment or DM as written; null for a tap. */
      text: string | null;
    } & CampaignFields)
  | ({
      kind: "offer";
      key: string;
      at: string;
      stage: OfferStage;
      offerId: string;
      offer: string;
      offerArchived: boolean;
      /** How the lead magnet went out, on the "sent" entry. */
      sentVia: string | null;
      /** Why the offer ended early, on the "stopped" entry. */
      stopReason: string | null;
    } & CampaignFields)
  | { kind: "tag"; key: string; at: string; tag: string }
  | ({ kind: "click"; key: string; at: string; url: string | null } & CampaignFields);

/**
 * The order of things that happen in the same instant, as the flow runs
 * them: the comment or DM, the tap, the link click, the offer's stages (the
 * sign-up on the landing page after the click, its confirmation after it),
 * and the tag that records a step. Newest first, the later one comes first.
 */
const FLOW_RANK: Record<MessageKind | OfferStage | "click" | "tag", number> = {
  comment: 0,
  dm: 0,
  tap: 1,
  click: 2,
  offered: 3,
  pitched: 4,
  interested: 5,
  sent: 6,
  reminded: 7,
  clicked: 8,
  signedUp: 9,
  signupConfirmed: 10,
  stopped: 11,
  tag: 12,
};

/** What kind of DmLog row this is, read from its synthetic comment id. */
export function messageKind(commentId: string): MessageKind {
  if (commentId.startsWith("reveal:")) return "tap";
  if (commentId.startsWith("dm:")) return "dm";
  return "comment";
}

function timeOf(value: Time): number {
  return new Date(value).getTime();
}

/**
 * When the lead magnet itself went out, or null when the timeline has no
 * entry of its own for that. The reminder carries the link too (sentVia
 * REMINDER); then the reminder's entry stands for the delivery. A card that
 * followed the reminder keeps the reminder's time as sentAt, but went out
 * after the tap that asked for it, so it is placed at that tap.
 */
export function offerSentAt(
  row: Pick<HistoryOffer, "sentAt" | "sentVia" | "reminderSentAt" | "interestedAt">
): Time | null {
  if (!row.sentAt || row.sentVia === "REMINDER") return null;
  if (
    row.reminderSentAt &&
    row.interestedAt &&
    timeOf(row.interestedAt) > timeOf(row.sentAt)
  ) {
    return row.interestedAt;
  }
  return row.sentAt;
}

function campaignFields(
  automationId: string | null,
  automation: { name: string } | null
): CampaignFields {
  return automation
    ? { campaignId: automationId, campaign: automation.name, campaignDeleted: false }
    : { campaignId: null, campaign: null, campaignDeleted: true };
}

type Entry = { time: number; rank: number; event: ContactTimelineEvent };

function add(
  entries: Entry[],
  value: Time | null,
  rank: number,
  make: (at: string) => ContactTimelineEvent
) {
  if (value === null) return;
  const time = timeOf(value);
  if (Number.isNaN(time)) return;
  entries.push({ time, rank, event: make(new Date(time).toISOString()) });
}

export function buildContactTimeline({
  messages,
  offers,
  tags,
  clicks,
}: {
  messages: readonly HistoryMessage[];
  offers: readonly HistoryOffer[];
  tags: readonly HistoryTag[];
  clicks: readonly HistoryClick[];
}): ContactTimelineEvent[] {
  const entries: Entry[] = [];

  for (const row of messages) {
    const kind = messageKind(row.commentId);
    add(entries, row.createdAt, FLOW_RANK[kind], (at) => ({
      kind,
      key: `message:${row.id}`,
      at,
      status: row.status,
      // A tap's row holds a placeholder, not the person's words.
      text: kind === "tap" ? null : row.commentText || null,
      ...campaignFields(row.automationId, row.automation),
    }));
  }

  for (const row of offers) {
    const stage = (
      name: OfferStage,
      value: Time | null,
      details: { sentVia?: string | null; stopReason?: string | null } = {}
    ) =>
      add(entries, value, FLOW_RANK[name], (at) => ({
        kind: "offer",
        key: `offer:${row.id}:${name}`,
        at,
        stage: name,
        offerId: row.offerId,
        offer: row.offer.name,
        offerArchived: row.offer.archivedAt !== null,
        sentVia: details.sentVia ?? null,
        stopReason: details.stopReason ?? null,
        ...campaignFields(row.automationId, row.automation),
      }));
    stage("offered", row.offeredAt);
    stage("pitched", row.pitchSentAt);
    stage("interested", row.interestedAt);
    stage("sent", offerSentAt(row), { sentVia: row.sentVia });
    stage("reminded", row.reminderSentAt);
    stage("clicked", row.clickedAt);
    stage("signedUp", row.signedUpAt);
    stage("signupConfirmed", row.signupMessageSentAt);
    stage("stopped", row.stoppedAt, { stopReason: row.stopReason });
  }

  for (const row of tags) {
    add(entries, row.createdAt, FLOW_RANK.tag, (at) => ({
      kind: "tag",
      key: `tag:${row.id}`,
      at,
      tag: row.tag,
    }));
  }

  for (const row of clicks) {
    add(entries, row.createdAt, FLOW_RANK.click, (at) => ({
      kind: "click",
      key: `click:${row.id}`,
      at,
      url: row.trackedLink?.destinationUrl ?? null,
      ...campaignFields(row.automationId, row.automation),
    }));
  }

  return entries
    .sort(
      (a, b) =>
        b.time - a.time ||
        b.rank - a.rank ||
        (a.event.key < b.event.key ? -1 : a.event.key > b.event.key ? 1 : 0)
    )
    .map((entry) => entry.event);
}
