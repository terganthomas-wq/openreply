import { z } from "zod";
import { createServiceCampaign, getCampaign, getCampaignStats, listCampaigns, serviceCreateCampaignSchema } from "./campaigns";
import { requireScope, type ServiceContext } from "./auth";
import { ApiError } from "./http";

type JsonSchema = { [key: string]: unknown; properties?: Record<string, Record<string, unknown>> };

const idSchema = { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 100 } }, required: ["id"], additionalProperties: false };
const readTools = [
  { name: "list_campaigns", description: "List up to 100 campaigns in this workspace; use get_campaign for complete settings and destination links.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_campaign", description: "Read campaign settings and ordered destination links. Missing links are null, not invented.", inputSchema: idSchema },
  { name: "get_campaign_stats", description: "Read aggregate send outcomes and raw link requests, not recipient conversions.", inputSchema: idSchema },
];
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// Hints for the fields a client needs to get a campaign going.
const fieldHints: Record<string, string> = {
  name: "Name of the campaign in the dashboard.",
  instagramAccountId: "Connected account (instagramAccountId of a listed campaign). Default: the most recently connected account.",
  postId: "Instagram media id of the post or reel whose comments trigger the campaign. Alternatively set matchAnyPost or pendingNextReel.",
  pendingNextReel: "Bind the campaign to the next reel that is published.",
  matchAnyPost: "Answer comments on every post.",
  keywords: "Words that trigger the campaign, spelling variants included.",
  dmMessage: "Text of the DM with the link button.",
  trackedDestinationUrl: "Where the link button leads: an http:// or https:// address, e.g. a Google Drive share link. Clicks are tracked.",
  isActive: "true starts answering comments at once. Default: false, the campaign is created paused.",
  offersEnabled: "Offer the workspace's lead magnets after the link (needs the opening DM).",
  offerIds: "Custom offer order. Empty: the workspace's default order.",
};

/**
 * create_campaign takes POST /api/v1/campaigns's body, so its schema is made
 * from the same zod schema. The schema's own defaults are left out: fields
 * the call leaves out take the workspace's default texts and switches
 * instead, and isActive is false. Only the name is always needed; every
 * other field the defaults may fill.
 */
function createInputSchema(): JsonSchema {
  // A fresh object on every call, so it may be changed in place. A part
  // zod cannot express becomes an open schema rather than breaking the route.
  const schema = z.toJSONSchema(serviceCreateCampaignSchema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  // Like the read tools' schemas: no dialect, which MCP assumes anyway.
  delete schema.$schema;
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    delete property.default;
    if (fieldHints[field]) property.description = fieldHints[field];
  }
  return { ...schema, required: ["name"] };
}

const createTool = {
  name: "create_campaign",
  description: "Create a campaign in this workspace. Fields you leave out take the workspace's default texts and switches, as a new campaign in the editor does; the campaign starts paused unless isActive is true. Choose the trigger with postId, matchAnyPost or pendingNextReel and the words with keywords; trackedDestinationUrl is the link the DM sends. Returns the campaign as get_campaign does. Each call creates another campaign.",
  inputSchema: createInputSchema(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

/** The tools this key may call: reading with campaigns:read, creating with campaigns:write. */
export function listTools(context: ServiceContext) {
  return [
    ...(context.scopes.includes("campaigns:read") ? readTools.map(tool => ({ ...tool, annotations: readAnnotations })) : []),
    ...(context.scopes.includes("campaigns:write") ? [createTool] : []),
  ];
}

export async function callTool(context: ServiceContext, name: string, args: unknown) {
  if (name === createTool.name) return createServiceCampaign(context, args);
  if (!readTools.some(tool => tool.name === name)) throw new ApiError("Unknown tool", 404);
  requireScope(context, "campaigns:read");
  if (name === "list_campaigns") {
    if (!z.object({}).strict().safeParse(args).success) throw new ApiError("Invalid tool arguments");
    return listCampaigns(context);
  }
  const input = z.object({ id: z.string().min(1).max(100) }).strict().safeParse(args);
  if (!input.success) throw new ApiError("Campaign id required");
  return name === "get_campaign" ? getCampaign(context, input.data.id) : getCampaignStats(context, input.data.id);
}
