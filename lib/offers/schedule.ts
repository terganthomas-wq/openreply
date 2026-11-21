/**
 * Order, timing and job ids of lead-magnet offers.
 *
 * Client-safe: no database or queue import (the Prisma import is types only),
 * so the Offers page can show the same order the worker uses.
 */

import type { Prisma } from "@/app/generated/prisma/client";

/** The payload of an offer's "yes, send it" button: "offer:<ContactOffer id>". */
export const OFFER_PAYLOAD_PREFIX = "offer:";

/** The pause between the last confirmation and the card. */
export const CARD_DELAY_MS = 1000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// Instagram lets a business message a person for 24 hours after the person's
// last button tap or DM. A send is not attempted in the last five minutes:
// the job may wait in the queue, and Meta's clock is not ours.
const MESSAGING_WINDOW_MS = 24 * HOUR_MS;
const WINDOW_MARGIN_MS = 5 * MINUTE_MS;

// A reminder fires at most 23.5 hours after the last interaction, so its
// retries (5 and 15 minutes later) still land inside the window.
const REMINDER_LATEST_MS = 23.5 * HOUR_MS;

// Jobs that wait for hours fire on a full or half hour (UTC). Those of
// people whose taps fell into the same half hour then run together and wake
// the database once instead of once each.
const WAKE_UP_GRID_MS = 30 * MINUTE_MS;

/**
 * A campaign can start its offer this many hours after the link instead of
 * right after it (Automation.offerDelayHours), as the A-037 guide does: the
 * messaging window, 24 hours from the tap or DM that brought the link, is
 * still open then. Such an offer gets no reminder: whoever does not tap gets
 * nothing more.
 */
export const OFFER_LATE_START_HOURS = 22;

/** The values Automation.offerDelayHours takes: right away, or late. */
export const OFFER_DELAY_HOURS = [0, OFFER_LATE_START_HOURS] as const;
export type OfferDelayHours = (typeof OFFER_DELAY_HOURS)[number];

/**
 * Whether a campaign starts its offer late. Only the late value counts, so a
 * row that somehow holds anything else starts the offer right away, as
 * every campaign did before the setting existed.
 */
export function offerStartsLate(
  offerDelayHours: number | null | undefined
): boolean {
  return offerDelayHours === OFFER_LATE_START_HOURS;
}

/**
 * When a late offer starts (epoch ms): OFFER_LATE_START_HOURS after the tap
 * or DM that brought the link, rounded down to a full or half hour (UTC) like
 * the reminder. Never later than that, so the offer messages and their
 * retries stay well inside the window.
 */
export function lateStartFireAt(interactionAt: Date | number): number {
  return floorToWakeUpGrid(toMs(interactionAt) + OFFER_LATE_START_HOURS * HOUR_MS);
}

/**
 * How long a late start waits from `now`: until lateStartFireAt, or not at
 * all when that time has passed (the window check at the start decides).
 */
export function lateStartDelayMs(
  interactionAt: Date | number,
  now: number = Date.now()
): number {
  return Math.max(0, lateStartFireAt(interactionAt) - now);
}

/**
 * The workspace's default offer order. `position` decides it; `createdAt` and
 * `id` only break ties, so tied rows never come back in a different order.
 */
export const OFFER_ORDER = [
  { position: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
] satisfies Prisma.OfferOrderByWithRelationInput[];

/**
 * The offers a campaign may start, in the order it tries them.
 *
 * `activeInDefaultOrder` holds the workspace's active, non-archived offers,
 * read with OFFER_ORDER. Without a custom order the campaign uses all of them.
 * A custom order lists offer ids: each counts once, and ids of paused,
 * deleted or unknown offers drop out, so pausing an offer moves the campaign
 * on to the next one without anyone editing the campaign.
 */
export function resolveOfferOrder<T extends { id: string }>(
  customIds: readonly string[],
  activeInDefaultOrder: readonly T[]
): T[] {
  if (customIds.length === 0) return [...activeInDefaultOrder];
  const active = new Map(activeInDefaultOrder.map((offer) => [offer.id, offer]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of customIds) {
    const offer = active.get(id);
    if (!offer || seen.has(id)) continue;
    seen.add(id);
    ordered.push(offer);
  }
  return ordered;
}

/**
 * Whether Instagram still lets us message someone whose last tap or DM was
 * at `lastInteractionAt`. A comment opens no window, so no time means no.
 */
export function withinWindow(
  lastInteractionAt: Date | number | null | undefined,
  now: number = Date.now()
): boolean {
  if (lastInteractionAt === null || lastInteractionAt === undefined) {
    return false;
  }
  const at =
    typeof lastInteractionAt === "number"
      ? lastInteractionAt
      : lastInteractionAt.getTime();
  return now - at < MESSAGING_WINDOW_MS - WINDOW_MARGIN_MS;
}

/**
 * When the reminder goes out (epoch ms): `delayHours` (1 to 23) after the
 * offer's last message, but no later than 23.5 hours after the person's last
 * interaction, which the window counts from.
 *
 * The time is rounded down to a full or half hour (UTC). Reminders of people
 * who all tapped within the same half hour then fire together, waking the
 * database once instead of once each. Rounding down only ever fires earlier.
 */
export function reminderFireAt({
  pitchSentAt,
  lastInteractionAt,
  delayHours,
}: {
  pitchSentAt: Date | number;
  lastInteractionAt: Date | number;
  delayHours: number;
}): number {
  const hours = Number.isFinite(delayHours)
    ? Math.min(23, Math.max(1, Math.floor(delayHours)))
    : 23;
  const wanted = toMs(pitchSentAt) + hours * HOUR_MS;
  const latest = toMs(lastInteractionAt) + REMINDER_LATEST_MS;
  return floorToWakeUpGrid(Math.min(wanted, latest));
}

function floorToWakeUpGrid(ms: number): number {
  return Math.floor(ms / WAKE_UP_GRID_MS) * WAKE_UP_GRID_MS;
}

function toMs(value: Date | number): number {
  return typeof value === "number" ? value : value.getTime();
}

/**
 * The key of one offer start (ContactOffer.startKey, unique per contact): the
 * campaign, how its link went out and the id Instagram gave the trigger, i.e.
 * the mid of the button tap or of the inbound DM.
 *
 * Every new trigger of a campaign gets a new key and starts the next offer
 * the person has not had yet. A redelivered webhook, a retried job or a
 * second tap that carries the same mid gets the same key and starts nothing.
 */
export function offerStartKey(
  automationId: string,
  via: string,
  triggerId: string
): string {
  return `${automationId}:${via}:${triggerId}`;
}

/**
 * Job ids of offer jobs. BullMQ forbids ":" in them; cuids and IGSIDs have
 * none. A start is keyed on a digest of its start key instead of the key
 * itself, whose mid may hold any character (lib/offers/jobs.ts).
 */
export const offerJobId = {
  start: (automationId: string, userId: string, startKeyDigest: string) =>
    `offerstart_${automationId}_${userId}_${startKeyDigest}`,
  step: (contactOfferId: string, phase: "offer" | "confirm", step: number) =>
    `offer_${contactOfferId}_${phase}_${step}`,
  card: (contactOfferId: string) => `offer_${contactOfferId}_card`,
  reminder: (contactOfferId: string) => `offer_${contactOfferId}_reminder`,
};
