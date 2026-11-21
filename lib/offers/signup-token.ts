/**
 * A person's sign-up code for an offer (ContactOffer.signupToken): created
 * on their first click on the offer's link while the offer reports sign-ups,
 * and the same on every later click. The offer redirect adds it to the
 * destination as ig=<code> (lib/offers/signup-link.ts); the landing page
 * reports it back (lib/offers/signup.ts).
 *
 * Kept apart from the reporting, which queues jobs: the redirect, which a
 * person waits for, loads the database client and nothing else.
 *
 * Whoever holds a code and a sign-up key can mark that person as signed up,
 * so the code is never logged and never shown in the dashboard. It goes with
 * its row: deleting the contact (GDPR) deletes the row.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { SIGNUP_TOKEN_BYTES } from "./signup-link";

/** A new code: 18 random bytes, 24 base64url characters. */
export function newSignupToken(): string {
  return randomBytes(SIGNUP_TOKEN_BYTES).toString("base64url");
}

/**
 * What went wrong, without the message. A database error's message can quote
 * the query it failed on, a code included, so only its kind is logged.
 */
export function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  const code =
    "code" in error && typeof error.code === "string" ? ` ${error.code}` : "";
  return `${error.name}${code}`;
}

/**
 * The code for a click on an offer's link: the one of the clicking person's
 * row for this offer, created now if the row has none yet. Null when the
 * link's recipient token belongs to nobody who got the offer. The token does
 * not name the account, so in a workspace with several accounts it may in
 * theory fit more than one contact; the newest row counts.
 */
export async function signupTokenFor({
  workspaceId,
  offerId,
  recipientHash,
}: {
  workspaceId: string;
  offerId: string;
  /** A token that passed parseRecipientToken. */
  recipientHash: string;
}): Promise<string | null> {
  const row = await prisma.contactOffer.findFirst({
    where: { workspaceId, offerId, contact: { recipientHash } },
    orderBy: [{ offeredAt: "desc" }, { id: "desc" }],
    select: { id: true, signupToken: true },
  });
  if (!row) return null;
  if (row.signupToken) return row.signupToken;

  // Only into an empty column, so two clicks at once end with one code: the
  // slower one reads the code the faster one wrote.
  const token = newSignupToken();
  const { count } = await prisma.contactOffer.updateMany({
    where: { id: row.id, workspaceId, signupToken: null },
    data: { signupToken: token },
  });
  if (count === 1) return token;
  const current = await prisma.contactOffer.findFirst({
    where: { id: row.id, workspaceId },
    select: { signupToken: true },
  });
  return current?.signupToken ?? null;
}
