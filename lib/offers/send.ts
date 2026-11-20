/**
 * The card an offer ends with, and the fallbacks that still get its link to
 * the person when Instagram refuses the card.
 *
 * This installation has never sent a generic template, so neither the way
 * Meta renders one nor the way it words a refusal is known yet. A refused card
 * therefore becomes the same text with the card's button, and a refused button
 * template becomes plain text with the link.
 *
 * Each fallback is another send of the same message, and one only goes out
 * after a confirmed rejection of the previous one. Callers run the whole chain
 * inside one sendPostbackOnce claim (lib/queue/send-helpers.ts), so a retry or
 * a redelivered job can never deliver the card twice.
 */

import { classifySendError } from "@/lib/instagram/delivery-errors";
import {
  cardFallbackText,
  MetaApiError,
  RateLimitError,
  sendDirectMessage,
  sendDirectMessageWithCard,
  sendDirectMessageWithLinkButton,
  TokenExpiredError,
  type CardMessage,
  type InstagramContext,
} from "@/lib/instagram/provider";
import {
  formatError,
  isTemplateRejection,
  logWorkerEvent,
  NON_TEMPLATE_REJECTIONS,
} from "@/lib/queue/send-helpers";
import { ZernioApiError } from "@/lib/zernio/client";

/** What reached the person: the card, its text with the button, or plain text. */
export type OfferCardVia = "CARD" | "BUTTON" | "TEXT";

/**
 * Whether Meta refused the card itself, so the button message may follow.
 *
 * isTemplateRejection looks for "template" or "button" in Meta's text, but a
 * refused generic template is more likely to name its element, its image_url
 * or the attachment, and would then end with no message at all. Any code 100
 * counts instead: it is a confirmed rejection, so nothing was delivered and
 * the fallback cannot deliver twice, and a card is always a DM, never a
 * comment's single private reply that the first attempt could have used up.
 * The rejections in NON_TEMPLATE_REJECTIONS still end the chain: they refuse
 * the conversation, not the card, and would refuse every fallback as well.
 */
export function isCardRejection(error: unknown): boolean {
  if (
    error instanceof ZernioApiError ||
    error instanceof TokenExpiredError ||
    error instanceof RateLimitError
  ) {
    return false;
  }
  return (
    error instanceof MetaApiError &&
    error.code === 100 &&
    !NON_TEMPLATE_REJECTIONS.some((pattern) => pattern.test(error.message))
  );
}

/**
 * Send the card, falling back to a button message and then to plain text.
 * Zernio delivers the card as text with its button in one request and never
 * falls back.
 *
 * The card's own errors are rethrown unchanged, for the caller's claim to
 * classify like any other send. A fallback's errors pass through
 * classifySendError, as in the campaign link's fallback: an unknown outcome
 * arrives as DeliveryUnconfirmedError and is never sent again, and a confirmed
 * rejection is reported as itself rather than as the refused card.
 */
export async function sendOfferCard({
  context,
  instagramAccountId,
  userId,
  card,
  workspaceId,
}: {
  context: InstagramContext;
  /** The Instagram business id the message is sent from. */
  instagramAccountId: string;
  /** The recipient's IGSID. */
  userId: string;
  card: CardMessage;
  workspaceId: string;
}): Promise<OfferCardVia> {
  try {
    await sendDirectMessageWithCard({
      context,
      instagramAccountId,
      userId,
      card,
    });
    // Zernio has no cards: it delivered the card's text with its button.
    return context.provider === "ZERNIO" ? "BUTTON" : "CARD";
  } catch (cardError) {
    if (!isCardRejection(cardError)) throw cardError;

    console.log(
      "[Offers] Card rejected, falling back to a button message:",
      formatError(cardError)
    );
    // Logged before the fallback, which may fail as well: a refused card is
    // what the offer's owner has to fix, and an image URL Instagram cannot
    // load is the likeliest reason.
    await logWorkerEvent({
      workspaceId,
      level: "WARNING",
      message: "Offer card fell back to a button message",
      payload: {
        userId,
        imageUrl: card.imageUrl ?? null,
        error: formatError(cardError),
      },
    });
  }

  const text = cardFallbackText(card);
  try {
    await sendDirectMessageWithLinkButton({
      context,
      instagramAccountId,
      userId,
      text,
      buttons: [card.button],
    });
    return "BUTTON";
  } catch (buttonError) {
    if (!isTemplateRejection(buttonError)) throw classifySendError(buttonError);

    console.log(
      "[Offers] Button template rejected, falling back to plain text:",
      formatError(buttonError)
    );
  }

  try {
    await sendDirectMessage({
      context,
      instagramAccountId,
      userId,
      message: `${text}\n${card.button.url}`,
    });
    return "TEXT";
  } catch (textError) {
    throw classifySendError(textError);
  }
}
