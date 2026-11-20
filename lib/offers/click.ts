/**
 * A click on an offer's card or reminder button (R8).
 *
 * The link carries the recipient token (?r=, hashRecipientId of the IGSID),
 * which cannot be reversed; the contact stores the same token, so the click
 * finds the person's offer through it. Only the first click counts: it sets
 * clickedAt and the offer's "clicked" tag, and every later one changes
 * nothing. No LinkClick row is written, so campaign click rates keep counting
 * campaign links only.
 *
 * clickedAt and the tag are written in one transaction. Once clickedAt is
 * set, later clicks no longer find the row, so a tag that failed after it
 * would never have been written: the funnel would count the click while the
 * contact list showed nobody with the tag. Now a failed write leaves neither,
 * and the next click records both.
 */

import { addContactTags } from "@/lib/contacts/store";
import { prisma } from "@/lib/db/client";

/** Returns how many offers the click marked as clicked: 0 or, rarely, more. */
export async function recordOfferClick({
  workspaceId,
  offerId,
  tagClicked,
  token,
}: {
  workspaceId: string;
  offerId: string;
  /** The offer's tag for a click, read when the click came in. */
  tagClicked: string;
  /** A token that passed parseRecipientToken. */
  token: string;
}): Promise<number> {
  // Not limited to offers whose card is marked sent: a quick tap can arrive
  // before the worker records the delivery. The token does not name the
  // account, so a workspace with several accounts may in theory find more
  // than one row; each is the offer that went to that contact.
  const rows = await prisma.contactOffer.findMany({
    where: {
      workspaceId,
      offerId,
      clickedAt: null,
      contact: { recipientHash: token },
    },
    select: { id: true, contactId: true },
  });

  const now = new Date();
  let recorded = 0;
  for (const row of rows) {
    const marked = await prisma.$transaction(async (tx) => {
      // Two clicks at once both find the row; only one of them sets the
      // time, and only that one adds the tag.
      const { count } = await tx.contactOffer.updateMany({
        where: { id: row.id, workspaceId, clickedAt: null },
        data: { clickedAt: now },
      });
      if (count === 0) return false;
      await addContactTags(workspaceId, row.contactId, [tagClicked], tx);
      return true;
    });
    if (marked) recorded += 1;
  }
  return recorded;
}
