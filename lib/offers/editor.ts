/**
 * The offer editor's form and the steps between it and the Offers API (R3,
 * R13): the body the editor saves, the tag names a new offer takes from the
 * workspace's tag templates, a funnel stage's share of everyone offered,
 * moving an entry up or down, cleaning up a campaign's own offer order and
 * what went wrong with a card image upload.
 *
 * Kept apart from the pages so it can be unit-tested
 * (__tests__/offers-editor.test.ts). Client-safe: no database, queue or
 * fetch.
 */

import {
  EMPTY_MESSAGE_DEFAULTS,
  renderTagTemplate,
  type MessageDefaultsUpdate,
  type OfferDefaults,
} from "@/lib/campaigns/message-defaults";
import {
  OFFER_DELAY_MAX_SECONDS,
  OFFER_IMAGE_MAX_BYTES,
  OFFER_IMAGE_TYPES,
  REMINDER_DELAY_MAX_HOURS,
} from "@/lib/offers/schema";

/** One message of a list and the pause before it, in seconds. */
export interface TimedMessage {
  text: string;
  delaySeconds: number;
}

/** The four funnel tags of an offer (R2), by stage. */
export const TAG_KEYS = ["offered", "interested", "sent", "clicked"] as const;
export type TagKey = (typeof TAG_KEYS)[number];
export type OfferTags = Record<TagKey, string>;
export type TagTemplates = OfferDefaults["tagTemplates"];

/** What the offer editor's fields hold, as typed. */
export interface OfferEditorState {
  name: string;
  offerMessages: TimedMessage[];
  offerButtonLabel: string;
  confirmationMessages: TimedMessage[];
  cardImageUrl: string;
  cardTitle: string;
  cardSubtitle: string;
  cardButtonLabel: string;
  destinationUrl: string;
  reminderEnabled: boolean;
  reminderDelayHours: number;
  reminderMessage: string;
  tags: OfferTags;
}

/** How far people got with an offer, as GET /api/offers counts it. */
export interface OfferFunnel {
  offered: number;
  interested: number;
  sent: number;
  clicked: number;
  stopped: number;
}

/** An offer as GET /api/offers returns it. */
export interface OfferRecord {
  id: string;
  name: string;
  isActive: boolean;
  position: number;
  archivedAt: string | null;
  offerMessages: string[];
  offerDelaysSeconds: number[];
  offerButtonLabel: string;
  confirmationMessages: string[];
  confirmationDelaysSeconds: number[];
  cardImageUrl: string | null;
  cardTitle: string;
  cardSubtitle: string | null;
  cardButtonLabel: string;
  destinationUrl: string;
  reminderEnabled: boolean;
  reminderDelayHours: number;
  reminderMessage: string | null;
  tagOffered: string;
  tagInterested: string;
  tagSent: string;
  tagClicked: string;
  /** The public /o/<slug> link behind the card's and the reminder's button. */
  trackedUrl: string;
  funnel: OfferFunnel;
}

/**
 * The body of POST /api/offers and PATCH /api/offers?id=: the whole offer.
 * Every field is sent, because one the body leaves out gets its default on
 * an edit too (lib/offers/schema.ts). isActive never is: the Offers page's
 * pause switch owns it, so an edit keeps the offer paused or active.
 */
export interface OfferPayload {
  name: string;
  offerMessages: string[];
  offerDelaysSeconds: number[];
  offerButtonLabel: string;
  confirmationMessages: string[];
  confirmationDelaysSeconds: number[];
  cardImageUrl: string | null;
  cardTitle: string;
  cardSubtitle: string | null;
  cardButtonLabel: string;
  destinationUrl: string;
  reminderEnabled: boolean;
  reminderDelayHours: number;
  reminderMessage: string | null;
  tagOffered: string;
  tagInterested: string;
  tagSent: string;
  tagClicked: string;
}

export type OfferField = keyof OfferPayload;

/** The payload field that holds each funnel tag. */
export const TAG_FIELD: Record<TagKey, OfferField> = {
  offered: "tagOffered",
  interested: "tagInterested",
  sent: "tagSent",
  clicked: "tagClicked",
};

/** The form's fields in the order they appear, to show the first error. */
export const OFFER_FORM_FIELDS: readonly OfferField[] = [
  "name",
  "offerMessages",
  "offerDelaysSeconds",
  "offerButtonLabel",
  "confirmationMessages",
  "confirmationDelaysSeconds",
  "cardImageUrl",
  "cardTitle",
  "cardSubtitle",
  "cardButtonLabel",
  "destinationUrl",
  "reminderEnabled",
  "reminderDelayHours",
  "reminderMessage",
  "tagOffered",
  "tagInterested",
  "tagSent",
  "tagClicked",
];

/** A pause the API takes: whole seconds from 0 to 60. */
export function clampDelaySeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(OFFER_DELAY_MAX_SECONDS, Math.max(0, Math.floor(value)));
}

/** A reminder delay the API takes: whole hours from 1 to 23. */
export function clampReminderHours(value: number): number {
  if (!Number.isFinite(value)) return REMINDER_DELAY_MAX_HOURS;
  return Math.min(REMINDER_DELAY_MAX_HOURS, Math.max(1, Math.floor(value)));
}

// Stored texts with their pauses; a missing pause reads as none.
function timedMessages(
  texts: readonly string[],
  delays: readonly number[]
): TimedMessage[] {
  return texts.map((text, i) => ({
    text,
    delaySeconds: clampDelaySeconds(delays[i] ?? 0),
  }));
}

// The form always shows at least one offer message to write.
function withOneRow(messages: TimedMessage[]): TimedMessage[] {
  return messages.length > 0 ? messages : [{ text: "", delaySeconds: 0 }];
}

/**
 * The messages of a list that go out: trimmed, blank rows left out together
 * with their pauses, pauses within what the API takes. The preview shows the
 * same list, so the button sits on the message that really carries it.
 */
export function sentMessages(
  messages: readonly TimedMessage[]
): TimedMessage[] {
  return messages
    .map((message) => ({
      text: message.text.trim(),
      delaySeconds: clampDelaySeconds(message.delaySeconds),
    }))
    .filter((message) => message.text.length > 0);
}

// One tag from its template. A name not typed yet would leave two spaces
// where it goes ("[LM]  gesendet"); runs of spaces become one.
function renderTag(template: string, name: string): string {
  return renderTagTemplate(template, name).replace(/ {2,}/g, " ");
}

/** The four tag names of an offer called `name`, from the tag templates. */
export function tagNamesFromTemplates(
  templates: TagTemplates,
  name: string
): OfferTags {
  return {
    offered: renderTag(templates.offered, name),
    interested: renderTag(templates.interested, name),
    sent: renderTag(templates.sent, name),
    clicked: renderTag(templates.clicked, name),
  };
}

/**
 * The tags after the offer's name changed: those still following their
 * template take the new name, those the user typed stay as typed.
 */
export function followTagTemplates(
  tags: OfferTags,
  following: readonly TagKey[],
  templates: TagTemplates,
  name: string
): OfferTags {
  const next = { ...tags };
  for (const key of following) {
    next[key] = renderTag(templates[key], name);
  }
  return next;
}

/**
 * A new offer's form: the workspace's default texts for offers, or empty
 * ones, with the tags rendered from the templates. The name, the card and
 * the link are each offer's own and start empty.
 */
export function newOfferEditorState(
  defaults: OfferDefaults | null
): OfferEditorState {
  const base = defaults ?? EMPTY_MESSAGE_DEFAULTS.offer;
  return {
    name: "",
    offerMessages: withOneRow(
      timedMessages(base.offerMessages, base.offerDelaysSeconds)
    ),
    offerButtonLabel: base.offerButtonLabel,
    confirmationMessages: timedMessages(
      base.confirmationMessages,
      base.confirmationDelaysSeconds
    ),
    cardImageUrl: "",
    cardTitle: "",
    cardSubtitle: "",
    cardButtonLabel: base.cardButtonLabel,
    destinationUrl: "",
    reminderEnabled: base.reminderEnabled,
    reminderDelayHours: clampReminderHours(base.reminderDelayHours),
    reminderMessage: base.reminderMessage,
    tags: tagNamesFromTemplates(base.tagTemplates, ""),
  };
}

/** The form for editing a stored offer. */
export function editorStateFromOffer(offer: OfferRecord): OfferEditorState {
  return {
    name: offer.name,
    offerMessages: withOneRow(
      timedMessages(offer.offerMessages, offer.offerDelaysSeconds)
    ),
    offerButtonLabel: offer.offerButtonLabel,
    confirmationMessages: timedMessages(
      offer.confirmationMessages,
      offer.confirmationDelaysSeconds
    ),
    cardImageUrl: offer.cardImageUrl ?? "",
    cardTitle: offer.cardTitle,
    cardSubtitle: offer.cardSubtitle ?? "",
    cardButtonLabel: offer.cardButtonLabel,
    destinationUrl: offer.destinationUrl,
    reminderEnabled: offer.reminderEnabled,
    reminderDelayHours: clampReminderHours(offer.reminderDelayHours),
    reminderMessage: offer.reminderMessage ?? "",
    tags: {
      offered: offer.tagOffered,
      interested: offer.tagInterested,
      sent: offer.tagSent,
      clicked: offer.tagClicked,
    },
  };
}

/**
 * The body the editor saves. Empty optional texts go as null ("none"); the
 * reminder's text is kept while the reminder is off, so switching it back on
 * brings it back.
 */
export function offerPayload(state: OfferEditorState): OfferPayload {
  const offerMessages = sentMessages(state.offerMessages);
  const confirmations = sentMessages(state.confirmationMessages);
  return {
    name: state.name.trim(),
    offerMessages: offerMessages.map((message) => message.text),
    offerDelaysSeconds: offerMessages.map((message) => message.delaySeconds),
    offerButtonLabel: state.offerButtonLabel.trim(),
    confirmationMessages: confirmations.map((message) => message.text),
    confirmationDelaysSeconds: confirmations.map(
      (message) => message.delaySeconds
    ),
    cardImageUrl: state.cardImageUrl.trim() || null,
    cardTitle: state.cardTitle.trim(),
    cardSubtitle: state.cardSubtitle.trim() || null,
    cardButtonLabel: state.cardButtonLabel.trim(),
    destinationUrl: state.destinationUrl.trim(),
    reminderEnabled: state.reminderEnabled,
    reminderDelayHours: clampReminderHours(state.reminderDelayHours),
    reminderMessage: state.reminderMessage.trim() || null,
    tagOffered: state.tags.offered.trim(),
    tagInterested: state.tags.interested.trim(),
    tagSent: state.tags.sent.trim(),
    tagClicked: state.tags.clicked.trim(),
  };
}

/**
 * The PUT /api/workspace/message-defaults body behind "Save these texts as
 * defaults for new offers": the texts and switches offers share. The name,
 * the card, the link and the tag names are each offer's own, and the tag
 * templates keep their saved value.
 */
export function offerDefaultsUpdate(
  state: OfferEditorState
): MessageDefaultsUpdate {
  const offerMessages = sentMessages(state.offerMessages);
  const confirmations = sentMessages(state.confirmationMessages);
  return {
    offer: {
      offerMessages: offerMessages.map((message) => message.text),
      offerDelaysSeconds: offerMessages.map((message) => message.delaySeconds),
      offerButtonLabel: state.offerButtonLabel.trim(),
      confirmationMessages: confirmations.map((message) => message.text),
      confirmationDelaysSeconds: confirmations.map(
        (message) => message.delaySeconds
      ),
      cardButtonLabel: state.cardButtonLabel.trim(),
      reminderEnabled: state.reminderEnabled,
      reminderDelayHours: clampReminderHours(state.reminderDelayHours),
      reminderMessage: state.reminderMessage.trim(),
    },
  };
}

/**
 * The first required field the form leaves empty, or null. The API refuses
 * each of these too; checking first lets the editor say so in the interface
 * language.
 */
export function firstMissingField(state: OfferEditorState): OfferField | null {
  if (!state.name.trim()) return "name";
  if (sentMessages(state.offerMessages).length === 0) return "offerMessages";
  if (!state.offerButtonLabel.trim()) return "offerButtonLabel";
  if (!state.cardTitle.trim()) return "cardTitle";
  if (!state.cardButtonLabel.trim()) return "cardButtonLabel";
  if (!state.destinationUrl.trim()) return "destinationUrl";
  if (state.reminderEnabled && !state.reminderMessage.trim()) {
    return "reminderMessage";
  }
  const missingTag = TAG_KEYS.find((key) => !state.tags[key].trim());
  return missingTag ? TAG_FIELD[missingTag] : null;
}

/**
 * The first message per field of an API error's details, zod's flatten()
 * shape ({ fieldErrors: { field: [message, …] } }), for the offer's fields.
 */
export function fieldErrorsFromDetails(
  details: unknown
): Partial<Record<OfferField, string>> {
  const errors: Partial<Record<OfferField, string>> = {};
  const fieldErrors =
    details && typeof details === "object"
      ? (details as { fieldErrors?: unknown }).fieldErrors
      : undefined;
  if (!fieldErrors || typeof fieldErrors !== "object") return errors;
  for (const field of OFFER_FORM_FIELDS) {
    const messages = (fieldErrors as Record<string, unknown>)[field];
    if (Array.isArray(messages) && typeof messages[0] === "string") {
      errors[field] = messages[0];
    }
  }
  return errors;
}

/** The first field with an error, in the order of the form. */
export function firstErrorField(
  errors: Partial<Record<OfferField, string>>
): OfferField | null {
  return OFFER_FORM_FIELDS.find((field) => errors[field] !== undefined) ?? null;
}

/**
 * A funnel stage's share of everyone offered, in whole percent; 0 while
 * nobody was offered. Every stage counts against "offered", not against the
 * stage before: the reminder counts as sent without any interest.
 */
export function percentOfOffered(count: number, offered: number): number {
  if (!(offered > 0) || !(count > 0)) return 0;
  return Math.round((count / offered) * 100);
}

/**
 * A copy of the list with one entry moved one place up (-1) or down (1). A
 * move past either end, or of an index outside the list, changes nothing.
 */
export function moveItem<T>(
  list: readonly T[],
  index: number,
  direction: -1 | 1
): T[] {
  const next = [...list];
  const target = index + direction;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= next.length ||
    target < 0 ||
    target >= next.length
  ) {
    return next;
  }
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * Why a card image could not be uploaded: not a JPEG, PNG or WebP file, too
 * large, no right to change offers, no Blob store set up (the editor then
 * shows the image-URL field), or anything else.
 */
export type ImageUploadProblem =
  | "type"
  | "size"
  | "forbidden"
  | "notSetUp"
  | "failed";

/**
 * What is wrong with a picked file before it is sent, or null. The browser
 * names a type for most files; one it cannot name goes to the server, which
 * tells the type from the content anyway. An empty file is no image.
 */
export function imageFileProblem(file: {
  type: string;
  size: number;
}): ImageUploadProblem | null {
  if (
    file.size === 0 ||
    (file.type !== "" &&
      !(OFFER_IMAGE_TYPES as readonly string[]).includes(file.type))
  ) {
    return "type";
  }
  if (file.size > OFFER_IMAGE_MAX_BYTES) return "size";
  return null;
}

/**
 * Why POST /api/offers/image failed, from the status alone: on Vercel a body
 * over 4.5 MB is refused by the platform with a 413 that has no JSON.
 */
export function imageUploadProblem(status: number): ImageUploadProblem {
  switch (status) {
    case 413:
      return "size";
    case 415:
      return "type";
    case 403:
      return "forbidden";
    case 503:
      return "notSetUp";
    default:
      return "failed";
  }
}

/**
 * A campaign's own offer order without the ids it can no longer use: ids of
 * offers that are gone (deleted, or never this workspace's), archived ones
 * and repeats. Paused offers stay; the worker skips them while they are
 * paused. `offers` is what GET /api/offers returns.
 */
export function cleanCustomOrder(
  ids: readonly string[],
  offers: readonly { id: string; archivedAt?: string | null }[]
): string[] {
  const usable = new Set(
    offers.filter((offer) => !offer.archivedAt).map((offer) => offer.id)
  );
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of ids) {
    if (!usable.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  return kept;
}
