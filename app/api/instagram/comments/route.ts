/**
 * The Kommentare page's comments (M1, lib/comments/server.ts).
 *
 * GET ?instagramAccountId=&posts= — the comments of the account's newest
 * posts (15, "Mehr laden" adds 15, at most 60) within Instagram's 7-day
 * private-reply window, newest first, with where each one's DM stands. Reads
 * Meta (one media read, one comment read per post), cached for 60 seconds
 * per account; while the account is paused for a Meta limit it reads nothing
 * and answers with the pause.
 *
 * GET ?ids=a,b — where these comments' DMs stand, from the database only:
 * the page asks this while it waits for a manual send.
 *
 * Owners and admins only, as for every send; an account of another
 * workspace is a 404 like a missing one.
 */

import { NextRequest, NextResponse } from "next/server";
import { commentsPostCount, SAFE_ID_PATTERN } from "@/lib/comments/manual";
import {
  loadCommentsPage,
  loadCommentStatuses,
} from "@/lib/comments/server";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";
// Statuses change with every send: never cached by the route or a CDN.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
// Comments a status poll may ask for at once.
const MAX_STATUS_IDS = 50;

function fail(status: number, reason: string, error: string) {
  return NextResponse.json(
    { success: false, reason, error },
    { status, headers: NO_STORE }
  );
}

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return fail(401, "unauthorized", "Unauthorized");
  if (!canManageWorkspace(context.role)) {
    return fail(
      403,
      "forbidden",
      "Only owners and admins can see comments and send DMs"
    );
  }

  const params = request.nextUrl.searchParams;
  const account = await getWorkspaceInstagramAccount(
    context.workspaceId,
    params.get("instagramAccountId")
  );
  if (!account) {
    return fail(404, "no_account", "Instagram account not connected");
  }
  if (account.provider !== "META") {
    return fail(
      400,
      "provider",
      "Manual sending needs an account connected through your own Meta app"
    );
  }

  const ids = params.get("ids");
  if (ids !== null) {
    const commentIds = [
      ...new Set(ids.split(",").filter((id) => SAFE_ID_PATTERN.test(id))),
    ].slice(0, MAX_STATUS_IDS);
    const statuses = await loadCommentStatuses({
      workspaceId: context.workspaceId,
      accountId: account.id,
      commentIds,
    });
    return NextResponse.json(
      { success: true, data: { statuses } },
      { headers: NO_STORE }
    );
  }

  try {
    const data = await loadCommentsPage({
      workspaceId: context.workspaceId,
      account,
      posts: commentsPostCount(params.get("posts")),
    });
    return NextResponse.json({ success: true, data }, { headers: NO_STORE });
  } catch (error) {
    console.error(
      "[Comments] Could not load the comments:",
      error instanceof Error ? error.message : "unknown error"
    );
    return fail(502, "instagram_error", "Could not read the comments from Instagram");
  }
}
