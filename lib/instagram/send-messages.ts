import { createHash, randomUUID } from "node:crypto";
import * as meta from "@/lib/meta/client";
import {
  zernioRequest,
  ZernioApiError,
  ZernioDeliveryUnconfirmedError,
} from "@/lib/zernio/client";
import type { InstagramContext, ZernioContext } from "./context";

type Button =
  | { type: "url"; title: string; url: string }
  | { type: "postback"; title: string; payload: string };

async function sendZernioMessage({
  context,
  recipientId,
  commentId,
  postId,
  text,
  buttons,
}: {
  context: ZernioContext;
  recipientId?: string;
  commentId?: string;
  postId?: string;
  text: string;
  buttons?: Button[];
}) {
  const path = commentId
    ? `/inbox/comments/${encodeURIComponent(postId ?? commentId)}/${encodeURIComponent(commentId)}/private-reply`
    : `/inbox/conversations/${encodeURIComponent(recipientId!)}/messages`;
  const body = {
    accountId: context.accountId,
    message: buttons ? text.slice(0, 640) : text,
    ...(buttons ? { buttons } : {}),
  };
  const idempotencyKey = createHash("sha256")
    .update(
      JSON.stringify({
        operationId: context.operationId ?? randomUUID(),
        path,
        body,
      })
    )
    .digest("hex");
  const result = await zernioRequest<{
    messageId?: string;
    data?: { messageId: string };
  }>({
    apiKey: context.apiKey,
    path,
    method: "POST",
    body,
    ...(commentId ? {} : { idempotencyKey }),
  }).catch((error: unknown) => {
    // A send may have succeeded upstream before a network/5xx failure. The
    // service releases idempotency claims on non-2xx, so do not auto-resend.
    if (error instanceof ZernioApiError && error.code >= 500)
      throw new ZernioDeliveryUnconfirmedError();
    throw error;
  });
  const messageId = result?.messageId ?? result?.data?.messageId;
  if (!messageId) throw new ZernioDeliveryUnconfirmedError();
  return {
    message_id: messageId,
    ...(recipientId ? { recipient_id: recipientId } : {}),
  };
}

function linkButtons(buttons: meta.LinkButton[]): Button[] {
  return buttons
    .slice(0, 3)
    .map(({ title, url }) => ({ type: "url", title: title.slice(0, 20), url }));
}

export async function sendPrivateReply({
  context,
  instagramAccountId,
  commentId,
  message,
  postId,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  commentId: string;
  message: string;
  postId?: string;
}) {
  if (context.provider === "META")
    return meta.sendPrivateReply(
      context,
      instagramAccountId,
      commentId,
      message
    );
  return sendZernioMessage({ context, commentId, postId, text: message });
}

export async function sendPrivateReplyWithButton({
  context,
  instagramAccountId,
  commentId,
  text,
  buttonTitle,
  payload,
  postId,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  commentId: string;
  text: string;
  buttonTitle: string;
  payload: string;
  postId?: string;
}) {
  if (context.provider === "META")
    return meta.sendPrivateReplyWithButton(
      context,
      instagramAccountId,
      commentId,
      text,
      buttonTitle,
      payload
    );
  return sendZernioMessage({
    context,
    commentId,
    postId,
    text: text,
    buttons: [{ type: "postback", title: buttonTitle.slice(0, 20), payload }],
  });
}

export async function sendDirectMessageWithButton({
  context,
  instagramAccountId,
  userId,
  text,
  buttonTitle,
  payload,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  text: string;
  buttonTitle: string;
  payload: string;
}) {
  if (context.provider === "META")
    return meta.sendDirectMessageWithButton(
      context,
      instagramAccountId,
      userId,
      text,
      buttonTitle,
      payload
    );
  return sendZernioMessage({
    context,
    recipientId: userId,
    text: text,
    buttons: [{ type: "postback", title: buttonTitle.slice(0, 20), payload }],
  });
}

export async function sendPrivateReplyWithLinkButton({
  context,
  instagramAccountId,
  commentId,
  text,
  buttons,
  postId,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  commentId: string;
  text: string;
  buttons: meta.LinkButton[];
  postId?: string;
}) {
  if (context.provider === "META")
    return meta.sendPrivateReplyWithLinkButton(
      context,
      instagramAccountId,
      commentId,
      text,
      buttons
    );
  return sendZernioMessage({
    context,
    commentId,
    postId,
    text: text,
    buttons: linkButtons(buttons),
  });
}

export async function sendDirectMessage({
  context,
  instagramAccountId,
  userId,
  message,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  message: string;
}) {
  if (context.provider === "META")
    return meta.sendDirectMessage(
      context,
      instagramAccountId,
      userId,
      message
    );
  return sendZernioMessage({ context, recipientId: userId, text: message });
}

export async function sendDirectMessageWithLinkButton({
  context,
  instagramAccountId,
  userId,
  text,
  buttons,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  text: string;
  buttons: meta.LinkButton[];
}) {
  if (context.provider === "META")
    return meta.sendDirectMessageWithLinkButton(
      context,
      instagramAccountId,
      userId,
      text,
      buttons
    );
  return sendZernioMessage({
    context,
    recipientId: userId,
    text: text,
    buttons: linkButtons(buttons),
  });
}

/**
 * The text of a card where the card itself cannot be sent: the title, then
 * the subtitle on its own line. Shared by the Zernio send below and the
 * fallbacks for a card Meta refuses, so a card reads the same either way.
 */
export function cardFallbackText(card: meta.CardMessage): string {
  return [card.title, card.subtitle].filter(Boolean).join("\n");
}

export async function sendDirectMessageWithCard({
  context,
  instagramAccountId,
  userId,
  card,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  card: meta.CardMessage;
}) {
  if (context.provider === "META")
    return meta.sendDirectMessageWithCard(
      context,
      instagramAccountId,
      userId,
      card
    );
  // Zernio messages carry text with url or postback buttons and nothing else,
  // so the card goes out as its text and its button in this one request,
  // without the image.
  return sendZernioMessage({
    context,
    recipientId: userId,
    text: cardFallbackText(card),
    buttons: linkButtons([card.button]),
  });
}

export async function sendCommentReply({
  context,
  commentId,
  message,
  postId,
}: {
  context: InstagramContext;
  commentId: string;
  message: string;
  postId?: string;
}) {
  if (context.provider === "META")
    return meta.sendCommentReply(context, commentId, message);
  const result = await zernioRequest<{ data: { commentId: string } }>({
    apiKey: context.apiKey,
    path: `/inbox/comments/${encodeURIComponent(postId ?? commentId)}`,
    method: "POST",
    body: { accountId: context.accountId, commentId, message },
  }).catch((error: unknown) => {
    if (error instanceof ZernioApiError && error.code >= 500) throw new ZernioDeliveryUnconfirmedError();
    throw error;
  });
  if (!result?.data?.commentId) throw new ZernioDeliveryUnconfirmedError();
  return { id: result.data.commentId };
}
