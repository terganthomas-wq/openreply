/**
 * Writing a new campaign from a validated create body (lib/campaigns/schema.ts).
 *
 * The dashboard's create route, the import and the service API (POST
 * /api/v1/campaigns and the MCP tool create_campaign) all store campaigns
 * through this, so a campaign holds the same fields, normalised the same way,
 * however it was made. The import used to map its rows by hand and fell
 * behind: the fields added later were neither checked nor given their
 * defaults there.
 */

import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { buildInitialCampaignLinks } from "@/lib/campaigns/links";
import {
  builtInMessageDefaults,
  parseMessageDefaults,
  type CampaignDefaults,
  type MessageDefaults,
} from "@/lib/campaigns/message-defaults";
import {
  offerRuleViolated,
  type CreateAutomationInput,
} from "@/lib/campaigns/schema";
import { resolveLocale } from "@/lib/i18n";
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
    // 0 unless the body asks for the late start (the schema's default).
    offerDelayHours: data.offerDelayHours,
    workspaceId,
    instagramAccountId,
    reportShareSlug: generateReportShareSlug(),
    ...(linkCreates.length > 0
      ? { trackedLinks: { create: linkCreates } }
      : {}),
  };
}

/** A stored campaign with its links, as the dashboard's create route returns it. */
export type CreatedCampaign = Prisma.AutomationGetPayload<{
  include: { trackedLinks: true };
}>;

/**
 * Why a campaign was not stored, with the status the routes answer. Each
 * caller puts it into its own envelope; the texts are the dashboard's.
 */
export type CreateCampaignFailure = {
  ok: false;
  status: 400 | 404;
  error: string;
};

export type CreateCampaignResult =
  | { ok: true; campaign: CreatedCampaign }
  | CreateCampaignFailure;

/**
 * Stores a campaign from a validated create body: the Instagram account it
 * names, else the workspace's most recently connected one; its custom offer
 * order checked against the workspace's offers; the row from newCampaignData.
 * The checks run together and the first failure in this order is answered:
 * no workspace, no account, an unknown offer.
 */
export async function createCampaign(
  workspaceId: string,
  data: CreateAutomationInput
): Promise<CreateCampaignResult> {
  const requestedAccountId =
    data.instagramAccountId && data.instagramAccountId !== "all"
      ? data.instagramAccountId
      : null;

  const [workspace, instagramAccount, offersKnown] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    }),
    // Only the id is needed, never the account's token.
    requestedAccountId
      ? prisma.instagramAccount.findFirst({
          where: { id: requestedAccountId, workspaceId },
          select: { id: true },
        })
      : prisma.instagramAccount.findFirst({
          where: { workspaceId },
          orderBy: { connectedAt: "desc" },
          select: { id: true },
        }),
    offersExist(workspaceId, uniqueOfferIds(data.offerIds)),
  ]);

  if (!workspace) {
    return { ok: false, status: 404, error: "Workspace not found" };
  }
  if (!instagramAccount) {
    return {
      ok: false,
      status: 400,
      error: "Connect Instagram before creating campaigns",
    };
  }
  if (!offersKnown) return { ok: false, status: 400, error: "Unknown offer" };

  const campaign = await prisma.automation.create({
    data: newCampaignData(data, {
      workspaceId,
      instagramAccountId: instagramAccount.id,
    }),
    include: { trackedLinks: true },
  });
  return { ok: true, campaign };
}

/**
 * The workspace's message defaults as the defaults route reads them
 * (app/api/workspace/message-defaults): the stored ones when this version
 * can read them; else the built-in set, written once into a column that is
 * still NULL so it never replaces defaults someone saved meanwhile; else
 * none. A service key has no interface language, so the built-in set is the
 * installation's (DEFAULT_LOCALE, else English, which has none).
 */
async function workspaceMessageDefaults(
  workspaceId: string
): Promise<MessageDefaults | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { messageDefaults: true },
  });
  if (!workspace) return null;
  const stored = parseMessageDefaults(workspace.messageDefaults);
  if (stored) return stored;

  const seed = builtInMessageDefaults(resolveLocale(process.env.DEFAULT_LOCALE));
  if (!seed) return null;
  const { count } = await prisma.workspace.updateMany({
    where: { id: workspaceId, messageDefaults: { equals: Prisma.DbNull } },
    data: { messageDefaults: seed },
  });
  if (count > 0) return seed;

  // The column was no longer NULL: what it holds now, or the built-in set
  // while it holds something unreadable (an admin's save replaces it).
  const current = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { messageDefaults: true },
  });
  return parseMessageDefaults(current?.messageDefaults) ?? seed;
}

/**
 * What a campaign created without the editor starts from (R14): the campaign
 * section of the workspace's message defaults, the texts and switches a new
 * campaign opens with in the editor. Empty when the workspace has none. As in
 * the editor, the defaults switch offers on only where that can work: while
 * the workspace has an active offer (until then the campaign has nothing to
 * offer), and only with the opening DM the defaults bring along (R11). The
 * defaults do not enforce that rule themselves, so without this a minimal
 * create would fail on defaults that switch the opening DM off. When the
 * offer starts is not among the defaults: as in the editor, a new campaign
 * starts it right after the link (offerDelayHours 0, the schema's default)
 * unless the body asks for the late start.
 */
export async function campaignDefaultsFor(
  workspaceId: string
): Promise<Partial<CampaignDefaults>> {
  const defaults = await workspaceMessageDefaults(workspaceId);
  if (!defaults) return {};
  const campaign = { ...defaults.campaign };
  if (campaign.offersEnabled) {
    if (offerRuleViolated(campaign)) {
      campaign.offersEnabled = false;
    } else {
      const activeOffer = await prisma.offer.findFirst({
        where: { workspaceId, isActive: true, archivedAt: null },
        select: { id: true },
      });
      campaign.offersEnabled = activeOffer !== null;
    }
  }
  return campaign;
}
