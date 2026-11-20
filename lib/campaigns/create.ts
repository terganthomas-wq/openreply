/**
 * Writing a new campaign from a validated create body (lib/campaigns/schema.ts).
 *
 * The dashboard's create route and the import both store campaigns through
 * this, so a campaign holds the same fields, normalised the same way, however
 * it was made. The import used to map its rows by hand and fell behind: the
 * fields added later were neither checked nor given their defaults there.
 */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { buildInitialCampaignLinks } from "@/lib/campaigns/links";
import type { CreateAutomationInput } from "@/lib/campaigns/schema";
import { generateReportShareSlug } from "@/lib/reports/share";

// A repeated id adds nothing (an offer is never made twice to the same
// person), so only its first place counts.
export function uniqueOfferIds(offerIds: string[]): string[] {
  return [...new Set(offerIds)];
}

// A campaign's custom offer order holds plain ids (no foreign key), so every
// id must name an offer of this workspace that is still on the Offers page.
// Archived offers are kept for their history but must not be offered again.
export async function offersExist(workspaceId: string, offerIds: string[]) {
  if (offerIds.length === 0) return true;
  const count = await prisma.offer.count({
    where: { workspaceId, id: { in: offerIds }, archivedAt: null },
  });
  return count === offerIds.length;
}

/**
 * The row for prisma.automation.create. Offer ids must have passed
 * offersExist; the account must belong to the workspace.
 */
export function newCampaignData(
  data: CreateAutomationInput,
  {
    workspaceId,
    instagramAccountId,
  }: { workspaceId: string; instagramAccountId: string }
): Prisma.AutomationUncheckedCreateInput {
  const linkCreates = buildInitialCampaignLinks({
    workspaceId,
    primaryUrl: data.trackedDestinationUrl,
    secondaryUrl: data.secondaryDestinationUrl,
    secondaryLabel: data.secondaryButtonLabel,
  });

  const { pendingNextReel, matchAnyPost, matchAnyWord, openingDmEnabled } =
    data;
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost;
  const publicReplyList = (
    data.publicReplyMessages.length > 0
      ? data.publicReplyMessages
      : data.publicReplyMessage
        ? [data.publicReplyMessage]
        : []
  )
    .map((m) => m.trim())
    .filter(Boolean);

  return {
    name: data.name,
    goal: data.goal,
    // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
    postId: isSpecificPost ? data.postId : null,
    postUrl: isSpecificPost ? data.postUrl : null,
    pendingNextReel,
    matchAnyPost,
    keywords: matchAnyWord ? [] : data.keywords,
    matchAnyWord,
    dmTriggerEnabled: data.dmTriggerEnabled,
    dmMessage: data.dmMessage,
    openingDmEnabled,
    openingDmMessage: openingDmEnabled ? data.openingDmMessage || null : null,
    openingDmButtonLabel: openingDmEnabled
      ? data.openingDmButtonLabel || null
      : null,
    linkButtonLabel: data.linkButtonLabel || null,
    requireFollow: data.requireFollow,
    followPromptMessage: data.requireFollow
      ? data.followPromptMessage || null
      : null,
    followPromptButtonLabel: data.requireFollow
      ? data.followPromptButtonLabel || null
      : null,
    followPromptRetryMessage: data.requireFollow
      ? data.followPromptRetryMessage || null
      : null,
    followPromptRetryButtonLabel: data.requireFollow
      ? data.followPromptRetryButtonLabel || null
      : null,
    followUpEnabled: data.followUpEnabled,
    followUpMessage: data.followUpEnabled ? data.followUpMessage || null : null,
    followUpDelayMinutes: data.followUpEnabled ? data.followUpDelayMinutes : 0,
    publicReplyEnabled: data.publicReplyEnabled,
    publicReplyMessages: data.publicReplyEnabled ? publicReplyList : [],
    publicReplyMessage: data.publicReplyEnabled
      ? publicReplyList[0] ?? data.publicReplyMessage ?? null
      : null,
    isActive: data.isActive,
    wholeWordMatch: data.wholeWordMatch,
    ignoreQuestionComments: data.ignoreQuestionComments,
    // Trimmed by the schema; nothing left means no tag.
    deliveryTag: data.deliveryTag || null,
    offersEnabled: data.offersEnabled,
    offerIds: uniqueOfferIds(data.offerIds),
    workspaceId,
    instagramAccountId,
    reportShareSlug: generateReportShareSlug(),
    ...(linkCreates.length > 0
      ? { trackedLinks: { create: linkCreates } }
      : {}),
  };
}
