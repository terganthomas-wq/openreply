import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import {
  inboxBudgetResponse,
  inboxConnectionLostResponse,
  inboxPausedUntil,
  inboxRetryAfter,
  reserveInboxRead,
} from "@/lib/inbox/read-budget";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { isMetaThrottle, throttlePauseMs } from "@/lib/instagram/delivery-errors";
import {
  getConversations,
  sendDirectMessage,
  MetaApiError,
} from "@/lib/instagram/provider";
import { createInstagramContext } from "@/lib/instagram/provider";

export interface ConversationListItem {
  id: string;
  detailsUnavailable?: boolean;
  contact: { id: string; username: string | null };
  updatedTime: string | null;
  lastMessage: {
    text: string;
    fromMe: boolean;
    createdTime: string | null;
  } | null;
}

export interface ConversationsResponse {
  conversations: ConversationListItem[];
  account: { id: string; username: string; instagramId: string };
}

// List the account's DM conversations for the inbox. Every request to Meta
// takes one of the account's hourly Inbox reads (lib/inbox/read-budget.ts):
// a list of several pages, or a conversation Meta cannot expand being
// narrowed down, takes one per request. Beyond them, and while the worker
// has paused the account for a Meta request limit, the answer is 429
// inbox_budget; so it is when Meta refuses the read itself for a limit,
// with the pause the worker would take. A full read the budget stops before
// its end answers with the conversations read so far and `partial` (the
// window's end, also as Retry-After), so the page keeps what it shows. The
// Inbox's timer reads (`?silent=1`) make exactly one request: the newest
// page, and a page Meta refuses fails the read. While the account's
// connection is lost (A1) the answer is 409 connection_lost, without a Meta
// call.
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

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

  // The reservation above covers the first request; each further one takes
  // another read, and a timer read makes none.
  const silent = request.nextUrl.searchParams.get("silent") === "1";
  const refused: { until: Date | null } = { until: null };
  const beforeRequest = async (): Promise<boolean> => {
    if (silent) return false;
    const next = await reserveInboxRead(account.id);
    if (!next.allowed) refused.until = next.retryAt;
    return next.allowed;
  };

  try {
    const accessToken = await createInstagramContext(account);
    const raw = await getConversations({
      context: accessToken,
      igUserId: account.instagramId,
      beforeRequest,
      ...(silent ? { maxPages: 1 } : {}),
    });

    const conversations: ConversationListItem[] = raw.map((c) => {
      const participants = c.participants?.data ?? [];
      const contact =
        participants.find((p) => p.id !== account.instagramId) ?? null;
      const last = c.messages?.data?.[0] ?? null;

      return {
        id: c.id,
        detailsUnavailable: c.detailsUnavailable,
        contact: {
          id: contact?.id ?? "",
          username: contact?.username ?? null,
        },
        updatedTime: c.updated_time ?? null,
        lastMessage: last
          ? {
              text: last.message ?? "",
              fromMe: last.from?.id === account.instagramId,
              createdTime: last.created_time ?? null,
            }
          : null,
      };
    });

    const data: ConversationsResponse = {
      conversations,
      account: {
        id: account.id,
        username: account.username,
        instagramId: account.instagramId,
      },
    };
    // The budget stopped the read before its end: what it read, marked, so
    // the page puts it on top of what it shows and pauses until then.
    if (refused.until) {
      return NextResponse.json(
        { success: true, data, partial: { retryAt: refused.until.toISOString() } },
        { headers: { "Retry-After": inboxRetryAfter(refused.until) } }
      );
    }
    return NextResponse.json({ success: true, data });
  } catch (err) {
    // The budget ran out before a single conversation could be read.
    if (refused.until) return inboxBudgetResponse(refused.until);
    // Meta refused the read for a request limit: the Inbox stops asking for
    // the pause the worker takes after such a refusal (throttlePauseMs: 20
    // minutes, an hour for a block, unless configured), instead of asking
    // again every 2 minutes.
    if (isMetaThrottle(err)) {
      return inboxBudgetResponse(new Date(Date.now() + throttlePauseMs(err)));
    }
    console.error("[Conversations] Error:", err);
    const message =
      err instanceof MetaApiError
        ? err.message
        : "Failed to load conversations";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

// Send a direct message reply.
export async function POST(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let body: {
    instagramAccountId?: string;
    recipientId?: string;
    text?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  const text = body.text?.trim();
  if (!body.recipientId || !text) {
    return NextResponse.json(
      { success: false, error: "A recipient and message are required." },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    body.instagramAccountId ?? null
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  try {
    const accessToken = await createInstagramContext(account);
    const result = await sendDirectMessage({
      context: accessToken,
      instagramAccountId: account.instagramId,
      userId: body.recipientId,
      message: text,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error("[Conversations] Send error:", err);
    // Surface Meta's own message — the common case is the 24-hour messaging
    // window having closed, which the user needs to see explicitly.
    const message =
      err instanceof MetaApiError ? err.message : "Failed to send message";
    return NextResponse.json(
      { success: false, error: message },
      { status: 502 }
    );
  }
}
