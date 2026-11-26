import { createHmac, timingSafeEqual } from "crypto";

export function verifyWebhookSignature(
  payload: string,
  signature: string | null
): boolean {
  if (!signature) return false;

  // Instagram-Login apps sign webhooks with the Instagram app secret, while
  // Facebook-Login apps use the Facebook app secret. Both belong to the same
  // app, so accept a signature that matches either — this avoids a config
  // guess about which key Meta uses for a given app type.
  const secrets = [
    process.env.FACEBOOK_APP_SECRET,
    process.env.INSTAGRAM_APP_SECRET,
  ].filter((s): s is string => Boolean(s));

  if (secrets.length === 0) {
    throw new Error(
      "FACEBOOK_APP_SECRET or INSTAGRAM_APP_SECRET is required to verify webhooks"
    );
  }

  return secrets.some((secret) => {
    const expected =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  });
}

export interface WebhookCommentEvent {
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
  /**
   * Set only when the comment was left on an ad: the id of the organic post
   * the ad was created from. Campaigns are configured against that post, so
   * matching has to consider it as well as mediaId.
   */
  originalMediaId?: string;
}

interface WebhookEntry {
  id: string;
  time: number;
  changes?: Array<{
    field: string;
    value: {
      id?: string;
      comment_id?: string;
      text?: string;
      from?: {
        id?: string;
        username?: string;
      };
      media?: {
        id?: string;
        // Present when media_product_type is "AD": the ad copy gets its own
        // media id, and this points back to the post it was boosted from.
        original_media_id?: string;
        ad_id?: string;
        media_product_type?: string;
      };
      media_id?: string;
    };
  }>;
  messaging?: WebhookMessagingItem[];
  /**
   * The same items while another app is the conversation's primary receiver
   * (Meta's Handover Protocol, "Conversation routing" in the Business Suite).
   * Nothing here is acted on, but the silence check (A2) counts them: they
   * show that Instagram still passes on what people do in their DMs.
   */
  standby?: WebhookMessagingItem[];
}

interface WebhookMessagingItem {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  postback?: { mid?: string; title?: string; payload?: string };
  read?: { watermark?: number; seq?: number; mid?: string };
  reaction?: { mid?: string; action?: string; reaction?: string; emoji?: string };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    attachments?: Array<{ type?: string }>;
  };
}

export interface WebhookMessageEvent {
  instagramAccountId: string;
  messageId: string;
  messageText: string;
  senderId: string;
}

export interface WebhookPostbackEvent {
  instagramAccountId: string;
  userId: string;
  payload: string;
  mid?: string;
}

export interface WebhookReadEvent {
  instagramAccountId: string;
  userId: string;
  watermark?: number;
}

interface WebhookPayload {
  object: string;
  entry: WebhookEntry[];
}

export function parseCommentEvents(payload: WebhookPayload): WebhookCommentEvent[] {
  const events: WebhookCommentEvent[] = [];

  if (payload.object !== "instagram") {
    return events;
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;

      const value = change.value;
      const commentId = value?.id ?? value?.comment_id;
      const mediaId = value?.media?.id ?? value?.media_id;
      // A comment on a boosted post arrives with the ad's media id, while the
      // campaign is set up against the organic post. Keep both so the worker
      // can match either one.
      const originalMediaId =
        value?.media?.original_media_id === mediaId
          ? undefined
          : value?.media?.original_media_id;
      const commenterId = value?.from?.id;

      if (!entry.id || !commentId || !mediaId || !commenterId) {
        continue;
      }

      // Skip the connected account's own comments and comment replies.
      // A private reply to yourself is rejected by Meta, so queueing one
      // only produces a failed log and wasted retries.
      if (commenterId === entry.id) {
        continue;
      }

      events.push({
        instagramAccountId: entry.id,
        commentId,
        commentText: value.text ?? "",
        commenterId,
        commenterName: value.from?.username,
        mediaId,
        originalMediaId,
      });
    }
  }

  return events;
}

/**
 * Parse button-tap postbacks (from an opening DM's button) out of a webhook
 * payload. Each event carries the tapping user's IGSID and our postback payload.
 */
export function parsePostbackEvents(
  payload: WebhookPayload
): WebhookPostbackEvent[] {
  const events: WebhookPostbackEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const postbackPayload = messaging.postback?.payload;
      const userId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!postbackPayload || !userId || !accountId) continue;
      // Ignore echoes of the account's own actions.
      if (userId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        userId,
        payload: postbackPayload,
        mid: messaging.postback?.mid,
      });
    }
  }

  return events;
}

/**
 * Parse inbound Instagram DMs out of a webhook payload. These drive the
 * keyword-triggered autoreply: a user messages the account, and a campaign
 * with `dmTriggerEnabled` whose keywords match the text replies to them.
 *
 * Echoes (messages the account itself sent, including our own autoreplies),
 * deletions, and attachment-only messages with no text are dropped here so
 * the worker never sees them — an echo would otherwise let an autoreply
 * containing its own keyword trigger itself.
 */
export function parseMessageEvents(
  payload: WebhookPayload
): WebhookMessageEvent[] {
  const events: WebhookMessageEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const message = messaging.message;
      if (!message) continue;
      if (message.is_echo || message.is_deleted || message.is_unsupported) {
        continue;
      }

      const text = message.text?.trim();
      const messageId = message.mid;
      const senderId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!text || !messageId || !senderId || !accountId) continue;
      // Ignore anything the connected account sent to itself.
      if (senderId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        messageId,
        messageText: text,
        senderId,
      });
    }
  }

  return events;
}

/**
 * Parse Instagram DM read receipts. When a user reads an opening DM but does
 * not tap its button, the webhook route uses this to schedule the reveal after
 * a short grace period.
 */
export function parseReadEvents(payload: WebhookPayload): WebhookReadEvent[] {
  const events: WebhookReadEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      if (!messaging.read) continue;

      const userId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!userId || !accountId) continue;
      if (userId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        userId,
        watermark: messaging.read.watermark,
      });
    }
  }

  return events;
}

/** What a person did in a DM, as the silence check (A2) counts it. */
export type InboundMessagingKind = "postback" | "message" | "read" | "reaction";

/**
 * What one messaging item says a person did, or null when it is nothing a
 * person did: an echo (every DM the account sends comes back as one), the
 * account's own action, or an item of another kind.
 */
export function inboundMessagingKind(
  item: WebhookMessagingItem,
  accountId: string
): InboundMessagingKind | null {
  if (item.sender?.id === accountId) return null;
  if (item.message) return item.message.is_echo ? null : "message";
  if (item.postback) return "postback";
  if (item.read) return "read";
  if (item.reaction) return "reaction";
  return null;
}

/**
 * A2: the accounts (their Instagram business ids, entry.id) for which the
 * payload carries at least one inbound messaging event: a button tap, a DM
 * that is not an echo (also one without text, deleted or unsupported), a read
 * receipt or a reaction, in `messaging` or in `standby`. Comment changes and
 * echoes never count. The webhook route stores such a payload and ends the
 * account's messaging silence with it (lib/instagram/messaging-silence-state.ts);
 * the worker's check reads the stored ones (lib/instagram/messaging-silence-check.ts).
 */
export function inboundMessagingAccountIds(payload: WebhookPayload): string[] {
  if (payload?.object !== "instagram" || !Array.isArray(payload.entry)) return [];
  const accounts = new Set<string>();
  for (const entry of payload.entry) {
    if (typeof entry?.id !== "string" || !entry.id) continue;
    const items = [
      ...(Array.isArray(entry.messaging) ? entry.messaging : []),
      ...(Array.isArray(entry.standby) ? entry.standby : []),
    ];
    if (items.some((item) => item && inboundMessagingKind(item, entry.id) !== null)) {
      accounts.add(entry.id);
    }
  }
  return [...accounts];
}
