import type { z } from "zod";
import { prisma } from "@/lib/db/client";
import { campaignDefaultsFor, createCampaign } from "@/lib/campaigns/create";
import { createAutomationSchema } from "@/lib/campaigns/schema";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { ApiError } from "./http";
import { requireScope, type ServiceContext } from "./auth";

// offerDelayHours: when the offer starts after the link (0 right away, 22
// later), so a list shows which campaigns start their offers late.
const summarySelect = {
  id: true, name: true, goal: true, instagramAccountId: true, isActive: true,
  postId: true, postUrl: true, pendingNextReel: true, matchAnyPost: true,
  keywords: true, matchAnyWord: true, dmMessage: true, offerDelayHours: true,
  createdAt: true, updatedAt: true,
} as const;

export async function listCampaigns(context: ServiceContext) {
  requireScope(context, "campaigns:read");
  return prisma.automation.findMany({
    where: { workspaceId: context.workspaceId }, select: summarySelect,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 100,
  });
}

// The explicit detail projection: no provider tokens, report secrets,
// recipient data or account relations.
async function readCampaign(workspaceId: string, id: string) {
  const campaign = await prisma.automation.findFirst({
    where: { id, workspaceId },
    select: {
      ...summarySelect, wholeWordMatch: true, dmTriggerEnabled: true,
      openingDmEnabled: true, openingDmMessage: true, openingDmButtonLabel: true,
      linkButtonLabel: true, requireFollow: true, followPromptMessage: true,
      followPromptButtonLabel: true, followUpEnabled: true, followUpMessage: true,
      followUpDelayMinutes: true, publicReplyEnabled: true, publicReplyMessage: true,
      publicReplyMessages: true, ignoreQuestionComments: true,
      followPromptRetryMessage: true, followPromptRetryButtonLabel: true,
      deliveryTag: true, offersEnabled: true, offerIds: true,
      trackedLinks: {
        where: { workspaceId }, orderBy: TRACKED_LINK_ORDER,
        select: { destinationUrl: true, label: true, position: true },
      },
    },
  });
  if (!campaign) throw new ApiError("Campaign not found", 404);
  const [primary, secondary] = campaign.trackedLinks;
  return {
    ...campaign, trackedDestinationUrl: primary?.destinationUrl ?? null,
    secondaryDestinationUrl: secondary?.destinationUrl ?? null,
    secondaryButtonLabel: secondary?.label ?? null,
  };
}

export async function getCampaign(context: ServiceContext, id: string) {
  requireScope(context, "campaigns:read");
  return readCampaign(context.workspaceId, id);
}

export async function getCampaignStats(context: ServiceContext, id: string) {
  await getCampaign(context, id);
  const [statuses, rawClicks] = await Promise.all([
    prisma.dmLog.groupBy({ by: ["status"], where: { workspaceId: context.workspaceId, automationId: id }, _count: { _all: true } }),
    prisma.linkClick.count({ where: { workspaceId: context.workspaceId, automationId: id } }),
  ]);
  return { campaignId: id, statuses, rawClicks, note: "Raw link requests include previews and repeated clicks; not unique recipients." };
}

/**
 * The body of POST /api/v1/campaigns and of the MCP tool create_campaign:
 * the dashboard's create fields (lib/campaigns/schema.ts), strictly, so a
 * misspelt field is refused instead of quietly left to a default.
 */
export const serviceCreateCampaignSchema = createAutomationSchema.strict();

// At most this many problems are named, so a body full of unknown keys
// cannot make the answer as long as itself.
const ISSUES_SHOWN = 10;
const MESSAGE_MAX = 1000;

// One line per problem, "field: message", for REST and MCP clients alike:
// an MCP client sees nothing of an error but its text.
function describeIssues(error: z.ZodError) {
  const text = error.issues.slice(0, ISSUES_SHOWN)
    .map(issue => issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)
    .join("; ");
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}…` : text;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The editor adds {link} to the DM text once the link is typed in. The
// worker puts the tracked link there when Instagram refuses the button
// template and the text goes out alone; without the token that text would
// carry no link. Any other value is left for the schema to judge.
function withLinkToken(fields: Record<string, unknown>) {
  const { dmMessage, trackedDestinationUrl } = fields;
  if (typeof dmMessage !== "string" || !dmMessage.trim() || /\{link\}/i.test(dmMessage)) return fields;
  if (typeof trackedDestinationUrl !== "string" || !trackedDestinationUrl) return fields;
  return { ...fields, dmMessage: `${dmMessage.trim()} {link}` };
}

/**
 * Creates a campaign for a key with campaigns:write (R14). Every field the
 * body leaves out takes the workspace's default texts and switches, as a new
 * campaign does in the editor (campaignDefaultsFor), and the campaign starts
 * paused unless the body sends isActive. Answers with the created campaign
 * in get_campaign's shape, for this key even without campaigns:read: a
 * client that got an error after its campaign was stored would create it
 * again.
 */
export async function createServiceCampaign(context: ServiceContext, body: unknown) {
  requireScope(context, "campaigns:write");
  if (!isObject(body)) throw new ApiError("Send the campaign as a JSON object");
  const parsed = serviceCreateCampaignSchema.safeParse(withLinkToken({
    ...(await campaignDefaultsFor(context.workspaceId)),
    isActive: false,
    ...body,
  }));
  if (!parsed.success) throw new ApiError(`Invalid campaign: ${describeIssues(parsed.error)}`);
  const result = await createCampaign(context.workspaceId, parsed.data);
  if (!result.ok) throw new ApiError(result.error, result.status);
  return readCampaign(context.workspaceId, result.campaign.id);
}
