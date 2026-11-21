/**
 * The offer engine (Weg 2): a lead-magnet offer after a delivered link.
 *
 * A campaign with offers starts one once its link went out after a button tap
 * or a DM (lib/queue/after-delivery.ts), right away or, if the campaign says
 * so, 22 hours later. The start takes the first offer in the campaign's order
 * that this person has not had yet and records it as a ContactOffer row. From
 * there each message is its own delayed job: the offer messages, the last one
 * with a "yes, send it" button; after a tap on it the confirmations and the
 * card with the lead magnet's link; without a tap, one reminder before
 * Instagram's 24-hour messaging window closes, unless the offer started late.
 *
 * After the start nothing here reads the campaign. Campaigns get paused or
 * deleted every few weeks, and that must not cut off offers already running;
 * texts, card and link are read from the offer at send time, so an edit
 * applies to every later message. Offer messages are never DmLog rows: those
 * feed the campaign's stats, the dashboard and the read fallback.
 *
 * Every message is claimed before it is sent (PostbackDelivery), counts toward
 * the workspace's monthly DMs and re-checks the messaging window. A retried or
 * repeated job therefore picks the sequence up where it stopped and never
 * sends a message twice.
 */

import { createHash } from "node:crypto";
import { UnrecoverableError, type Job } from "bullmq";
import type {
  OperationalEventLevel,
  Prisma,
} from "@/app/generated/prisma/client";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";
import {
  addContactTags,
  ensureContact,
  findContact,
  touchContactInteraction,
} from "@/lib/contacts/store";
import { prisma } from "@/lib/db/client";
import {
  classifySendError,
  isConfirmedSendRejection,
  isDeliveryUnconfirmed,
} from "@/lib/instagram/delivery-errors";
import {
  createInstagramContext,
  hasInstagramCredentials,
  MetaApiError,
  RateLimitError,
  sendDirectMessage,
  sendDirectMessageWithButton,
  sendDirectMessageWithLinkButton,
  type InstagramContext,
} from "@/lib/instagram/provider";
import type { ProcessOfferJob, ProcessPostbackJob } from "@/lib/queue/client";
import {
  claimPostbackDelivery,
  ClaimReleaseError,
  formatError,
  isTemplateRejection,
  isUniqueViolation,
  logWorkerEvent,
  sendClaimedPostback,
} from "@/lib/queue/send-helpers";
import {
  buildOfferUrl,
  renderMessageWithoutLink,
} from "@/lib/tracking/message";
import { hashRecipientId } from "@/lib/tracking/server";
import { cancelOfferJob, enqueueOfferJob } from "./jobs";
import {
  CARD_DELAY_MS,
  OFFER_ORDER,
  OFFER_PAYLOAD_PREFIX,
  offerJobId,
  reminderFireAt,
  resolveOfferOrder,
  withinWindow,
} from "./schedule";
import { sendOfferCard, type OfferCardVia } from "./send";

const CONTACT_OFFER_INCLUDE = {
  offer: true,
  contact: { include: { instagramAccount: true } },
} satisfies Prisma.ContactOfferInclude;

type LoadedContactOffer = Prisma.ContactOfferGetPayload<{
  include: typeof CONTACT_OFFER_INCLUDE;
}>;

// What a start needs of the row it created or found.
const STARTED_SELECT = {
  id: true,
  offeredAt: true,
  offer: { select: { tagOffered: true, offerDelaysSeconds: true } },
} satisfies Prisma.ContactOfferSelect;

type StartedOffer = Prisma.ContactOfferGetPayload<{
  select: typeof STARTED_SELECT;
}>;

// Why an offer ended before its last message (ContactOffer.stopReason).
type StopReason =
  | "WINDOW_CLOSED"
  | "REJECTED"
  | "RATE_LIMITED"
  | "PLAN_LIMIT"
  | "OFFER_ARCHIVED"
  | "ACCOUNT_UNAVAILABLE";

// A message as its claim names it. "retap" is the card sent once more for a
// later tap on the button.
type SendPhase = "offer" | "confirm" | "card" | "retap" | "reminder";

// What the send policy needs of the job that sends: a rate limit is retried
// while attempts are left.
type Attempts = Pick<Job, "attemptsMade" | "opts">;

// A reminder that could only go out within a minute is not worth a job.
const MIN_REMINDER_DELAY_MS = 60_000;

// The reminder carries the offer's link, so it counts as sent (sentAt, the
// funnel's "Sent"), but it is not the card: until the card goes out as well,
// sentVia says so.
const SENT_BY_REMINDER = "REMINDER";

// Rows whose card has not gone out yet, whether or not the reminder has.
const CARD_NOT_OUT = {
  OR: [{ sentAt: null }, { sentVia: SENT_BY_REMINDER }],
} satisfies Prisma.ContactOfferWhereInput;

/** Whether the card (or its fallback) went out, not only the reminder. */
function cardIsOut(co: Pick<LoadedContactOffer, "sentAt" | "sentVia">): boolean {
  return co.sentAt !== null && co.sentVia !== SENT_BY_REMINDER;
}

/** Run one offer job (OFFER_JOB_NAME). */
export async function processOffer(job: Job<ProcessOfferJob>): Promise<void> {
  if (job.data.phase === "start") return startOffer(job);

  const co = await loadContactOffer(job.data);
  if (!co) return;
  switch (job.data.phase) {
    case "offer":
      return sendOfferStep(job, co, job.data.step ?? 0);
    case "confirm":
      return sendConfirmation(job, co, job.data.step ?? 0);
    case "card":
      return sendCardStep(job, co);
    case "reminder":
      return sendReminder(job, co);
    default:
      console.warn("[Offers] Ignoring an unknown phase", job.data.phase, job.id);
  }
}

async function loadContactOffer(
  data: ProcessOfferJob
): Promise<LoadedContactOffer | null> {
  if (!data.contactOfferId) return null;
  const co = await prisma.contactOffer.findFirst({
    where: { id: data.contactOfferId, workspaceId: data.workspaceId },
    include: CONTACT_OFFER_INCLUDE,
  });
  // A job only acts through the connection it was queued for. A disconnect
  // deletes the account's contacts and with them their offers.
  if (
    !co ||
    co.contact.instagramAccountId !== data.accountConnectionId ||
    co.contact.instagramAccount.instagramId !== data.instagramAccountId
  ) {
    return null;
  }
  return co;
}

/**
 * Start an offer for a link delivered after a tap or a DM (R4, R5, R11).
 *
 * The start key is the campaign plus that trigger (lib/offers/schedule.ts).
 * A new trigger of the same campaign starts the next offer this person has
 * not had; a repeat of the same trigger starts nothing; no offer twice, from
 * whichever campaign (ContactOffer is unique per contact and offer).
 *
 * A late start (job.data.lateStart) runs 22 hours after the delivery and
 * otherwise works the same, with two differences: it never creates the
 * contact, and its row records that it started late, so no reminder follows.
 */
async function startOffer(job: Job<ProcessOfferJob>): Promise<void> {
  const {
    workspaceId,
    accountConnectionId,
    instagramAccountId,
    automationId,
    userId,
    interactionAt,
    startKey,
  } = job.data;
  const lateStart = job.data.lateStart === true;
  if (!automationId || !userId || interactionAt === undefined || !startKey) {
    console.warn("[Offers] Ignoring a start without its trigger", job.id);
    return;
  }

  // The campaign need not be active: its link went out, and pausing it a
  // moment later must not take back the offer that delivery earned.
  const automation = await prisma.automation.findFirst({
    where: { id: automationId, instagramAccountId: accountConnectionId, workspaceId },
    select: {
      id: true,
      offersEnabled: true,
      offerIds: true,
      instagramAccount: { select: { instagramId: true } },
    },
  });
  if (
    !automation?.offersEnabled ||
    automation.instagramAccount.instagramId !== instagramAccountId
  ) {
    return;
  }

  const identity = {
    workspaceId,
    instagramAccountId: accountConnectionId,
    igsid: userId,
    interactionAt: new Date(interactionAt),
  };
  // The delivery recorded the contact. A late start comes 22 hours later,
  // and a contact that is gone by then was deleted on request (GDPR): it is
  // not created again, and no offer follows. The log names no person. Both
  // throw on a database error: nothing was sent yet, so BullMQ retries.
  const contact = lateStart
    ? await findContact(identity)
    : await ensureContact(identity);
  if (!contact) {
    console.log("[Offers] Late start skipped: the contact no longer exists", {
      automationId,
    });
    return;
  }

  let started: StartedOffer | null = await prisma.contactOffer.findUnique({
    where: { contactId_startKey: { contactId: contact.id, startKey } },
    select: STARTED_SELECT,
  });
  if (started) {
    // This trigger has started an offer before. A row older than this job
    // belongs to an earlier job for the same trigger, which queued the first
    // message itself. A newer row is this job's own, from an attempt that
    // failed before it got that far: carry on. Both times come from the
    // worker's clock, which queued this job. A late start's job was queued
    // 22 hours before its row, so its own row is newer as well.
    if (started.offeredAt.getTime() < job.timestamp) return;
  } else {
    if (!withinWindow(contact.lastInteractionAt)) {
      await logWorkerEvent({
        workspaceId,
        level: "INFO",
        message: "Offer skipped: messaging window closed",
        payload: { automationId, userId },
      });
      return;
    }
    const claim = await claimNextOffer({
      workspaceId,
      contactId: contact.id,
      automation,
      startKey,
      lateStart,
    });
    // A concurrent run of this very start created the row and goes on.
    if (claim === "same-trigger") return;
    if (!claim) {
      // Expected once a person has had every offer, so not an event.
      console.log("[Offers] No offer left", { automationId, userId });
      return;
    }
    started = claim;
  }

  // Idempotent: a resumed start adds the tag its first attempt may have missed.
  await addContactTags(workspaceId, contact.id, [started.offer.tagOffered]);
  await enqueueOfferJob(
    {
      workspaceId,
      accountConnectionId,
      instagramAccountId,
      phase: "offer",
      contactOfferId: started.id,
      step: 0,
    },
    {
      jobId: offerJobId.step(started.id, "offer", 0),
      delayMs: delayMs(started.offer.offerDelaysSeconds, 0),
    }
  );
}

/**
 * Record the first offer in the campaign's order that the contact has not
 * had. Null when none is left, "same-trigger" when another run of this start
 * created its row first.
 */
async function claimNextOffer({
  workspaceId,
  contactId,
  automation,
  startKey,
  lateStart,
}: {
  workspaceId: string;
  contactId: string;
  automation: { id: string; offerIds: string[] };
  startKey: string;
  lateStart: boolean;
}): Promise<StartedOffer | "same-trigger" | null> {
  const active = await prisma.offer.findMany({
    where: { workspaceId, isActive: true, archivedAt: null },
    orderBy: OFFER_ORDER,
    select: { id: true, firstOfferedAt: true },
  });
  const had = await prisma.contactOffer.findMany({
    where: { contactId },
    select: { offerId: true },
  });
  const taken = new Set(had.map((row) => row.offerId));

  for (const offer of resolveOfferOrder(automation.offerIds, active)) {
    const offerId = offer.id;
    if (taken.has(offerId)) continue;
    // The offer is marked as offered before its first row is written, and
    // the mark outlives the rows: disconnecting an account deletes its
    // contacts' offers. Deleting the offer then still archives it, as its
    // card links may be in someone's inbox. A mark for a row that is not
    // written after all only archives an offer that could have gone.
    if (!offer.firstOfferedAt) {
      await prisma.offer.updateMany({
        where: { id: offerId, workspaceId, firstOfferedAt: null },
        data: { firstOfferedAt: new Date() },
      });
    }
    try {
      return await prisma.contactOffer.create({
        data: {
          workspaceId,
          contactId,
          offerId,
          automationId: automation.id,
          startKey,
          // From the start job, not the campaign, whose setting may have
          // changed since the link went out.
          lateStart,
          // The worker's clock, like the job timestamp a resumed start
          // compares it with.
          offeredAt: new Date(),
        },
        select: STARTED_SELECT,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Which key was hit is read from the rows, not from the error, whose
      // shape depends on the driver adapter.
      const sameTrigger = await prisma.contactOffer.findUnique({
        where: { contactId_startKey: { contactId, startKey } },
        select: { id: true },
      });
      if (sameTrigger) return "same-trigger";
      // Another start gave this person the offer a moment ago: the next one.
    }
  }
  return null;
}

/** Offer message `step`; the last one carries the "yes, send it" button (R3). */
async function sendOfferStep(
  job: Job<ProcessOfferJob>,
  co: LoadedContactOffer,
  step: number
): Promise<void> {
  // A tap on the button ends the offer messages; a stop is final for them.
  if (co.stoppedAt || co.interestedAt) return;
  if (co.offer.archivedAt) return stopArchived(co);
  const messages = co.offer.offerMessages;
  if (messages.length === 0) return;
  const lastInteractionAt = co.contact.lastInteractionAt;
  if (!lastInteractionAt || !withinWindow(lastInteractionAt)) {
    return stopWindowClosed(co);
  }

  // An edit that shortened the list while this offer ran still ends with the
  // button.
  const isLast = step >= messages.length - 1;
  const text = render(co, messages[Math.min(step, messages.length - 1)]);
  const target = sendTarget(co);
  const outcome = await sendOfferMessage(job, co, "offer", step, (context) =>
    isLast
      ? sendDirectMessageWithButton({
          ...target,
          context,
          text,
          buttonTitle: co.offer.offerButtonLabel,
          // A cuid has no colon, so the tap's payload parses back to the row.
          payload: `${OFFER_PAYLOAD_PREFIX}${co.id}`,
        })
      : sendDirectMessage({ ...target, context, message: text })
  );
  if (outcome === "stopped") return;

  if (!isLast) {
    await enqueueOfferJob(nextJob(co, { phase: "offer", step: step + 1 }), {
      jobId: offerJobId.step(co.id, "offer", step + 1),
      delayMs: delayMs(co.offer.offerDelaysSeconds, step + 1),
    });
    return;
  }

  const now = Date.now();
  await prisma.contactOffer.updateMany({
    where: { id: co.id, pitchSentAt: null },
    data: { pitchSentAt: new Date(now) },
  });
  if (!co.offer.reminderEnabled) return;
  // An offer that started 22 hours after its link gets no reminder, as in
  // the A-037 guide: whoever does not tap gets nothing more.
  if (co.lateStart) return;

  // The reminder (R7) is queued now and removed by a tap, so nobody who
  // tapped wakes the database 23 hours later.
  const fireAt = reminderFireAt({
    pitchSentAt: co.pitchSentAt ?? now,
    lastInteractionAt,
    delayHours: co.offer.reminderDelayHours,
  });
  if (fireAt - now < MIN_REMINDER_DELAY_MS) {
    await logWorkerEvent({
      workspaceId: co.workspaceId,
      level: "INFO",
      message: "Offer reminder skipped: messaging window closes too soon",
      payload: eventPayload(co),
    });
    return;
  }
  await enqueueOfferJob(nextJob(co, { phase: "reminder" }), {
    jobId: offerJobId.reminder(co.id),
    delayMs: fireAt - now,
  });
}

/**
 * The "yes, send it" tap (R6), handed over by processPostback. It belongs to
 * the offer, never to a campaign: the one that started the offer may be
 * paused or deleted by now, and a paused offer still answers its taps.
 */
export async function processOfferTap(
  job: Job<ProcessPostbackJob>
): Promise<void> {
  const { instagramAccountId, accountConnectionId, userId, payload, mid } =
    job.data;
  const contactOfferId = payload
    .slice(OFFER_PAYLOAD_PREFIX.length)
    .split(":")[0];
  if (!contactOfferId) return;

  const co = await prisma.contactOffer.findUnique({
    where: { id: contactOfferId },
    include: CONTACT_OFFER_INCLUDE,
  });
  // Only the person the offer went to, through the account that sent it.
  if (
    !co ||
    co.contact.igsid !== userId ||
    co.contact.instagramAccount.instagramId !== instagramAccountId ||
    (accountConnectionId &&
      co.contact.instagramAccountId !== accountConnectionId)
  ) {
    return;
  }

  // The tap opens Instagram's messaging window again (R1), for this offer
  // and for anything else this person is sent.
  const tappedAt = new Date(job.timestamp ?? Date.now());
  await touchContactInteraction(co.contactId, tappedAt);

  if (co.offer.archivedAt) {
    await logWorkerEvent({
      workspaceId: co.workspaceId,
      level: "INFO",
      message: "Offer tap ignored: offer was deleted",
      payload: eventPayload(co),
    });
    return;
  }

  // The first tap wins. It also lifts a stop: whatever ended the offer
  // messages (most often the window), the tap opened a new window.
  const first = await prisma.contactOffer.updateMany({
    where: { id: co.id, interestedAt: null },
    data: {
      interestedAt: tappedAt,
      interestedMid: mid ?? null,
      stoppedAt: null,
      stopReason: null,
    },
  });

  // Until the card is out, every tap queues the rest of the sequence: the
  // first tap; a retry of its job, which may have failed before it queued
  // anything; a redelivered webhook; a second tap. Job ids and message
  // claims keep that from sending anything twice. Tag and reminder removal
  // are idempotent, so a retried tap finishes what its first attempt began.
  // A reminder that went out first changes none of this: it is not the card.
  if (first.count === 1 || !cardIsOut(co)) {
    await addContactTags(co.workspaceId, co.contactId, [
      co.offer.tagInterested,
    ]);
    await cancelOfferJob(offerJobId.reminder(co.id));
    if (first.count === 1) {
      await queueConfirmations(co);
    } else {
      await prisma.contactOffer.updateMany({
        where: { id: co.id, ...CARD_NOT_OUT },
        data: { stoppedAt: null, stopReason: null },
      });
      await enqueueOfferJob(nextJob(co, { phase: "confirm", step: 0 }), {
        jobId: offerJobId.step(co.id, "confirm", 0),
      });
    }
    return;
  }

  // The first tap once more (a redelivered webhook): its card is out.
  if (mid && co.interestedMid === mid) return;

  // A later tap after the card: the card once more, once per tap, as every
  // tap on a campaign's button sends its link again.
  if (!withinWindow(tappedAt)) {
    console.log("[Offers] Tap handled too late to answer", job.id);
    return;
  }
  await deliverCard(job, co, "retap", mid ?? job.id ?? tappedAt.getTime());
}

/** Confirmation `step` after the tap; after the last one, the card. */
async function sendConfirmation(
  job: Job<ProcessOfferJob>,
  co: LoadedContactOffer,
  step: number
): Promise<void> {
  if (!co.interestedAt || co.stoppedAt) return;
  if (co.offer.archivedAt) return stopArchived(co);
  const messages = co.offer.confirmationMessages;
  if (step >= messages.length) return queueCard(co);
  if (!withinWindow(co.contact.lastInteractionAt)) return stopWindowClosed(co);

  const outcome = await sendOfferMessage(job, co, "confirm", step, (context) =>
    sendDirectMessage({
      ...sendTarget(co),
      context,
      message: render(co, messages[step]),
    })
  );
  if (outcome === "stopped") return;

  if (step + 1 < messages.length) {
    await enqueueOfferJob(nextJob(co, { phase: "confirm", step: step + 1 }), {
      jobId: offerJobId.step(co.id, "confirm", step + 1),
      delayMs: delayMs(co.offer.confirmationDelaysSeconds, step + 1),
    });
  } else {
    await queueCard(co);
  }
}

async function sendCardStep(
  job: Job<ProcessOfferJob>,
  co: LoadedContactOffer
): Promise<void> {
  if (!co.interestedAt || co.stoppedAt) return;
  if (co.offer.archivedAt) return stopArchived(co);
  if (!withinWindow(co.contact.lastInteractionAt)) return stopWindowClosed(co);
  await deliverCard(job, co, "card", 0);
}

/**
 * The card with the lead magnet's link, or its fallbacks (lib/offers/send.ts),
 * all inside one claim. The link is the offer's own redirect with the
 * person's token, so a click can tag them (R8).
 */
async function deliverCard(
  job: Attempts,
  co: LoadedContactOffer,
  phase: "card" | "retap",
  step: number | string
): Promise<void> {
  const { offer, contact } = co;
  const url = buildOfferUrl(offer.linkSlug, hashRecipientId(contact.igsid));
  const delivered: { via: OfferCardVia | null } = { via: null };
  const outcome = await sendOfferMessage(job, co, phase, step, async (context) => {
    delivered.via = await sendOfferCard({
      ...sendTarget(co),
      context,
      workspaceId: co.workspaceId,
      card: {
        title: offer.cardTitle,
        subtitle: offer.cardSubtitle,
        imageUrl: offer.cardImageUrl,
        button: { title: offer.cardButtonLabel, url },
      },
    });
  });
  if (outcome === "stopped") return;

  // How the card went out is known only when this run sent it. One an
  // earlier run claimed, or one with an unknown outcome, counts as sent all
  // the same.
  const firstSend = await prisma.contactOffer.updateMany({
    where: { id: co.id, sentAt: null },
    data: {
      sentAt: new Date(),
      ...(delivered.via ? { sentVia: delivered.via } : {}),
    },
  });
  // After the reminder the row counts as sent already, and keeps that time.
  // It records the card now (null: in a form not known), so later taps know
  // the card is out and get it once more.
  if (firstSend.count === 0) {
    await prisma.contactOffer.updateMany({
      where: { id: co.id, sentVia: SENT_BY_REMINDER },
      data: { sentVia: delivered.via },
    });
  }
  await addContactTags(co.workspaceId, co.contactId, [offer.tagSent]);
}

/** The reminder for someone who never tapped (R7). */
async function sendReminder(
  job: Job<ProcessOfferJob>,
  co: LoadedContactOffer
): Promise<void> {
  const { offer, contact } = co;
  const reminder = offer.reminderMessage?.trim();
  // A tap, an earlier reminder or a stop leaves nothing to remind of, and an
  // offer deleted since, or edited to have no reminder, sends none. A paused
  // offer still sends it: pausing only keeps the offer from new people. An
  // offer that started late has none (sendOfferStep queues none for it).
  if (
    co.interestedAt ||
    co.reminderSentAt ||
    co.stoppedAt ||
    co.lateStart ||
    offer.archivedAt ||
    !offer.reminderEnabled ||
    !reminder
  ) {
    return;
  }
  if (!withinWindow(contact.lastInteractionAt)) {
    return stopOffer(co, "WINDOW_CLOSED", {}, "Offer reminder skipped");
  }

  // Not renderMessageWithTracking, which only adds a link where the text has
  // {link}: the reminder always carries the offer's link, as a button.
  const url = buildOfferUrl(offer.linkSlug, hashRecipientId(contact.igsid));
  const text = render(co, reminder);
  const target = sendTarget(co);
  const outcome = await sendOfferMessage(job, co, "reminder", 0, async (context) => {
    try {
      await sendDirectMessageWithLinkButton({
        ...target,
        context,
        text,
        buttons: [{ title: offer.cardButtonLabel, url }],
      });
    } catch (buttonError) {
      // As for a campaign's link: plain text only after a proven rejection
      // of the button template, and the fallback's own outcome counts.
      if (!isTemplateRejection(buttonError)) throw buttonError;
      try {
        await sendDirectMessage({
          ...target,
          context,
          message: `${text}\n${url}`,
        });
      } catch (fallbackError) {
        throw classifySendError(fallbackError);
      }
    }
  });
  if (outcome === "stopped") return;

  const now = new Date();
  await prisma.contactOffer.updateMany({
    where: { id: co.id, reminderSentAt: null },
    data: { reminderSentAt: now },
  });
  await prisma.contactOffer.updateMany({
    where: { id: co.id, sentAt: null },
    data: { sentAt: now, sentVia: SENT_BY_REMINDER },
  });
  await addContactTags(co.workspaceId, co.contactId, [offer.tagSent]);
}

/**
 * Send one offer message under the policy all of them share:
 *
 * - It counts toward the workspace's monthly DMs (R18); without a slot the
 *   offer stops.
 * - It is claimed first. A claim taken by an earlier run means the message
 *   went out, or may have: it is not sent again and the sequence goes on.
 * - An unknown outcome may have reached the inbox. It is recorded, never sent
 *   again, and the sequence goes on.
 * - A rate limit is retried by BullMQ (after 5 and 15 minutes, still inside
 *   the window) and stops the offer on the last attempt.
 * - A closed window or any other refusal stops the offer and is recorded.
 * - A refusal stays a refusal when its claim cannot be given back; the claim
 *   left taken is reported on its own (refusedWithClaimKept).
 *
 * Only rate limits and database errors leave the job failed, so an expected
 * refusal never raises a worker alert.
 */
async function sendOfferMessage(
  job: Attempts,
  co: LoadedContactOffer,
  phase: SendPhase,
  step: number | string,
  send: (context: InstagramContext) => Promise<unknown>
): Promise<"sent" | "claimed" | "stopped"> {
  const account = co.contact.instagramAccount;
  if (!hasInstagramCredentials(account)) {
    await stopAccountUnavailable(co);
    return "stopped";
  }
  let context: InstagramContext;
  try {
    // An operation id per message, which Zernio's idempotency key is made of.
    context = await createInstagramContext(
      account,
      `offer:${co.id}:${phase}:${step}`
    );
  } catch (error) {
    await stopAccountUnavailable(co, formatError(error));
    return "stopped";
  }

  const usage = await reserveWorkspaceDMSend(co.workspaceId);
  if (!usage.allowed) {
    await stopOffer(co, "PLAN_LIMIT", { phase, step, limit: usage.limit });
    return "stopped";
  }
  const release = () =>
    releaseWorkspaceDMReservation(co.workspaceId, usage.periodStart);

  const operationId = createHash("sha256")
    .update(
      JSON.stringify([co.contact.instagramAccountId, "offer", co.id, phase, step])
    )
    .digest("hex");

  // The claim stays outside the send's error handling. A database error on
  // it means nothing was sent: the reservation goes back and the job is
  // retried, instead of the error counting as an unknown delivery.
  let claimed: boolean;
  try {
    claimed = await claimPostbackDelivery(operationId);
  } catch (error) {
    await release();
    throw error;
  }
  if (!claimed) {
    await release();
    return "claimed";
  }

  try {
    await sendClaimedPostback({ operationId, send: () => send(context) });
    return "sent";
  } catch (error) {
    if (error instanceof ClaimReleaseError) {
      return refusedWithClaimKept(co, phase, step, operationId, error, release);
    }
    if (isDeliveryUnconfirmed(error)) {
      await logWorkerEvent({
        workspaceId: co.workspaceId,
        level: "WARNING",
        message: "Offer message delivery unconfirmed",
        payload: eventPayload(co, { phase, step, error: formatError(error) }),
      });
      return "sent";
    }
    // Every send error arrives as a refusal or an unknown outcome; anything
    // else is a failure of this worker, retried like a database error.
    if (!isConfirmedSendRejection(error)) throw error;
    await release();

    if (
      error instanceof RateLimitError &&
      job.attemptsMade + 1 < (job.opts?.attempts ?? 3)
    ) {
      throw error;
    }
    await stopRefused(co, phase, step, error);
    return "stopped";
  }
}

/**
 * Instagram refused the message, and the database failed while giving its
 * claim back. Nothing was delivered, so this is a refusal like any other:
 * the reservation goes back and the offer stops for the refusal's reason.
 * The claim stays taken, though, and a retry of this job would take the
 * message for sent and carry on as if it had gone out. So there is no retry,
 * not even for a rate limit, and the claim left behind is reported on its
 * own. Should recording the refusal fail as well, the job ends for good
 * rather than being retried into that mistake.
 */
async function refusedWithClaimKept(
  co: LoadedContactOffer,
  phase: SendPhase,
  step: number | string,
  operationId: string,
  error: ClaimReleaseError,
  release: () => Promise<unknown>
): Promise<"stopped"> {
  console.error(
    "[Offers] Claim of a refused message not released:",
    formatError(error.releaseError)
  );
  await logWorkerEvent({
    workspaceId: co.workspaceId,
    level: "WARNING",
    message: "Offer message claim not released after a refusal",
    payload: eventPayload(co, {
      phase,
      step,
      claim: operationId,
      error: formatError(error.releaseError),
    }),
  });
  try {
    await release();
    await stopRefused(co, phase, step, error.refusal);
  } catch (writeError) {
    throw new UnrecoverableError(
      `Offer message refused, its claim kept and the refusal not recorded: ${formatError(writeError)}`
    );
  }
  return "stopped";
}

/** Stop the offer for a confirmed rejection of one of its messages. */
function stopRefused(
  co: LoadedContactOffer,
  phase: SendPhase,
  step: number | string,
  error: unknown
): Promise<void> {
  if (error instanceof RateLimitError) {
    return stopOffer(co, "RATE_LIMITED", { phase, step, error: formatError(error) });
  }
  if (
    error instanceof MetaApiError &&
    /outside of allowed window/i.test(error.message)
  ) {
    return stopOffer(co, "WINDOW_CLOSED", { phase, step });
  }
  return stopOffer(co, "REJECTED", { phase, step, error: formatError(error) });
}

// How each stop is reported in Diagnostics: a closed window and a deleted
// offer are expected, anything else needs a look.
const STOPS: Record<StopReason, { level: OperationalEventLevel; why: string }> = {
  WINDOW_CLOSED: { level: "INFO", why: "messaging window closed" },
  OFFER_ARCHIVED: { level: "INFO", why: "offer was deleted" },
  REJECTED: { level: "WARNING", why: "Instagram refused a message" },
  RATE_LIMITED: { level: "WARNING", why: "Instagram rate limit reached" },
  PLAN_LIMIT: { level: "WARNING", why: "monthly DM limit reached" },
  ACCOUNT_UNAVAILABLE: {
    level: "WARNING",
    why: "the Instagram account is unavailable",
  },
};

/**
 * End the offer early and say why in Diagnostics. The first stop's reason
 * is kept.
 *
 * An offer whose link reached the person (the card, one of its fallbacks or
 * the reminder: sentAt) did not stop early, whatever fails after that: the
 * card sent again for a later tap, or a confirmation or the card after the
 * reminder. Such a failure is still reported, as a message not sent, but
 * the row is not marked, so the funnel's "stopped" only counts offers that
 * ended before the person got the link.
 */
async function stopOffer(
  co: LoadedContactOffer,
  reason: StopReason,
  details: Record<string, Prisma.InputJsonValue | null> = {},
  headline = "Offer stopped"
): Promise<void> {
  const { level, why } = STOPS[reason];
  const delivered = co.sentAt !== null;
  if (!delivered) {
    await prisma.contactOffer.updateMany({
      // sentAt as well: a delivery recorded since this job read the row.
      where: { id: co.id, stoppedAt: null, sentAt: null },
      data: { stoppedAt: new Date(), stopReason: reason },
    });
  }
  await logWorkerEvent({
    workspaceId: co.workspaceId,
    level,
    message: `${delivered ? "Offer message not sent" : headline}: ${why}`,
    payload: eventPayload(co, { reason, ...details }),
  });
}

function stopArchived(co: LoadedContactOffer): Promise<void> {
  return stopOffer(co, "OFFER_ARCHIVED");
}

function stopWindowClosed(co: LoadedContactOffer): Promise<void> {
  return stopOffer(co, "WINDOW_CLOSED");
}

function stopAccountUnavailable(
  co: LoadedContactOffer,
  error?: string
): Promise<void> {
  return stopOffer(co, "ACCOUNT_UNAVAILABLE", error ? { error } : {});
}

function eventPayload(
  co: LoadedContactOffer,
  details: Record<string, Prisma.InputJsonValue | null> = {}
): Prisma.InputJsonObject {
  return {
    contactOfferId: co.id,
    offerId: co.offerId,
    offerName: co.offer.name,
    automationId: co.automationId,
    userId: co.contact.igsid,
    ...details,
  };
}

// Offer texts are in the owner's language: without a name, {username} leaves
// no English "there" behind (lib/tracking/message.ts).
function render(co: LoadedContactOffer, message: string): string {
  return renderMessageWithoutLink({
    message,
    commenterName: co.contact.username,
    fallbackName: "",
  });
}

function sendTarget(co: LoadedContactOffer) {
  return {
    instagramAccountId: co.contact.instagramAccount.instagramId,
    userId: co.contact.igsid,
  };
}

function nextJob(
  co: LoadedContactOffer,
  next: Pick<ProcessOfferJob, "phase" | "step">
): ProcessOfferJob {
  return {
    workspaceId: co.workspaceId,
    accountConnectionId: co.contact.instagramAccountId,
    instagramAccountId: co.contact.instagramAccount.instagramId,
    contactOfferId: co.id,
    ...next,
  };
}

function queueConfirmations(co: LoadedContactOffer): Promise<void> {
  if (co.offer.confirmationMessages.length === 0) return queueCard(co);
  return enqueueOfferJob(nextJob(co, { phase: "confirm", step: 0 }), {
    jobId: offerJobId.step(co.id, "confirm", 0),
    delayMs: delayMs(co.offer.confirmationDelaysSeconds, 0),
  });
}

function queueCard(co: LoadedContactOffer): Promise<void> {
  return enqueueOfferJob(nextJob(co, { phase: "card" }), {
    jobId: offerJobId.card(co.id),
    delayMs: CARD_DELAY_MS,
  });
}

// The pause before message `index`, from the offer's list of seconds.
function delayMs(delaysSeconds: readonly number[], index: number): number {
  return Math.max(0, delaysSeconds[index] ?? 0) * 1000;
}
