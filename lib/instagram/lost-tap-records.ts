/**
 * What the database already knows of a person's taps and links, for the
 * search for lost taps after a messaging silence (A2,
 * lib/instagram/lost-tap-search.ts) and the postback job it queues
 * (lib/queue/dm-worker.ts).
 *
 * A tap that reached OpenReply left a trace: the webhook route stored it
 * (WebhookEvent), and its job wrote the campaign's "reveal:<person>" row
 * when it sent the link, waited for a pause or failed (a follow request
 * leaves no row, only the webhook). A DM keyword the campaign answered left
 * its "dm:<mid>" row. Whoever has such a trace after their opening DM was
 * answered the ordinary way: the search leaves them alone, and a lost tap's
 * job stands back when one appears after the tap it continues, so nobody
 * gets the link twice.
 *
 * OpenReply's own DMs to the person that the database records
 * (ownSendsTo) tell the search which messages in their conversation it sent
 * itself: any other one after a lost tap was written by someone else.
 *
 * Database only, no Meta or queue import.
 */

import { prisma } from "@/lib/db/client";
import {
  campaignOfTapPayload,
  OWN_SEND_TOLERANCE_MS,
  type OwnSends,
} from "@/lib/instagram/lost-tap-state";
import { parsePostbackEvents } from "@/lib/meta/webhook";
import { CARD_DELAY_MS } from "@/lib/offers/schedule";

// Stored webhooks with a button tap are read a page at a time, oldest
// first; after this many the look is incomplete (and says so).
const WEBHOOK_PAGE_SIZE = 100;
const WEBHOOK_MAX_PAGES = 20;

/** A button tap the webhook route stored. */
export interface RecordedTap {
  /** The person's Instagram-scoped id. */
  userId: string;
  /** The campaign its payload names. */
  automationId: string;
  /** Instagram's id of the tap, when the webhook had one. */
  mid: string | null;
  /** When the webhook arrived (epoch ms). */
  at: number;
}

type StoredPayload = Parameters<typeof parsePostbackEvents>[0];

/**
 * The button taps on the account's campaigns that arrived after `after`, as
 * the webhook route stored them (the `messaging` items it turns into
 * postback jobs: parsePostbackEvents; a tap in `standby` went to another
 * app). With `userId`, only that person's. The database narrows the rows to
 * the account's payloads with such an item (jsonb containment, index on
 * createdAt); what counts is decided here.
 */
export async function recordedTapsSince(
  instagramId: string,
  after: Date,
  { userId }: { userId?: string } = {}
): Promise<{ taps: RecordedTap[]; complete: boolean }> {
  const item = userId ? { sender: { id: userId }, postback: {} } : { postback: {} };
  const taps: RecordedTap[] = [];
  for (let page = 0; page < WEBHOOK_MAX_PAGES; page++) {
    const rows = await prisma.webhookEvent.findMany({
      where: {
        createdAt: { gt: after },
        payload: { path: ["entry"], array_contains: [{ id: instagramId, messaging: [item] }] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: page * WEBHOOK_PAGE_SIZE,
      take: WEBHOOK_PAGE_SIZE,
      select: { createdAt: true, payload: true },
    });
    for (const row of rows) {
      for (const event of parsePostbackEvents(row.payload as unknown as StoredPayload)) {
        if (event.instagramAccountId !== instagramId) continue;
        if (userId && event.userId !== userId) continue;
        const automationId = campaignOfTapPayload(event.payload);
        if (!automationId) continue;
        taps.push({
          userId: event.userId,
          automationId,
          mid: event.mid ?? null,
          at: row.createdAt.getTime(),
        });
      }
    }
    if (rows.length < WEBHOOK_PAGE_SIZE) return { taps, complete: true };
  }
  return { taps, complete: false };
}

/** A person and a campaign whose opening DM they got at `since` (epoch ms). */
export interface TapPair {
  userId: string;
  automationId: string;
  since: number;
}

/** The key of a pair in the set recordedPairs returns. */
export function pairKey(userId: string, automationId: string): string {
  return `${userId}\u0000${automationId}`;
}

/**
 * The pairs that have a tap or a link on record after their `since`: a
 * "reveal:<person>" or "dm:<mid>" row of the campaign for the person that
 * was written after it (whatever it says: a tap or a DM was answered, or is
 * being answered), or a stored webhook with the person's tap on one of the
 * campaign's buttons. The search leaves those people alone: their flow went
 * on the ordinary way after the silence.
 */
export async function recordedPairs(
  account: { id: string; instagramId: string },
  pairs: readonly TapPair[]
): Promise<{ recorded: Set<string>; complete: boolean }> {
  const recorded = new Set<string>();
  if (pairs.length === 0) return { recorded, complete: true };
  const byKey = new Map(pairs.map((pair) => [pairKey(pair.userId, pair.automationId), pair]));
  const after = new Date(Math.min(...pairs.map((pair) => pair.since)));

  const rows = await prisma.dmLog.findMany({
    where: {
      instagramAccountId: account.id,
      automationId: { in: [...new Set(pairs.map((pair) => pair.automationId))] },
      commenterId: { in: [...new Set(pairs.map((pair) => pair.userId))] },
      updatedAt: { gt: after },
      OR: [{ commentId: { startsWith: "reveal:" } }, { commentId: { startsWith: "dm:" } }],
    },
    select: { automationId: true, commenterId: true, commentId: true, updatedAt: true },
  });
  for (const row of rows) {
    const pair = byKey.get(pairKey(row.commenterId, row.automationId));
    if (!pair || row.updatedAt.getTime() <= pair.since) continue;
    if (row.commentId === `reveal:${row.commenterId}` || row.commentId.startsWith("dm:")) {
      recorded.add(pairKey(row.commenterId, row.automationId));
    }
  }

  const { taps, complete } = await recordedTapsSince(account.instagramId, after);
  for (const tap of taps) {
    const pair = byKey.get(pairKey(tap.userId, tap.automationId));
    if (pair && tap.at > pair.since) recorded.add(pairKey(tap.userId, tap.automationId));
  }
  return { recorded, complete };
}

/** What made a lost tap's job stand back. */
export type LostTapAnswer =
  /** The campaign's link went out to the person after the tap, or may have. */
  | "link"
  /** The campaign answered a DM of theirs (a keyword) after the tap. */
  | "dm"
  /** They tapped one of the campaign's buttons again, and that tap arrived. */
  | "tap";

/**
 * Whether the person was answered since the lost tap a job continues
 * (lib/queue/dm-worker.ts): the campaign's link reached them after the tap
 * (SENT later than it) or may have (unconfirmed, written after it); the
 * campaign answered a keyword DM of theirs after it; or a tap of theirs on
 * the campaign's buttons arrived as a webhook after it, other than this one
 * (a webhook with the same mid is this very tap, delivered late: its job and
 * this one take the same claim). A FAILED link is no answer: the job's own
 * retry after a refusal must go on. Nor is a link that waits for an R1 pause
 * (PENDING): that may be this job's own first attempt, whose copy never
 * reached the queue, and nothing would ever answer the tap then. A link of
 * another tap that waits is no reason either: that tap arrived (the stored
 * webhook above), and its copy stands back on the link this job sends
 * (processPostback's pause copy check). Null when none of these holds.
 */
export async function lostTapAnswered({
  instagramId,
  automationId,
  userId,
  tappedAt,
  mid,
}: {
  instagramId: string;
  automationId: string;
  userId: string;
  /** The tap's time (epoch ms). */
  tappedAt: number;
  /** The tap's id, as the conversation showed it. */
  mid: string | null;
}): Promise<LostTapAnswer | null> {
  const reveal = await prisma.dmLog.findUnique({
    where: { automationId_commentId: { automationId, commentId: `reveal:${userId}` } },
    select: { status: true, dmSentAt: true, dmDeliveryUnconfirmed: true, updatedAt: true },
  });
  if (reveal) {
    if (reveal.status === "SENT" && reveal.dmSentAt && reveal.dmSentAt.getTime() > tappedAt) {
      return "link";
    }
    if (reveal.dmDeliveryUnconfirmed && reveal.updatedAt.getTime() > tappedAt) return "link";
  }

  const answeredDm = await prisma.dmLog.findFirst({
    where: {
      automationId,
      commenterId: userId,
      commentId: { startsWith: "dm:" },
      createdAt: { gt: new Date(tappedAt) },
      OR: [{ status: "SENT" }, { status: "PENDING" }, { dmDeliveryUnconfirmed: true }],
    },
    select: { id: true },
  });
  if (answeredDm) return "dm";

  const { taps } = await recordedTapsSince(instagramId, new Date(tappedAt), { userId });
  return taps.some((tap) => tap.automationId === automationId && tap.mid !== mid)
    ? "tap"
    : null;
}

const SECOND = 1_000;

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + Math.max(0, value), 0);
}

/**
 * OpenReply's own DMs to a person on the account since `after`, as the
 * database records them, for telling them apart from messages someone wrote
 * by hand (unexplainedReplies, lib/instagram/lost-tap-state.ts):
 * - every DmLog row of the person, of any campaign: a comment's DM (an
 *   opening DM of another campaign, say), the link after a tap (its last
 *   one) and the answer to a DM keyword, at its send time; one that may have
 *   gone out at the time it was last written;
 * - the person's offers (lib/offers/worker.ts): the offer messages from its
 *   start to the one with the button, the confirmations and the card after
 *   the tap on it, the reminder and the message after a sign-up.
 * What the database does not record (a follow prompt, its second request,
 * the note before a follow re-check, the follow-up after a link) is not
 * known: a message like that counts as written by someone else, and the
 * tap it follows is listed rather than continued. A guess could hide a
 * reply by hand, and with it a link the person already has.
 */
export async function ownSendsTo(
  account: { id: string },
  userId: string,
  after: Date
): Promise<OwnSends[]> {
  const since = new Date(after.getTime() - OWN_SEND_TOLERANCE_MS);
  const rows = await prisma.dmLog.findMany({
    where: {
      instagramAccountId: account.id,
      commenterId: userId,
      OR: [{ dmSentAt: { gt: since } }, { dmDeliveryUnconfirmed: true, updatedAt: { gt: since } }],
    },
    select: { dmSentAt: true, dmDeliveryUnconfirmed: true, updatedAt: true },
  });
  const sends: OwnSends[] = rows.flatMap((row) => {
    const at = row.dmSentAt ?? (row.dmDeliveryUnconfirmed ? row.updatedAt : null);
    return at ? [{ from: at.getTime(), until: at.getTime(), count: 1 }] : [];
  });

  const offers = await prisma.contactOffer.findMany({
    where: { contact: { instagramAccountId: account.id, igsid: userId } },
    select: {
      offeredAt: true,
      pitchSentAt: true,
      interestedAt: true,
      sentAt: true,
      reminderSentAt: true,
      signupMessageSentAt: true,
      offer: {
        select: {
          offerMessages: true,
          offerDelaysSeconds: true,
          confirmationMessages: true,
          confirmationDelaysSeconds: true,
        },
      },
    },
  });
  for (const row of offers) {
    const { offer } = row;
    const started = row.offeredAt.getTime();
    sends.push({
      from: started,
      until: row.pitchSentAt?.getTime() ?? started + sum(offer.offerDelaysSeconds) * SECOND,
      count: Math.max(1, offer.offerMessages.length),
    });
    if (row.interestedAt) {
      // The confirmations and the card after the tap on the offer's button.
      // sentAt is the card's time, unless the reminder came first and keeps it.
      const tapped = row.interestedAt.getTime();
      const card = row.sentAt?.getTime() ?? null;
      sends.push({
        from: tapped,
        until:
          card !== null && card >= tapped
            ? card
            : tapped + sum(offer.confirmationDelaysSeconds) * SECOND + CARD_DELAY_MS,
        count: offer.confirmationMessages.length + 1,
      });
    }
    for (const at of [row.reminderSentAt, row.signupMessageSentAt]) {
      if (at) sends.push({ from: at.getTime(), until: at.getTime(), count: 1 });
    }
  }
  return sends.filter((send) => send.until >= since.getTime());
}
