import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { hashServiceToken, newServiceToken, SERVICE_SCOPES } from "@/lib/integrations/auth";
import { apiError, ApiError, checkOrigin, readJson } from "@/lib/integrations/http";
import { keyExpired, keyExpiryWarning, keyLifetime, SIGNUP_KEY_LIFETIME } from "@/lib/integrations/key-lifetime";
import { CAMPAIGN_SCOPES, isAllowedScopeSet } from "@/lib/integrations/scopes";

const safeFields = { id: true, name: true, scopes: true, createdAt: true, expiresAt: true, revokedAt: true, lastUsedAt: true } as const;
export async function GET() {
  try {
    const context = await getCurrentWorkspaceContext();
    if (!context || !canManageWorkspace(context.role)) throw new ApiError("Admin role required", 403);
    const keys = await prisma.serviceKey.findMany({ where: { workspaceId: context.workspaceId }, select: safeFields });
    // Whether each key has expired or needs a new one soon, by the server's
    // clock, as Diagnostics tells it (lib/integrations/key-lifetime.ts).
    const now = Date.now();
    return Response.json({ keys: keys.map(key => ({ ...key, expired: keyExpired(key, now), expiryWarning: keyExpiryWarning(key, now) })) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const context = await getCurrentWorkspaceContext();
    if (!context || !canManageWorkspace(context.role)) throw new ApiError("Admin role required", 403);
    // Read, write or both, or reporting sign-ups alone; the page offers
    // read-only, read-and-write and sign-up keys. At most both campaign
    // scopes, and the sign-up scope never with another one.
    const input = z.object({ name: z.string().trim().min(1).max(100),
      scopes: z.array(z.enum(SERVICE_SCOPES)).min(1).max(CAMPAIGN_SCOPES.length).refine(isAllowedScopeSet),
      days: z.number().int().min(1).max(SIGNUP_KEY_LIFETIME.maxDays).optional() }).strict().safeParse(await readJson(request));
    if (!input.success) throw new ApiError("Invalid key configuration");
    const scopes = [...new Set(input.data.scopes)];
    // A sign-up key may live up to a year, a year by default; campaign keys
    // 90 days at most, 30 by default.
    const lifetime = keyLifetime(scopes);
    const days = input.data.days ?? lifetime.defaultDays;
    if (days > lifetime.maxDays) throw new ApiError("Invalid key configuration");
    const token = newServiceToken();
    const key = await prisma.serviceKey.create({ data: { name: input.data.name, scopes,
      workspaceId: context.workspaceId, tokenHash: hashServiceToken(token), expiresAt: new Date(Date.now() + days * 86400000) }, select: safeFields });
    return Response.json({ key, token }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
export async function DELETE(request: Request) {
  try {
    checkOrigin(request);
    const context = await getCurrentWorkspaceContext();
    if (!context || !canManageWorkspace(context.role)) throw new ApiError("Admin role required", 403);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ApiError("Key id required");
    const result = await prisma.serviceKey.updateMany({ where: { id, workspaceId: context.workspaceId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!result.count) throw new ApiError("Key not found or already revoked", 404);
    return Response.json({ success: true });
  } catch (error) { return apiError(error); }
}
