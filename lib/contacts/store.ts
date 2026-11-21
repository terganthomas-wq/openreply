/**
 * Contacts and their tags.
 *
 * A contact is one Instagram user as one connected account sees them: the
 * Instagram-scoped id (IGSID) only means something per account, and a
 * workspace can connect several. Rows are keyed on the account row and the
 * IGSID, so a comment, a button tap and a DM from the same person all land on
 * one row. Contacts belong to the account and the workspace, never to a
 * campaign, so pausing or deleting a campaign leaves them alone.
 *
 * Every write here is idempotent: a retried job or a redelivered webhook only
 * refreshes what is already there.
 */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { formatError, isUniqueViolation } from "@/lib/queue/send-helpers";
import { hashRecipientId } from "@/lib/tracking/server";

/** The client a tag is written with: the app's, or an open transaction. */
export type TagWriter = Pick<Prisma.TransactionClient, "contactTag">;

export interface ContactIdentity {
  workspaceId: string;
  /** InstagramAccount row id, as on DmLog, not the Instagram business id. */
  instagramAccountId: string;
  igsid: string;
  /** The handle, when the caller knows it. A missing one never erases a stored name. */
  username?: string | null;
  /**
   * When the person tapped a button or sent a DM. Only those open Instagram's
   * 24-hour messaging window, so a comment or a read receipt passes nothing.
   */
  interactionAt?: Date | null;
}

export interface ContactSummary {
  id: string;
  username: string | null;
  lastInteractionAt: Date | null;
}

// Callers add one to four tags at a time; this only bounds a runaway list.
const MAX_TAGS_PER_CALL = 100;

/**
 * Create the contact or refresh it, then move its last interaction forward.
 * Throws on a database error; send paths use ensureContactSafe.
 */
export async function ensureContact(
  input: ContactIdentity,
): Promise<ContactSummary> {
  let contact: ContactSummary;
  try {
    contact = await upsertContact(input);
  } catch (error) {
    // Prisma runs this upsert as one INSERT ... ON CONFLICT DO UPDATE, which
    // is safe when a comment and a tap from someone new arrive together. If
    // it ever falls back to its emulated upsert (a read, then an insert), the
    // slower of two such jobs fails on the unique key; a second try finds the
    // row and updates it.
    if (!isUniqueViolation(error)) throw error;
    contact = await upsertContact(input);
  }

  const at = input.interactionAt;
  if (
    at &&
    (!contact.lastInteractionAt ||
      contact.lastInteractionAt.getTime() < at.getTime())
  ) {
    await touchContactInteraction(contact.id, at);
    contact = { ...contact, lastInteractionAt: at };
  }
  return contact;
}

function upsertContact({
  workspaceId,
  instagramAccountId,
  igsid,
  username,
  interactionAt,
}: ContactIdentity): Promise<ContactSummary> {
  // The ?r= token of this person's tracked links, so a click can be matched
  // to them. Stored because the HMAC cannot be reversed, and rewritten on
  // every write so a changed secret is picked up.
  const recipientHash = hashRecipientId(igsid);
  return prisma.contact.upsert({
    where: { instagramAccountId_igsid: { instagramAccountId, igsid } },
    create: {
      workspaceId,
      instagramAccountId,
      igsid,
      username: username || null,
      recipientHash,
      lastInteractionAt: interactionAt ?? null,
    },
    // Taps and DMs carry no handle, so they must not erase the one a comment
    // stored. Any update also bumps updatedAt, the "last seen" time.
    update: { recipientHash, ...(username ? { username } : {}) },
    select: { id: true, username: true, lastInteractionAt: true },
  });
}

/**
 * The stored contact, never created: null when there is none. For work that
 * runs long after the contact was recorded, such as an offer that starts 22
 * hours after its link: a contact deleted in the meantime (on request, GDPR)
 * must stay deleted. A found contact's last interaction moves forward to
 * `interactionAt` like in ensureContact. Throws on a database error.
 */
export async function findContact({
  workspaceId,
  instagramAccountId,
  igsid,
  interactionAt,
}: Omit<ContactIdentity, "username">): Promise<ContactSummary | null> {
  const contact = await prisma.contact.findFirst({
    where: { workspaceId, instagramAccountId, igsid },
    select: { id: true, username: true, lastInteractionAt: true },
  });
  if (!contact) return null;

  if (
    interactionAt &&
    (!contact.lastInteractionAt ||
      contact.lastInteractionAt.getTime() < interactionAt.getTime())
  ) {
    // By id and forward only: a contact deleted since the read stays gone.
    await touchContactInteraction(contact.id, interactionAt);
    return { ...contact, lastInteractionAt: interactionAt };
  }
  return contact;
}

/**
 * ensureContact for the paths that send a DM. A failed write is logged and
 * the caller goes on: thrown, it would retry the job five minutes later and
 * hold back the DM for a bookkeeping row.
 */
export async function ensureContactSafe(
  input: ContactIdentity,
): Promise<ContactSummary | null> {
  try {
    return await ensureContact(input);
  } catch (error) {
    console.error("[Contacts] Failed to record a contact:", formatError(error));
    return null;
  }
}

/**
 * Record an interaction, forward only. Jobs for one person can finish out of
 * order (a retry, a delayed re-check), and moving the time back would make the
 * messaging window look closed before it is.
 */
export async function touchContactInteraction(
  contactId: string,
  at: Date,
): Promise<void> {
  await prisma.contact.updateMany({
    where: {
      id: contactId,
      OR: [{ lastInteractionAt: null }, { lastInteractionAt: { lt: at } }],
    },
    data: { lastInteractionAt: at },
  });
}

/**
 * Tag a contact. A tag it already has keeps the time it was first set, so a
 * repeated delivery or a retried job changes nothing. Returns how many of the
 * tags were new. Pass a transaction as `db` to write the tags together with
 * what they record.
 */
export async function addContactTags(
  workspaceId: string,
  contactId: string,
  tags: readonly string[],
  db: TagWriter = prisma,
): Promise<number> {
  const unique = [
    ...new Set(tags.map((tag) => tag.trim()).filter(Boolean)),
  ].slice(0, MAX_TAGS_PER_CALL);
  if (unique.length === 0) return 0;

  const { count } = await db.contactTag.createMany({
    data: unique.map((tag) => ({ workspaceId, contactId, tag })),
    skipDuplicates: true,
  });
  return count;
}
