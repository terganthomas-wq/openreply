import { z } from "zod";
import { authenticateService, requireScope } from "@/lib/integrations/auth";
import { createServiceCampaign, getCampaign, getCampaignStats, listCampaigns } from "@/lib/integrations/campaigns";
import { apiError, ApiError, checkOrigin, readJson } from "@/lib/integrations/http";

export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id !== null && !z.string().min(1).max(100).safeParse(id).success) throw new ApiError("Invalid campaign id");
    if (url.searchParams.has("stats") && !id) throw new ApiError("Campaign id required for stats");
    const data = id ? url.searchParams.has("stats") ? await getCampaignStats(context, id) : await getCampaign(context, id) : await listCampaigns(context);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

/** Creates a campaign (campaigns:write); the body is checked only for keys that may. */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    requireScope(context, "campaigns:write");
    const data = await createServiceCampaign(context, await readJson(request));
    return Response.json({ data }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
