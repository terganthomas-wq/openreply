/**
 * Workspace message defaults (R14, R18): the texts and switches a new
 * campaign opens with in the editor, and those a new offer starts from.
 *
 * Each workspace keeps its own in Workspace.messageDefaults, which its owners
 * and admins edit (app/api/workspace/message-defaults). A workspace without
 * them is seeded once with the built-in set for the interface language, when
 * there is one: German today. In the other languages the editor opens as it
 * did before, until someone saves defaults.
 *
 * Client-safe (no database import), so the editors check what they save with
 * the schema the API uses.
 *
 * These are outgoing messages, the workspace's own content, and never
 * translation keys (docs/localization.md). The built-in set is generic: every
 * customer's workspace starts from it, so it names no brand, niche or product.
 */

import { z } from "zod";
import type { Locale } from "@/lib/i18n";
import type { ImportRow } from "@/lib/import-queue";
import {
  OFFER_DELAY_MAX_SECONDS,
  OFFER_MESSAGES_MAX,
  REMINDER_DELAY_MAX_HOURS,
} from "@/lib/offers/schema";
import {
  BUTTON_LABEL_MAX,
  BUTTON_TEXT_MAX,
  utf16Max,
} from "@/lib/validation/text";

/** The shape of the stored JSON. Anything else reads as "no defaults". */
export const MESSAGE_DEFAULTS_VERSION = 1;

/** Texts sent on their own (public replies, offer messages): as campaigns. */
const MESSAGE_MAX = 1000;
/** A campaign takes up to ten public replies. */
const PUBLIC_REPLIES_MAX = 10;
/** Tag names, as on offers and campaigns. */
const TAG_MAX = 100;

// A text that may stay empty. Instagram cuts it after `max` UTF-16 units, so
// it is counted the way the senders cut (lib/validation/text.ts). The opening
// DM, both follow requests and the link DM go out with buttons and are held
// to the 640 units of a button message, even where a campaign still takes
// 1000 characters: a default should never go out cut.
const text = (max: number) => z.string().trim().pipe(utf16Max(max));

// One message of a list: trimmed and not empty.
const listItem = z.string().trim().min(1).max(MESSAGE_MAX);

// Seconds before each message of a list, one entry per message.
const delays = z
  .array(z.number().int().min(0).max(OFFER_DELAY_MAX_SECONDS))
  .max(OFFER_MESSAGES_MAX);

// An offer's tag name with {name} where the offer's name goes.
const tagTemplate = z.string().trim().min(1).max(TAG_MAX);

/**
 * What a new campaign opens with. Only texts and switches: keywords, post and
 * links belong to each campaign. Combinations the campaign API refuses (an
 * opening DM switched on without its text, offers without the opening DM) are
 * not refused here: these only prefill the editor, which checks them, like
 * any campaign, when it is saved.
 */
export const campaignDefaultsSchema = z.object({
  openingDmEnabled: z.boolean(),
  openingDmMessage: text(BUTTON_TEXT_MAX),
  openingDmButtonLabel: text(BUTTON_LABEL_MAX),
  requireFollow: z.boolean(),
  followPromptMessage: text(BUTTON_TEXT_MAX),
  followPromptButtonLabel: text(BUTTON_LABEL_MAX),
  followPromptRetryMessage: text(BUTTON_TEXT_MAX),
  followPromptRetryButtonLabel: text(BUTTON_LABEL_MAX),
  dmMessage: text(BUTTON_TEXT_MAX),
  linkButtonLabel: text(BUTTON_LABEL_MAX),
  publicReplyEnabled: z.boolean(),
  publicReplyMessages: z.array(listItem).max(PUBLIC_REPLIES_MAX),
  ignoreQuestionComments: z.boolean(),
  // Weg 2: start the lead-magnet offers after the link.
  offersEnabled: z.boolean(),
});

// The fields of an offer's defaults, before the rules across fields, so that
// an update can take any of them on its own.
const offerDefaultsFields = z.object({
  offerMessages: z.array(listItem).max(OFFER_MESSAGES_MAX),
  offerDelaysSeconds: delays,
  // The last offer message carries this button.
  offerButtonLabel: text(BUTTON_LABEL_MAX),
  confirmationMessages: z.array(listItem).max(OFFER_MESSAGES_MAX),
  confirmationDelaysSeconds: delays,
  cardButtonLabel: text(BUTTON_LABEL_MAX),
  reminderEnabled: z.boolean(),
  reminderDelayHours: z.number().int().min(1).max(REMINDER_DELAY_MAX_HOURS),
  // Goes out with the card's button.
  reminderMessage: text(BUTTON_TEXT_MAX),
  // The four funnel tags of a new offer (R2), rendered by renderTagTemplate.
  tagTemplates: z.object({
    offered: tagTemplate,
    interested: tagTemplate,
    sent: tagTemplate,
    clicked: tagTemplate,
  }),
});

/** What a new offer starts from; its name, card and link are its own. */
export const offerDefaultsSchema = offerDefaultsFields.superRefine(
  (offer, ctx) => {
    // The offer editor shows each message with the pause before it.
    if (offer.offerDelaysSeconds.length !== offer.offerMessages.length) {
      ctx.addIssue({
        code: "custom",
        path: ["offerDelaysSeconds"],
        message: "Give one delay per offer message",
      });
    }
    if (
      offer.confirmationDelaysSeconds.length !==
      offer.confirmationMessages.length
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
      });
    }
  }
);

export const messageDefaultsSchema = z.object({
  version: z.literal(MESSAGE_DEFAULTS_VERSION),
  campaign: campaignDefaultsSchema,
  offer: offerDefaultsSchema,
});

export type MessageDefaults = z.infer<typeof messageDefaultsSchema>;
export type CampaignDefaults = MessageDefaults["campaign"];
export type OfferDefaults = MessageDefaults["offer"];

/**
 * PUT body: the fields to change, by section. Whatever it leaves out keeps
 * its saved value, so the campaign editor can save its texts without
 * touching the offer's, and the other way round. Unknown keys are refused
 * rather than dropped, so a misspelt field never reads as saved.
 */
export const messageDefaultsUpdateSchema = z
  .object({
    campaign: campaignDefaultsSchema.partial().strict().optional(),
    offer: offerDefaultsFields.partial().strict().optional(),
  })
  .strict();

export type MessageDefaultsUpdate = z.infer<typeof messageDefaultsUpdateSchema>;

/**
 * The defaults with an update applied field by field. Check the result with
 * messageDefaultsSchema: the rules across fields (one delay per message)
 * apply to the merged object.
 */
export function mergeMessageDefaults(
  base: MessageDefaults,
  update: MessageDefaultsUpdate
): MessageDefaults {
  return {
    version: MESSAGE_DEFAULTS_VERSION,
    campaign: { ...base.campaign, ...update.campaign },
    offer: { ...base.offer, ...update.offer },
  };
}

/** Stored or received defaults, or null when they are missing or invalid. */
export function parseMessageDefaults(value: unknown): MessageDefaults | null {
  const parsed = messageDefaultsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The base for a workspace's first saved defaults in a language without a
 * built-in set: no texts, nothing switched on. The one exception is the
 * question-mark filter, which new campaigns get anyway (the campaign API
 * defaults it to on), so saving an offer's texts first never changes how new
 * campaigns treat questions. The tag templates keep tags apart per offer.
 */
export const EMPTY_MESSAGE_DEFAULTS: MessageDefaults = {
  version: MESSAGE_DEFAULTS_VERSION,
  campaign: {
    openingDmEnabled: false,
    openingDmMessage: "",
    openingDmButtonLabel: "",
    requireFollow: false,
    followPromptMessage: "",
    followPromptButtonLabel: "",
    followPromptRetryMessage: "",
    followPromptRetryButtonLabel: "",
    dmMessage: "",
    linkButtonLabel: "",
    publicReplyEnabled: false,
    publicReplyMessages: [],
    ignoreQuestionComments: true,
    offersEnabled: false,
  },
  offer: {
    offerMessages: [],
    offerDelaysSeconds: [],
    offerButtonLabel: "",
    confirmationMessages: [],
    confirmationDelaysSeconds: [],
    cardButtonLabel: "",
    reminderEnabled: false,
    reminderDelayHours: REMINDER_DELAY_MAX_HOURS,
    reminderMessage: "",
    tagTemplates: {
      offered: "{name} offered",
      interested: "{name} interested",
      sent: "{name} sent",
      clicked: "{name} clicked",
    },
  },
};

/**
 * The built-in sets, by interface language. German follows the user's
 * ManyChat templates (spec, "German default texts"), with the informal "du".
 * The spec's second offer text named the user's own niche; here it is
 * neutral, as is everything else.
 */
export const BUILT_IN_MESSAGE_DEFAULTS: Partial<
  Record<Locale, MessageDefaults>
> = {
  de: {
    version: MESSAGE_DEFAULTS_VERSION,
    campaign: {
      openingDmEnabled: true,
      openingDmMessage:
        "Hey, ich hab gesehen, dass du mein Reel kommentiert hast 😊 Möchtest du die Unterlage haben? Dann tipp einfach auf den Button.",
      openingDmButtonLabel: "Ja, schick sie mir",
      requireFollow: true,
      followPromptMessage:
        "Bitte folge mir zuerst, dann bekommst du sie :)\n\nMach das kurz und tipp dann auf „Erledigt“.",
      followPromptButtonLabel: "Erledigt 👍",
      followPromptRetryMessage:
        "Ich sehe dein Folgen noch nicht. Manchmal braucht Instagram einen Moment. Folge mir kurz und tipp dann noch einmal auf „Erledigt“.",
      followPromptRetryButtonLabel: "Erledigt 👍",
      dmMessage: "Hier geht's direkt zu deiner Unterlage 👇",
      linkButtonLabel: "Jetzt öffnen",
      publicReplyEnabled: true,
      publicReplyMessages: [
        "Ich hab dir eine Nachricht geschickt 😄",
        "Hab dir den Link per DM geschickt 🤓",
        "Check deine DMs 👍",
        "Erledigt! Schau mal in dein Postfach 😄",
        "Schau mal in dein Instagram-Postfach 🤓",
      ],
      ignoreQuestionComments: true,
      offersEnabled: true,
    },
    offer: {
      offerMessages: [
        "Ich hab übrigens noch einen ausführlichen Guide geschrieben.",
        "Er hilft dir, noch mehr aus dem Thema herauszuholen.",
        "Soll ich ihn dir schicken? Da du mir folgst, ist er für dich kostenlos :)",
      ],
      offerDelaysSeconds: [5, 3, 2],
      offerButtonLabel: "Ja, gerne! 🙌",
      confirmationMessages: ["Alles klar!", "Hier geht's zum Guide 👇"],
      confirmationDelaysSeconds: [3, 3],
      cardButtonLabel: "Jetzt holen",
      reminderEnabled: true,
      reminderDelayHours: 23,
      reminderMessage:
        "Hey, nur kurz zur Info: Der Guide ist nicht ewig kostenlos, aber du kannst ihn dir hier noch holen 👇",
      tagTemplates: {
        offered: "{name} angeboten",
        interested: "{name} Interesse",
        sent: "[LM] {name} gesendet",
        clicked: "{name} geklickt",
      },
    },
  },
};

/**
 * The built-in set for an interface language, as a copy the caller may
 * change, or null when the language has none.
 */
export function builtInMessageDefaults(locale: Locale): MessageDefaults | null {
  const defaults = BUILT_IN_MESSAGE_DEFAULTS[locale];
  return defaults ? structuredClone(defaults) : null;
}

/**
 * A tag name for an offer from one of the tag templates: {name} becomes the
 * offer's name. Trimmed and cut to the 100 characters a tag may have,
 * counted like the API counts them (code points, so no emoji is split).
 */
export function renderTagTemplate(template: string, offerName: string): string {
  // A function, so "$&" and the like in a name stay as typed.
  const name = offerName.trim();
  const rendered = template.replace(/\{name\}/g, () => name).trim();
  return Array.from(rendered).slice(0, TAG_MAX).join("").trim();
}

// The campaign fields a CSV import row can set.
type ImportRowFields = Pick<
  CampaignDefaults,
  | "dmMessage"
  | "publicReplyEnabled"
  | "publicReplyMessages"
  | "openingDmEnabled"
  | "openingDmMessage"
  | "openingDmButtonLabel"
>;

// Without defaults, a row sets these fields alone, as the import always did:
// a cell it leaves empty switches its message off.
const ROW_FIELDS_WITHOUT_DEFAULTS: ImportRowFields = {
  dmMessage: "",
  publicReplyEnabled: false,
  publicReplyMessages: [],
  openingDmEnabled: false,
  openingDmMessage: "",
  openingDmButtonLabel: "",
};

/**
 * The texts and switches of a campaign made from a CSV import row: the cells
 * the row fills override the workspace's defaults, the rest keep them.
 * Without defaults the row's own fields start empty and switched off.
 */
export function withImportRow(
  defaults: CampaignDefaults | null,
  row: Partial<ImportRow>
): Partial<CampaignDefaults> {
  const fields: Partial<CampaignDefaults> = {
    ...(defaults ?? ROW_FIELDS_WITHOUT_DEFAULTS),
  };
  const dmMessage = row.dmMessage?.trim();
  if (dmMessage) fields.dmMessage = dmMessage;
  const publicReply = row.publicReply?.trim();
  if (publicReply) {
    fields.publicReplyEnabled = true;
    fields.publicReplyMessages = [publicReply];
  }
  const openingDm = row.openingDmMessage?.trim();
  const openingLabel = row.openingDmButtonLabel?.trim();
  if (openingDm) {
    fields.openingDmEnabled = true;
    fields.openingDmMessage = openingDm;
    // An opening DM needs a button; the import's own label when neither the
    // row nor the defaults have one.
    fields.openingDmButtonLabel =
      openingLabel || fields.openingDmButtonLabel || "Send link";
  } else if (openingLabel) {
    fields.openingDmButtonLabel = openingLabel;
  }
  return fields;
}
