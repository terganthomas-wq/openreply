import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import {
  inboxBudgetResponse,
  inboxConnectionLostResponse,
  inboxPausedUntil,
  reserveInboxRead,
} from "@/lib/inbox/read-budget";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { isMetaThrottle, throttlePauseMs } from "@/lib/instagram/delivery-errors";
import {
  getConversationMessages,
  MetaApiError,
} from "@/lib/instagram/provider";
import { createInstagramContext } from "@/lib/instagram/provider";

export interface ThreadMessage {
  id: string;
  text: string;
  fromMe: boolean;
  fromUsername: string | null;
  createdTime: string | null;
}

export interface ThreadResponse {
  messages: ThreadMessage[];
}

type RouteProps = { params: Promise<{ id: string }> };

// Message history for a single conversation (20 most recent, chronological).
// One request to Meta, which takes one of the account's hourly Inbox reads
// (lib/inbox/read-budget.ts), like the list; beyond them, while the worker
// has paused the account for a Meta request limit, and when Meta refuses the
// read itself for a limit, the answer is 429 inbox_budget. While the
// account's connection is lost (A1) it is 409 connection_lost, without a
// Meta call.
export async function GET(request: NextRequest, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id: conversationId } = await params;

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  // Meta refuses the account until it is reconnected: no request, no read.
  if (account.connectionLostAt) {
    return inboxConnectionLostResponse(account.connectionLostAt);
  }
  const pausedUntil = await inboxPausedUntil(account.instagramId);
  if (pausedUntil) return inboxBudgetResponse(pausedUntil);
  const budget = await reserveInboxRead(account.id);
  if (!budget.allowed) return inboxBudgetResponse(budget.retryAt);

  try {
    const accessToken = await createInstagramContext(account);
    const raw = await getConversationMessages({
      context: accessToken,
      conversationId: conversationId,
    });

    // The API returns newest-first; reverse to read top-to-bottom.
    const messages: ThreadMessage[] = raw
      .map((m) => ({
        id: m.id,
        text: m.message ?? "",
        fromMe: m.from?.id === account.instagramId,
        fromUsername: m.from?.username ?? null,
        createdTime: m.created_time ?? null,
      }))
      .reverse();

    const data: ThreadResponse = { messages };
    return NextResponse.json({ success: true, data });
  } catch (err) {
    // Meta refused the read for a request limit: the Inbox stops asking for
    // the pause the worker takes after such a refusal (throttlePauseMs).
    if (isMetaThrottle(err)) {
      return inboxBudgetResponse(new Date(Date.now() + throttlePauseMs(err)));
    }
    console.error("[Conversation Messages] Error:", err);
    const message =
      err instanceof MetaApiError ? err.message : "Failed to load messages";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
