/**
 * Campaign input validation, shared by the dashboard API and anything else
 * that creates or edits campaigns. No database import, so it stays usable
 * from client code.
 */

import { z } from "zod";
import {
  BUTTON_LABEL_MAX,
  BUTTON_TEXT_MAX,
  utf16Max,
} from "@/lib/validation/text";

export const OFFER_RULE_MESSAGE =
  "Offers need the opening DM: Instagram only allows them after the person taps a button";

/**
 * R11: Instagram allows messages beyond the comment's private reply only for
 * 24 hours after the person taps a button or sends a DM. A lead-magnet offer
 * follows the link, so a campaign with offers needs the opening DM, whose tap
 * opens that window. Takes a parsed body or a stored row merged with a
 * partial update.
 */
export function offerRuleViolated(campaign: {
  offersEnabled?: boolean | null;
  openingDmEnabled?: boolean | null;
  openingDmMessage?: string | null;
  openingDmButtonLabel?: string | null;
}): boolean {
  if (!campaign.offersEnabled) return false;
  return !(
    campaign.openingDmEnabled &&
    Boolean(campaign.openingDmMessage?.trim()) &&
    Boolean(campaign.openingDmButtonLabel?.trim())
  );
}

// Offer ids are cuids; the caps only bound the request.
const offerIdList = z.array(z.string().min(1).max(40)).max(20);

export const createAutomationSchema = z
  .object({
    name: z.string().min(1).max(100),
    goal: z.string().min(1).max(120).optional().nullable(),
    instagramAccountId: z.string().min(1).optional().nullable(),
    postId: z.string().min(1).optional().nullable(),
    postUrl: z.string().url().optional().nullable(),
    pendingNextReel: z.boolean().optional().default(false),
    matchAnyPost: z.boolean().optional().default(false),
    keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
    matchAnyWord: z.boolean().optional().default(false),
    dmTriggerEnabled: z.boolean().optional().default(false),
    dmMessage: z.string().min(1).max(1000),
    openingDmEnabled: z.boolean().optional().default(false),
    openingDmMessage: z.string().max(1000).optional().nullable(),
    openingDmButtonLabel: utf16Max(BUTTON_LABEL_MAX).optional().nullable(),
    linkButtonLabel: utf16Max(BUTTON_LABEL_MAX).optional().nullable(),
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: z.string().max(1000).optional().nullable(),
    followPromptButtonLabel: utf16Max(BUTTON_LABEL_MAX).optional().nullable(),
    followUpEnabled: z.boolean().optional().default(false),
    followUpMessage: z.string().max(1000).optional().nullable(),
    // Minutes to wait before the follow-up. Capped at 24h so it stays inside
    // Instagram's messaging window.
    followUpDelayMinutes: z.number().int().min(0).max(1440).optional().default(0),
    publicReplyEnabled: z.boolean().optional().default(false),
    publicReplyMessage: z.string().max(1000).optional().nullable(),
    publicReplyMessages: z
      .array(z.string().max(1000))
      .max(10)
      .optional()
      .default([]),
    // Empty string means "no tracked link"; a URL sets one.
    trackedDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    // Optional second tracked link, rendered as a second DM button.
    secondaryDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    secondaryButtonLabel: utf16Max(BUTTON_LABEL_MAX).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    wholeWordMatch: z.boolean().optional().default(true),
    // New campaigns leave questions alone, like the ManyChat template
    // ("Was ist ein Prompt?" is not a request). The column defaults to false
    // so campaigns created before the option behave as they did.
    ignoreQuestionComments: z.boolean().optional().default(true),
    // The second follow request. Null or empty repeats the first one. It is
    // the text of a button message, which Instagram cuts after 640 units.
    followPromptRetryMessage: utf16Max(BUTTON_TEXT_MAX).optional().nullable(),
    followPromptRetryButtonLabel: utf16Max(BUTTON_LABEL_MAX).optional().nullable(),
    // Tag for the contact once the link is delivered. Empty means none.
    deliveryTag: z.string().trim().max(100).optional().nullable(),
    offersEnabled: z.boolean().optional().default(false),
    // Custom offer order; empty uses the workspace default order.
    offerIds: offerIdList.optional().default([]),
  })
  // A campaign must target a specific post, any post, or the next reel.
  .refine(
    (d) => d.matchAnyPost || d.pendingNextReel || Boolean(d.postId),
    { message: "Choose which post(s) trigger the campaign", path: ["postId"] }
  )
  // And it must match either specific words or any word.
  .refine((d) => d.matchAnyWord || d.keywords.length >= 1, {
    message: "Add at least one keyword, or match any word",
    path: ["keywords"],
  })
  // An opening DM needs both a message and a button label.
  .refine(
    (d) =>
      !d.openingDmEnabled ||
      (Boolean(d.openingDmMessage?.trim()) &&
        Boolean(d.openingDmButtonLabel?.trim())),
    { message: "Opening DM needs a message and a button label", path: ["openingDmMessage"] }
  )
  .refine((d) => !offerRuleViolated(d), {
    message: OFFER_RULE_MESSAGE,
    path: ["offersEnabled"],
  });

/** A create body after validation, with every default filled in. */
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;

// No defaults here: the list and detail pages PATCH only { isActive }, and a
// default would overwrite the stored value on every such toggle. Cross-field
// rules need the stored row, so the route checks them after merging.
export const updateAutomationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().min(1).max(120).optional().nullable(),
  instagramAccountId: z.string().min(1).optional(),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  pendingNextReel: z.boolean().optional(),
  matchAnyPost: z.boolean().optional(),
  keywords: z.array(z.string().min(1).max(50)).max(10).optional(),
  matchAnyWord: z.boolean().optional(),
  dmTriggerEnabled: z.boolean().optional(),
  dmMessage: z.string().min(1).max(1000).optional(),
  openingDmEnabled: z.boolean().optional(),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: utf16Max(BUTTON_LABEL_MAX).optional().nullable(),
  linkButtonLabel: utf16Max(BUTTON_LABEL_MAX).optional().nullable(),
  requireFollow: z.boolean().optional(),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: utf16Max(BUTTON_LABEL_MAX).optional().nullable(),
  followUpEnabled: z.boolean().optional(),
  followUpMessage: z.string().max(1000).optional().nullable(),
  followUpDelayMinutes: z.number().int().min(0).max(1440).optional(),
  publicReplyEnabled: z.boolean().optional(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10).optional(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  reportShareEnabled: z.boolean().optional(),
  // Empty string clears the tracked link; a URL updates/creates it; undefined
  // leaves it unchanged.
  trackedDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  // Same semantics for the optional second tracked link / DM button.
  secondaryDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  secondaryButtonLabel: utf16Max(BUTTON_LABEL_MAX).optional().nullable(),
  ignoreQuestionComments: z.boolean().optional(),
  followPromptRetryMessage: utf16Max(BUTTON_TEXT_MAX).optional().nullable(),
  followPromptRetryButtonLabel: utf16Max(BUTTON_LABEL_MAX).optional().nullable(),
  deliveryTag: z.string().trim().max(100).optional().nullable(),
  offersEnabled: z.boolean().optional(),
  offerIds: offerIdList.optional(),
});
