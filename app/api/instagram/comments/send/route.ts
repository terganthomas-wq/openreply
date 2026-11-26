/**
 * Send a campaign's DM for one comment by hand (M1, "DM senden" on the
 * Kommentare page).
 *
 * POST { commentId, automationId, publicReply } — owners and admins, at most
 * 30 a minute per person. The comment is read again from Instagram and must
 * be under one of the account's posts, within 7 days and not the account's
 * own; the campaign must be the workspace's and have a DM text; no DM for
 * the comment may have gone out (Instagram allows one per comment). Then the
 * worker's comment job is queued for exactly this campaign, and the answer is
 * 202 { queued: true }: the DM itself goes out from the worker, and the page
 * reads the outcome from the DM log (GET /api/instagram/comments?ids=).
 *
 * A refusal says why in `reason` (lib/comments/server.ts ManualSendReason),
 * which the page shows in the reader's language.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SAFE_ID_PATTERN } from "@/lib/comments/manual";
import { sendCommentManually, takeManualSendSlot } from "@/lib/comments/server";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

const bodySchema = z
  .object({
    commentId: z.string().regex(SAFE_ID_PATTERN),
    automationId: z.string().regex(SAFE_ID_PATTERN),
    publicReply: z.boolean(),
  })
  .strict();

function fail(
  status: number,
  reason: string,
  error: string,
  extra: Record<string, unknown> = {}
) {
  return NextResponse.json(
    { success: false, reason, error, ...extra },
    { status, headers: NO_STORE }
  );
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return fail(401, "unauthorized", "Unauthorized");
  if (!canManageWorkspace(context.role)) {
    return fail(403, "forbidden", "Only owners and admins can send DMs");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid", "Invalid JSON");
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return fail(
      400,
      "invalid",
      'Send {"commentId": "…", "automationId": "…", "publicReply": true|false}'
    );
  }

  try {
    if (!(await takeManualSendSlot(context.userId))) {
      return fail(429, "rate_limited", "Too many manual sends; wait a minute");
    }
  } catch {
    return fail(503, "unavailable", "Sending is unavailable right now");
  }

  let result;
  try {
    result = await sendCommentManually({
      workspaceId: context.workspaceId,
      ...parsed.data,
    });
  } catch (error) {
    // The database or the queue failed: nothing was queued.
    console.error(
      "[Comments] Manual send failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    return fail(503, "unavailable", "Sending is unavailable right now");
  }
  if (!result.ok) {
    return fail(result.status, result.reason, result.error, {
      ...(result.pausedUntil ? { pausedUntil: result.pausedUntil } : {}),
      ...(result.commentStatus ? { status: result.commentStatus } : {}),
    });
  }
  return NextResponse.json(
    {
      success: true,
      queued: true,
      queuedAt: result.queuedAt,
      previousUpdatedAt: result.previousUpdatedAt,
    },
    { status: 202, headers: NO_STORE }
  );
}
