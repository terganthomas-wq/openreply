/**
 * Lead-magnet offer input (R3), shared by the Offers API and the offer
 * editor. No database import, so it stays usable from client code.
 *
 * Instagram cuts button titles after 20 UTF-16 units, the text of a message
 * that carries buttons after 640 and a card's title and subtitle after 80.
 * Those limits count UTF-16 units, as the senders do (lib/validation/text.ts);
 * texts sent on their own keep the 1000 characters of a campaign's messages.
 */

import { z } from "zod";
import {
  BUTTON_LABEL_MAX,
  BUTTON_TEXT_MAX,
  CARD_TEXT_MAX,
  utf16Max,
} from "@/lib/validation/text";

/** At most this many offer messages, and as many confirmations. */
export const OFFER_MESSAGES_MAX = 5;
/** The longest pause before one message, in seconds. */
export const OFFER_DELAY_MAX_SECONDS = 60;
/**
 * The latest reminder, in hours after the offer. Instagram's window closes
 * 24 hours after the person's last tap or DM.
 */
export const REMINDER_DELAY_MAX_HOURS = 23;

// Exported for the offer editor, so its fields stop where the API does.
/** A message sent on its own, like a campaign's messages. */
export const OFFER_MESSAGE_MAX = 1000;
export const OFFER_NAME_MAX = 100;
/** A funnel tag, as long as a campaign's delivery tag may be. */
export const OFFER_TAG_MAX = 100;
/** The card's image and the link behind its button. */
export const OFFER_URL_MAX = 2000;

/**
 * A card image uploaded in the editor (POST /api/offers/image): at most
 * 5 MB, and a JPEG, PNG or WebP file. The server tells the type from the
 * file's first bytes; the editor checks the declared type and the size
 * before sending, so most wrong files never leave the browser.
 */
export const OFFER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const OFFER_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

// A required text: trimmed, then not empty.
const line = (max: number) => z.string().trim().min(1).max(max);

// The same for a text Instagram cuts, counted in UTF-16 units.
const cutLine = (max: number) => z.string().trim().min(1).pipe(utf16Max(max));

// An optional text Instagram cuts; empty or left out means none.
const optionalCutText = (max: number) =>
  z
    .string()
    .trim()
    .pipe(utf16Max(max))
    .transform((value) => value || null)
    .nullable()
    .default(null);

// An optional text sent on its own; empty or left out means none.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable()
    .default(null);

// Seconds before each message of a list, one entry per message.
const delays = z
  .array(z.number().int().min(0).max(OFFER_DELAY_MAX_SECONDS))
  .max(OFFER_MESSAGES_MAX);

/**
 * The rule that the last offer message, which carries the button, keeps the
 * 640 units of a button message (here and in the workspace's default texts
 * for offers). Its issue names the rule and the limit in params, so the
 * editors can word it in the interface language.
 */
export const LAST_OFFER_MESSAGE_RULE = "lastOfferMessage";

/**
 * Every field of an offer. A body is the whole offer: what it leaves out gets
 * its default, on an edit too, so a form that drops a field clears it. The
 * exception is isActive, the Offers page's pause switch: left out, a new
 * offer starts active and an edit keeps the offer paused or active.
 */
export const offerFieldsSchema = z.object({
  name: line(OFFER_NAME_MAX),
  isActive: z.boolean().optional(),
  // One DM each; the last one carries the "yes, send it" button.
  offerMessages: z.array(line(OFFER_MESSAGE_MAX)).min(1).max(OFFER_MESSAGES_MAX),
  offerDelaysSeconds: delays,
  offerButtonLabel: cutLine(BUTTON_LABEL_MAX),
  // Sent after the tap, before the card.
  confirmationMessages: z
    .array(line(OFFER_MESSAGE_MAX))
    .max(OFFER_MESSAGES_MAX)
    .default([]),
  confirmationDelaysSeconds: delays.default([]),
  // Meta downloads the image itself, over https only. Empty or left out means
  // none, like the optional texts: an image field the editor leaves blank
  // sends "".
  cardImageUrl: z
    .string()
    .trim()
    .transform((value) => value || null)
    .pipe(z.url({ protocol: /^https$/ }).max(OFFER_URL_MAX).nullable())
    .nullable()
    .default(null),
  cardTitle: cutLine(CARD_TEXT_MAX),
  cardSubtitle: optionalCutText(CARD_TEXT_MAX),
  cardButtonLabel: cutLine(BUTTON_LABEL_MAX),
  // Behind the card's and the reminder's button. http(s) only: z.url() alone
  // also takes javascript: and mailto:. Drive and Docs share links pass.
  destinationUrl: z.httpUrl().max(OFFER_URL_MAX),
  reminderEnabled: z.boolean().default(true),
  reminderDelayHours: z
    .number()
    .int()
    .min(1)
    .max(REMINDER_DELAY_MAX_HOURS)
    .default(REMINDER_DELAY_MAX_HOURS),
  // Goes out with the card's button, so it must fit a button message.
  reminderMessage: optionalCutText(BUTTON_TEXT_MAX),
  // Sign-up feedback: the links carry the person's code to the landing page,
  // which reports the sign-up back (lib/offers/signup.ts). Left out, an edit
  // switches it off, like every other field it leaves out.
  signupTrackingEnabled: z.boolean().default(false),
  // The chat confirmation after a reported sign-up, sent on its own; none
  // means the tag alone.
  signupMessage: optionalText(OFFER_MESSAGE_MAX),
  // The funnel tags (R2). Free text: two offers may share one.
  tagOffered: line(OFFER_TAG_MAX),
  tagInterested: line(OFFER_TAG_MAX),
  tagSent: line(OFFER_TAG_MAX),
  tagClicked: line(OFFER_TAG_MAX),
  tagSignedUp: line(OFFER_TAG_MAX),
});

/** A whole offer, as the editor saves it (POST, and PATCH with every field). */
export const offerInputSchema = offerFieldsSchema.superRefine((offer, ctx) => {
  if (offer.offerDelaysSeconds.length !== offer.offerMessages.length) {
    ctx.addIssue({
      code: "custom",
      path: ["offerDelaysSeconds"],
      message: "Give one delay per offer message",
    });
  }
  if (
    offer.confirmationDelaysSeconds.length !== offer.confirmationMessages.length
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["confirmationDelaysSeconds"],
      message: "Give one delay per confirmation message",
    });
  }
  const last = offer.offerMessages.length - 1;
  if (last >= 0 && offer.offerMessages[last].length > BUTTON_TEXT_MAX) {
    ctx.addIssue({
      code: "custom",
      path: ["offerMessages", last],
      message: `The last offer message carries the button: at most ${BUTTON_TEXT_MAX} characters (emoji count as 2)`,
      params: { maximum: BUTTON_TEXT_MAX, rule: LAST_OFFER_MESSAGE_RULE },
    });
  }
  if (offer.reminderEnabled && !offer.reminderMessage) {
    ctx.addIssue({
      code: "custom",
      path: ["reminderMessage"],
      message: "Write the reminder, or turn it off",
    });
  }
});

/** A whole offer after validation, with every default filled in. */
export type OfferInput = z.infer<typeof offerInputSchema>;

// The pause switch's body: isActive and nothing else.
function isSwitchBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    "isActive" in body
  );
}

/**
 * PATCH body: the Offers page's pause switch sends { isActive } alone; the
 * editor sends the whole offer.
 *
 * The keys decide which, before either is validated. When both members of a
 * union fail without aborting, zod reports neither's field errors: a whole
 * offer that carries isActive and a label that is too long would come back
 * as a bare "Invalid input". A failed pipe aborts, so the switch member drops
 * out of the union for any other body.
 */
export const offerPatchSchema = z.union([
  z
    .custom<{ isActive: unknown }>(isSwitchBody)
    .pipe(z.object({ isActive: z.boolean() })),
  offerInputSchema,
]);

/** PUT body: every offer on the Offers page, in the new default order. */
export const offerOrderSchema = z.object({
  order: z.array(z.string().min(1).max(40)).max(200),
});
