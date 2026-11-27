import { getMetaGraphApiVersion, requireEnv } from "@/lib/env";
import { META_BLOCK_CODE, META_THROTTLE_CODES } from "./limits";
import { noteMetaUsage } from "./usage";

/**
 * A Meta access token and the setup that issued it. A bare string is an
 * Instagram Login token, which is what every account connected before Unified
 * login support holds. The Instagram META context satisfies the object form;
 * its instagramId names the account whose request-limit usage a response
 * reports (lib/meta/usage.ts).
 */
export type MetaAuth =
  | string
  | { accessToken: string; unifiedLogin?: boolean; instagramId?: string };

function tokenOf(auth: MetaAuth): string {
  return typeof auth === "string" ? auth : auth.accessToken;
}

function instagramIdOf(auth: MetaAuth): string | null {
  return typeof auth !== "string" && typeof auth.instagramId === "string"
    ? auth.instagramId
    : null;
}

/**
 * fetch for every Meta call. Each response tells how close the app is to
 * Meta's request limits (x-app-usage, x-business-use-case-usage), which is
 * handed to the usage observer before the caller reads the response.
 */
async function metaFetch(
  auth: MetaAuth,
  input: string,
  init?: RequestInit
): Promise<Response> {
  const response =
    init === undefined ? await fetch(input) : await fetch(input, init);
  noteMetaUsage(response?.headers, instagramIdOf(auth));
  return response;
}

function isUnified(auth: MetaAuth): boolean {
  return typeof auth !== "string" && Boolean(auth.unifiedLogin);
}

// An Instagram Login token only works on graph.instagram.com; a Unified login
// token (a business system user token) only on graph.facebook.com. The
// Instagram endpoints keep the same paths on both hosts.
function instagramGraphBase(auth: MetaAuth) {
  return isUnified(auth)
    ? facebookGraphBase()
    : `https://graph.instagram.com/${getMetaGraphApiVersion()}`;
}

function facebookGraphBase() {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

export class MetaApiError extends Error {
  constructor(
    public code: number,
    public subcode: number | undefined,
    public fbTraceId: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

// These subclasses carry the subcode and the code Meta actually sent. The
// subcode is the only thing that separates a permanent rejection (a comment
// not eligible for a private reply, sub=2534025) from one worth retrying, and
// the fixed code made a 10 or a 200 arrive as a 100 — which is what
// `isTemplateRejection` in the DM worker tests for before it tries another
// send. Both arguments default to the previous values, so existing call sites
// are unaffected.
export class TokenExpiredError extends MetaApiError {
  constructor(message: string, fbTraceId?: string, subcode?: number) {
    super(190, subcode, fbTraceId, message);
    this.name = "TokenExpiredError";
  }
}

export class RateLimitError extends MetaApiError {
  constructor(
    message: string,
    fbTraceId?: string,
    subcode?: number,
    code = 368
  ) {
    super(code, subcode, fbTraceId, message);
    this.name = "RateLimitError";
  }
}

export class PermissionError extends MetaApiError {
  constructor(
    message: string,
    fbTraceId?: string,
    subcode?: number,
    code = 100
  ) {
    super(code, subcode, fbTraceId, message);
    this.name = "PermissionError";
  }
}

interface GraphApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export interface InstagramUser {
  id: string;
  // Instagram professional account ID. This — not `id` (the app-scoped ID) —
  // is what appears as entry.id in webhooks and is used by the messaging API.
  user_id?: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
  // Current follower total. Point-in-time only — Instagram exposes no history
  // for this field, so long-run trends come from FollowerSnapshot instead.
  followers_count?: number;
}

export interface InstagramComment {
  id: string;
  text: string;
  from?: {
    id: string;
    username?: string;
  };
  timestamp: string;
  // Present when the comments query asks for replies{from}. Used to tell whether
  // the account owner has already replied to this comment.
  replies?: {
    data?: { id: string; from?: { id: string; username?: string } }[];
  };
}

export interface InstagramMedia {
  id: string;
  caption?: string;
  media_type: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  timestamp: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
}

export interface InstagramMediaInsights {
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  saved?: number;
  shares?: number;
  total_interactions?: number;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * The typed error for a Meta error response. Every request limit
 * (lib/meta/limits.ts: the throttles and the 368 block) becomes a
 * RateLimitError that keeps Meta's code, which tells a throttle from a block.
 */
function metaErrorFrom(response: Response, data: unknown): MetaApiError {
  const err = (data as GraphApiError | null)?.error;
  const code = err?.code ?? response.status;
  const subcode = err?.error_subcode;
  const traceId = err?.fbtrace_id;
  // Without the path a Meta error is unattributable: a connect runs several
  // calls in a row that fail with the identical message. The query string is
  // dropped on purpose — it carries the access token.
  let path = "";
  try {
    path = ` (${new URL(response.url).pathname})`;
  } catch {}
  const message = `${err?.message ?? "Unknown Meta API error"}${path} [code=${code} sub=${subcode ?? "-"} type=${err?.type ?? "-"} trace=${traceId ?? "-"}]`;

  if (code === 190) return new TokenExpiredError(message, traceId, subcode);
  if (code === META_BLOCK_CODE || META_THROTTLE_CODES.includes(code)) {
    return new RateLimitError(message, traceId, subcode, code);
  }
  if (code === 10 || code === 100 || code === 200) {
    return new PermissionError(message, traceId, subcode, code);
  }
  return new MetaApiError(code, subcode, traceId, message);
}

async function handleResponse<T>(response: Response): Promise<T> {
  const data = await response.json();

  if (!response.ok || (data as GraphApiError).error) {
    throw metaErrorFrom(response, data);
  }

  return data as T;
}

export async function sendPrivateReply(
  auth: MetaAuth,
  instagramAccountId: string,
  commentId: string,
  message: string
): Promise<{ recipient_id: string; message_id: string }> {
  const accessToken = tokenOf(auth);
  const response = await metaFetch(
    auth,
    `${instagramGraphBase(auth)}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: { text: message },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Send a private reply to a comment as a button template — an opening message
 * plus a postback button. Tapping the button opens the conversation and fires
 * a `messaging_postbacks` webhook carrying `payload`, which we use to deliver
 * the follow-up ("reveal") message.
 */
export async function sendPrivateReplyWithButton(
  auth: MetaAuth,
  instagramAccountId: string,
  commentId: string,
  text: string,
  buttonTitle: string,
  payload: string
): Promise<{ recipient_id: string; message_id: string }> {
  const accessToken = tokenOf(auth);
  const response = await metaFetch(
    auth,
    `${instagramGraphBase(auth)}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              // Button template text is capped at 640 chars by Meta.
              text: text.slice(0, 640),
              buttons: [
                { type: "postback", title: buttonTitle.slice(0, 20), payload },
              ],
            },
          },
        },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Send a direct message (to a user's IGSID) as a button template with a single
 * postback button. Used to re-prompt a user during follow-gating, so tapping
 * the button fires another `messaging_postbacks` webhook carrying `payload`.
 */
export async function sendDirectMessageWithButton(
  auth: MetaAuth,
  instagramAccountId: string,
  userId: string,
  text: string,
  buttonTitle: string,
  payload: string
): Promise<{ recipient_id: string; message_id: string }> {
  const accessToken = tokenOf(auth);
  const response = await metaFetch(
    auth,
    `${instagramGraphBase(auth)}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: userId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: text.slice(0, 640),
              buttons: [
                { type: "postback", title: buttonTitle.slice(0, 20), payload },
              ],
            },
          },
        },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Check whether a user (by their IGSID) follows the business account, via the
 * Instagram Messaging profile API. Available for users in an active
 * conversation (e.g. after a private reply or a button tap). Returns true or
 * false, or `null` when Meta does not return the field — so callers can decide
 * how to treat the unverifiable case.
 */
export async function getUserFollowStatus(
  auth: MetaAuth,
  recipientId: string,
  {
    throwOnLimit = false,
  }: {
    // A request limit (RateLimitError) is thrown instead of read as unknown:
    // the caller can wait for the limit instead of acting on a follow status
    // it never got. Every other failure stays null.
    throwOnLimit?: boolean;
  } = {}
): Promise<boolean | null> {
  const accessToken = tokenOf(auth);
  const url = new URL(`${instagramGraphBase(auth)}/${recipientId}`);
  url.searchParams.set("fields", "is_user_follow_business");

  let response: Response;
  let data: { is_user_follow_business?: unknown } | null;
  try {
    response = await metaFetch(auth, url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    data = await response.json().catch(() => null);
  } catch {
    return null;
  }
  if (!response.ok) {
    if (throwOnLimit) {
      const error = metaErrorFrom(response, data);
      if (error instanceof RateLimitError) throw error;
    }
    return null;
  }
  return typeof data?.is_user_follow_business === "boolean"
    ? data.is_user_follow_business
    : null;
}

/**
 * The handle behind an IGSID, for personalizing a message to someone who
 * messaged the account. The messages and postbacks webhooks carry only the
 * sender's id, unlike the comments webhook, which carries the username.
 *
 * Instagram answers this for anyone who has an open conversation with the
 * account, which is exactly who arrives on those two paths. null when the
 * handle cannot be read, so the caller falls back as before.
 */
export async function getUserUsername(
  auth: MetaAuth,
  recipientId: string
): Promise<string | null> {
  const accessToken = tokenOf(auth);
  const url = new URL(`${instagramGraphBase(auth)}/${recipientId}`);
  url.searchParams.set("fields", "username");

  try {
    const response = await metaFetch(auth, url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data?.username === "string" && data.username
      ? data.username
      : null;
  } catch {
    return null;
  }
}

/**
 * A tappable web_url button in a DM button template. Instagram's button
 * template supports up to 3 buttons; titles are capped at 20 chars by Meta.
 */
export interface LinkButton {
  title: string;
  url: string;
}

function toWebUrlButtons(buttons: LinkButton[]) {
  return buttons
    .slice(0, 3)
    .map((b) => ({ type: "web_url", url: b.url, title: b.title.slice(0, 20) }));
}

/**
 * Send a private reply to a comment as a button template with up to 3 web_url
 * buttons — the reveal message plus tappable link buttons (for campaigns with
 * no opening DM, where the reveal is delivered straight to the comment).
 */
export async function sendPrivateReplyWithLinkButton(
  auth: MetaAuth,
  instagramAccountId: string,
  commentId: string,
  text: string,
  buttons: LinkButton[]
): Promise<{ recipient_id: string; message_id: string }> {
  const accessToken = tokenOf(auth);
  const response = await metaFetch(
    auth,
    `${instagramGraphBase(auth)}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: text.slice(0, 640),
              buttons: toWebUrlButtons(buttons),
            },
          },
        },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Send a plain-text direct message to a user by their Instagram-scoped ID.
 * Used to deliver the reveal message after a button postback.
 */
export async function sendDirectMessage(
  auth: MetaAuth,
  instagramAccountId: string,
  userId: string,
  message: string
): Promise<{ recipient_id: string; message_id: string }> {
  const accessToken = tokenOf(auth);
  const response = await metaFetch(
    auth,
    `${instagramGraphBase(auth)}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: userId },
        message: { text: message },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Send a direct message as a button template with up to 3 web_url buttons —
 * the reveal message plus tappable link buttons (cleaner than inline URLs).
 */
export async function sendDirectMessageWithLinkButton(
  auth: MetaAuth,
  instagramAccountId: string,
  userId: string,
  text: string,
  buttons: LinkButton[]
): Promise<{ recipient_id: string; message_id: string }> {
  const accessToken = tokenOf(auth);
  const response = await metaFetch(
    auth,
    `${instagramGraphBase(auth)}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: userId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: text.slice(0, 640),
              buttons: toWebUrlButtons(buttons),
            },
          },
        },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * A card in a DM: Instagram's generic template with a single element. The
 * title is required; the subtitle and the image are optional.
 */
export interface CardMessage {
  title: string;
  subtitle?: string | null;
  /**
   * A public https URL of the image itself. Instagram fetches it, so a page
   * that shows the image (a Drive share link, for one) does not work.
   */
  imageUrl?: string | null;
  button: LinkButton;
}

/**
 * Send a direct message as a card (generic template): an optional image, a
 * title, an optional subtitle and one web_url button.
 *
 * The title and the subtitle are cut to Meta's limit of 80, as the button
 * template's text is cut to 640. An absent subtitle or image is left out of
 * the element rather than sent empty. There is no default_action (a tap on
 * the card outside its button): how Instagram handles one has not been
 * verified, so the button stays the only way to the link.
 */
export async function sendDirectMessageWithCard(
  auth: MetaAuth,
  instagramAccountId: string,
  userId: string,
  card: CardMessage
): Promise<{ recipient_id: string; message_id: string }> {
  const accessToken = tokenOf(auth);
  const response = await metaFetch(
    auth,
    `${instagramGraphBase(auth)}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: userId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "generic",
              elements: [
                {
                  title: card.title.slice(0, 80),
                  ...(card.subtitle
                    ? { subtitle: card.subtitle.slice(0, 80) }
                    : {}),
                  ...(card.imageUrl ? { image_url: card.imageUrl } : {}),
                  buttons: toWebUrlButtons([card.button]),
                },
              ],
            },
          },
        },
      }),
    }
  );

  return handleResponse(response);
}

export async function sendCommentReply(
  auth: MetaAuth,
  commentId: string,
  message: string
): Promise<{ id: string }> {
  const accessToken = tokenOf(auth);
  const response = await metaFetch(
    auth,
    `${instagramGraphBase(auth)}/${commentId}/replies`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ message }),
    }
  );

  return handleResponse(response);
}

export async function getMediaComments(
  auth: MetaAuth,
  mediaId: string
): Promise<InstagramComment[]> {
  const accessToken = tokenOf(auth);
  const url = new URL(`${instagramGraphBase(auth)}/${mediaId}/comments`);
  url.searchParams.set("fields", "id,text,from,timestamp");
  url.searchParams.set("access_token", accessToken);

  const response = await metaFetch(auth, url.toString());
  const data = await handleResponse<{ data: InstagramComment[] }>(response);
  return data.data;
}

/**
 * Recent comments on a media, newest first, each with its replies so the caller
 * can tell whether the account owner has already responded. Pagination stops as
 * soon as it reaches comments older than `sinceMs` (or the `max` ceiling), so a
 * viral post's entire back-catalogue is never pulled — only what is recent
 * enough to still act on. This is what the polling reconciler reads.
 *
 * Note: comments hidden by Instagram's Hidden Words / spam filter may not be
 * returned by the Graph API at all. Disable that filter on the account to widen
 * results.
 */
export async function getRecentMediaComments(
  auth: MetaAuth,
  mediaId: string,
  sinceMs: number,
  max = 800
): Promise<InstagramComment[]> {
  const accessToken = tokenOf(auth);
  const results: InstagramComment[] = [];

  const first = new URL(`${instagramGraphBase(auth)}/${mediaId}/comments`);
  first.searchParams.set("fields", "id,text,timestamp,from,replies{from}");
  first.searchParams.set("order", "reverse_chronological");
  first.searchParams.set("limit", "50");
  first.searchParams.set("access_token", accessToken);

  let nextUrl: string | null = first.toString();

  while (nextUrl !== null && results.length < max) {
    const response: Response = await metaFetch(auth, nextUrl);
    const page = await handleResponse<{
      data: InstagramComment[];
      paging?: { next?: string };
    }>(response);
    const data = page.data ?? [];
    results.push(...data);

    // Newest-first, so once the last item on a page predates the window there
    // is nothing older worth fetching.
    const oldest = data[data.length - 1];
    if (oldest?.timestamp && Date.parse(oldest.timestamp) < sinceMs) break;
    nextUrl = page.paging?.next ?? null;
  }

  return results
    .filter((c) => !c.timestamp || Date.parse(c.timestamp) >= sinceMs)
    .slice(0, max);
}

/**
 * The newest comments on a media, newest first, each with who replied: one
 * request, never a second page. The Kommentare page reads one page per post
 * (at most `limit`, 50 by Meta's cap), so a page view costs a known number of
 * reads however busy a post is.
 */
export async function getLatestMediaComments(
  auth: MetaAuth,
  mediaId: string,
  limit = 50
): Promise<InstagramComment[]> {
  const url = new URL(`${instagramGraphBase(auth)}/${mediaId}/comments`);
  url.searchParams.set("fields", "id,text,timestamp,from,replies{from}");
  url.searchParams.set("order", "reverse_chronological");
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 50)));
  url.searchParams.set("access_token", tokenOf(auth));

  const page = await handleResponse<{ data?: InstagramComment[] }>(
    await metaFetch(auth, url.toString())
  );
  return page.data ?? [];
}

/**
 * One page of a list, as the catch-up after a lost connection reads it
 * (lib/instagram/connection-catch-up.ts): it decides itself whether the next
 * page is worth a request.
 */
export interface GraphPage<T> {
  data: T[];
  /**
   * Meta's link to the next page, or null. It carries the access token: only
   * ever fetched again, never logged or stored.
   */
  next: string | null;
}

/** How long one page read of the catch-up may take before it is given up. */
const PAGE_READ_TIMEOUT_MS = 20_000;

// Meta's link to the next page, followed only on the host the first request
// went to.
function nextPage(auth: MetaAuth, next: unknown): string | null {
  if (typeof next !== "string" || next === "") return null;
  try {
    const url = new URL(next);
    return url.origin === new URL(instagramGraphBase(auth)).origin
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * One page (50 at most) of a post's comments, newest first, each with who
 * replied: the first page for `next` null, else the page Meta's link names.
 * One request; aborted after 20 seconds.
 */
export async function getMediaCommentsPage(
  auth: MetaAuth,
  mediaId: string,
  next: string | null = null
): Promise<GraphPage<InstagramComment>> {
  let url: string;
  if (next) {
    url = next;
  } else {
    const first = new URL(`${instagramGraphBase(auth)}/${mediaId}/comments`);
    first.searchParams.set("fields", "id,text,timestamp,from,replies{from}");
    first.searchParams.set("order", "reverse_chronological");
    first.searchParams.set("limit", "50");
    first.searchParams.set("access_token", tokenOf(auth));
    url = first.toString();
  }
  const page = await handleResponse<{
    data?: InstagramComment[];
    paging?: { next?: string };
  }>(
    await metaFetch(auth, url, {
      method: "GET",
      signal: AbortSignal.timeout(PAGE_READ_TIMEOUT_MS),
    })
  );
  return { data: page.data ?? [], next: nextPage(auth, page.paging?.next) };
}

/** A post as the catch-up needs it: no caption, no media URLs. */
export type InstagramMediaSummary = Pick<
  InstagramMedia,
  "id" | "permalink" | "timestamp" | "comments_count"
>;

/**
 * One page (up to 100) of the account's posts, newest first, with only what
 * the catch-up needs: id, permalink, time and comment count. One request;
 * aborted after 20 seconds.
 */
export async function getUserMediaPage(
  auth: MetaAuth,
  {
    igUserId,
    limit = MEDIA_PAGE_SIZE,
    next = null,
  }: { igUserId?: string; limit?: number; next?: string | null } = {}
): Promise<GraphPage<InstagramMediaSummary>> {
  let url: string;
  if (next) {
    url = next;
  } else {
    const first = new URL(
      `${instagramGraphBase(auth)}/${instagramNode(auth, igUserId)}/media`
    );
    first.searchParams.set("fields", "id,permalink,timestamp,comments_count");
    first.searchParams.set(
      "limit",
      String(Math.min(Math.max(Math.floor(limit), 1), MEDIA_PAGE_SIZE))
    );
    first.searchParams.set("access_token", tokenOf(auth));
    url = first.toString();
  }
  const page = await handleResponse<{
    data?: InstagramMediaSummary[];
    paging?: { next?: string };
  }>(
    await metaFetch(auth, url, {
      method: "GET",
      signal: AbortSignal.timeout(PAGE_READ_TIMEOUT_MS),
    })
  );
  return { data: page.data ?? [], next: nextPage(auth, page.paging?.next) };
}

/** One comment as a manual send checks it: its author, its time and its post. */
export interface InstagramCommentDetail {
  id: string;
  text?: string;
  timestamp?: string;
  from?: { id: string; username?: string };
  media?: { id: string };
}

/** Read one comment by its id (`/{comment-id}`), with its author and its post. */
export async function getComment(
  auth: MetaAuth,
  commentId: string
): Promise<InstagramCommentDetail> {
  const url = new URL(
    `${instagramGraphBase(auth)}/${encodeURIComponent(commentId)}`
  );
  url.searchParams.set("fields", "id,text,timestamp,from{id,username},media{id}");
  url.searchParams.set("access_token", tokenOf(auth));

  return handleResponse<InstagramCommentDetail>(
    await metaFetch(auth, url.toString())
  );
}

// --- Direct message inbox (Conversations API) ---------------------------

export interface InstagramParticipant {
  id: string;
  username?: string;
}

export interface InstagramMessage {
  id: string;
  created_time?: string;
  message?: string;
  from?: InstagramParticipant;
  to?: { data: InstagramParticipant[] };
}

export interface InstagramConversation {
  id: string;
  detailsUnavailable?: boolean;
  updated_time?: string;
  participants?: { data: InstagramParticipant[] };
  messages?: { data: InstagramMessage[] };
}

// The safety bound on list pages in one read.
const CONVERSATION_PAGE_LIMIT = 100;

/**
 * Load up to 50 recent conversations. A single broken field expansion can make
 * Meta reject the entire page with code 1 (upstream issue #60). Halve only those
 * failing pages until the affected conversation is isolated, then retain its
 * basic metadata and advance using the OUTER conversation cursor.
 *
 * Healthy accounts still need just one request. Auth, permission, rate-limit,
 * transport and minimal-list failures remain visible rather than looking empty.
 *
 * `maxPages` stops after that many pages of the list and returns what they
 * held (the Inbox's timer reads ask for one, lib/inbox/poll.ts); a failing
 * page is still halved within it. Without it, the list is read to its end or
 * to 50 entries.
 */
export async function getConversations(
  auth: MetaAuth,
  igUserId: string,
  { maxPages }: { maxPages?: number } = {}
): Promise<InstagramConversation[]> {
  const accessToken = tokenOf(auth);
  const fields =
    "participants,updated_time,messages.limit(1){message,from,created_time}";
  type Page = {
    data?: InstagramConversation[];
    paging?: { next?: string; cursors?: { after?: string } };
  };
  const results: InstagramConversation[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | undefined;
  let pageSize = 50;

  async function readPage(limit: number, requestedFields: string): Promise<Page> {
    // Never follow Meta's next URL: rebuild on our trusted host and carry the
    // token separately. A messages.paging cursor must never advance this list.
    const url = new URL(`${instagramGraphBase(auth)}/${igUserId}/conversations`);
    url.searchParams.set("platform", "instagram");
    url.searchParams.set("fields", requestedFields);
    url.searchParams.set("limit", String(limit));
    if (after) url.searchParams.set("after", after);
    return handleResponse<Page>(
      await metaFetch(auth, url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      })
    );
  }

  // Also bound cursor traversal in case Meta repeats data with changing cursors.
  const pageLimit =
    maxPages === undefined || !Number.isFinite(maxPages)
      ? CONVERSATION_PAGE_LIMIT
      : Math.min(CONVERSATION_PAGE_LIMIT, Math.max(1, Math.floor(maxPages)));
  for (let pages = 0; pages < pageLimit && results.length < 50; pages++) {
    let limit = Math.min(pageSize, 50 - results.length);
    let page: Page;
    let unavailable = false;
    while (true) {
      try {
        page = await readPage(limit, fields);
        break;
      } catch (error) {
        if (!(error instanceof MetaApiError) || error.code !== 1) throw error;
        if (limit > 1) {
          limit = Math.max(1, Math.floor(limit / 2));
          continue;
        }
        // This exact cursor succeeds with id,updated_time in the reported case.
        // If even that fails, propagate the failure; do not skip unknown data.
        page = await readPage(1, "id,updated_time");
        unavailable = true;
        console.warn("[Conversations] Detail expansion unavailable", {
          code: error.code,
          subcode: error.subcode,
          trace: error.fbTraceId,
        });
        break;
      }
    }

    const rows = page.data ?? [];
    for (const row of rows) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      results.push(unavailable ? { ...row, detailsUnavailable: true } : row);
      if (results.length === 50) return results;
    }
    if (!page.paging?.next || rows.length === 0) return results;
    const nextAfter = page.paging.cursors?.after;
    if (!nextAfter || seenCursors.has(nextAfter)) {
      throw new Error("Instagram conversation pagination did not advance");
    }
    seenCursors.add(nextAfter);
    after = nextAfter;
    // Stay small around failures; grow back towards the normal page size after
    // successful expansions. Consecutive bad entries cost two reads each.
    pageSize = unavailable ? 1 : Math.min(50, limit * 2);
  }
  // The caller asked for fewer pages: what they held is the answer.
  if (pageLimit < CONVERSATION_PAGE_LIMIT) return results;
  throw new Error("Instagram conversation pagination exceeded its safety limit");
}

/** One page of the account's conversations, and the cursor of the next one. */
export interface ConversationPage {
  data: InstagramConversation[];
  /** The OUTER cursor of the next page; null at the end of the list. */
  after: string | null;
}

/**
 * One page of the account's conversations, newest first, with who takes
 * part and when each last changed (A2's search for lost taps,
 * lib/instagram/lost-tap-search.ts): one read, no message expansion. The
 * caller pages with `after` and decides what a failed page means (code 1
 * for a single broken entry: see getConversations above).
 */
export async function getConversationPage(
  auth: MetaAuth,
  igUserId: string,
  {
    limit,
    after = null,
    fields = "id,updated_time,participants",
  }: { limit: number; after?: string | null; fields?: string }
): Promise<ConversationPage> {
  const url = new URL(`${instagramGraphBase(auth)}/${igUserId}/conversations`);
  url.searchParams.set("platform", "instagram");
  url.searchParams.set("fields", fields);
  url.searchParams.set("limit", String(Math.max(1, Math.min(50, Math.floor(limit)))));
  if (after) url.searchParams.set("after", after);
  const page = await handleResponse<{
    data?: InstagramConversation[];
    paging?: { next?: string; cursors?: { after?: string } };
  }>(
    await metaFetch(auth, url.toString(), {
      headers: { Authorization: `Bearer ${tokenOf(auth)}` },
      signal: AbortSignal.timeout(10_000),
    })
  );
  const data = Array.isArray(page.data) ? page.data : [];
  // Never Meta's next URL: only its cursor, on our own host.
  const next = page.paging?.next ? page.paging.cursors?.after : undefined;
  return { data, after: data.length > 0 && next ? next : null };
}

/**
 * The messages in a conversation, with content. Meta only returns full details
 * for the 20 most recent messages, newest first.
 */
export async function getConversationMessages(
  auth: MetaAuth,
  conversationId: string,
  // The worker's search for lost taps must not hang on one read; the inbox
  // keeps waiting as before.
  { timeoutMs }: { timeoutMs?: number } = {}
): Promise<InstagramMessage[]> {
  const accessToken = tokenOf(auth);
  const url = new URL(`${instagramGraphBase(auth)}/${conversationId}`);
  url.searchParams.set("fields", "messages{id,created_time,from,to,message}");
  url.searchParams.set("access_token", accessToken);

  const response =
    timeoutMs === undefined
      ? await metaFetch(auth, url.toString())
      : await metaFetch(auth, url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
  const data = await handleResponse<{ messages?: { data: InstagramMessage[] } }>(
    response
  );
  return data.messages?.data ?? [];
}

// A Unified login token belongs to the client business's system user, not to
// one Instagram account, and one login can grant several. They are the assets
// the client assigned during login. In practice this comes back empty unless
// the login configuration also includes business_management (issue #104).
export async function getAssignedInstagramAccounts(
  accessToken: string
): Promise<{ id: string; username?: string }[]> {
  const url = new URL(`${facebookGraphBase()}/me/assigned_instagram_accounts`);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", accessToken);
  const data = await handleResponse<{ data?: { id: string; username?: string }[] }>(
    await metaFetch(accessToken, url.toString())
  );
  const accounts = data.data ?? [];
  if (!accounts.length) {
    throw new Error(
      "No Instagram account is assigned to this login. Add business_management to the Meta login configuration and connect again."
    );
  }
  return accounts;
}

// With an Instagram Login token `me` is the Instagram account, which is how
// these calls have always been made. With a Unified login token `me` is the
// system user, so the account has to be named by its ID.
function instagramNode(auth: MetaAuth, igUserId?: string): string {
  if (!isUnified(auth)) return "me";
  if (!igUserId) {
    throw new Error("A Unified login call needs the Instagram account ID");
  }
  return igUserId;
}

export async function getUserInfo(
  auth: MetaAuth,
  igUserId?: string
): Promise<InstagramUser> {
  const accessToken = tokenOf(auth);
  const node = instagramNode(auth, igUserId);
  const url = new URL(`${instagramGraphBase(auth)}/${node}`);
  url.searchParams.set(
    "fields",
    isUnified(auth)
      ? "id,username,name,profile_picture_url,followers_count"
      : "id,user_id,username,name,profile_picture_url,followers_count"
  );
  url.searchParams.set("access_token", accessToken);

  const response = await metaFetch(auth, url.toString());
  const user = await handleResponse<InstagramUser>(response);
  // On graph.facebook.com `id` already is the professional account ID, and
  // there is no user_id field to ask for.
  return isUnified(auth) ? { ...user, user_id: user.id } : user;
}

/** How long the connection check waits for Meta before it counts as no answer. */
const ACCOUNT_NODE_TIMEOUT_MS = 15_000;

/**
 * The account's own node with two fields, `id,username`: the connection
 * check's one read per account and sweep (lib/instagram/connection-check.ts),
 * the cheapest call that still needs a working token and the account's basic
 * permission. Throws Meta's error as every read does; a request that takes
 * longer than 15 seconds is aborted.
 */
export async function getAccountNode(
  auth: MetaAuth,
  igUserId?: string
): Promise<{ id: string; username?: string }> {
  const node = instagramNode(auth, igUserId);
  const url = new URL(`${instagramGraphBase(auth)}/${node}`);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", tokenOf(auth));

  return handleResponse<{ id: string; username?: string }>(
    await metaFetch(auth, url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(ACCOUNT_NODE_TIMEOUT_MS),
    })
  );
}

const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,media_url,thumbnail_url,timestamp,permalink,like_count,comments_count";

// Instagram caps a single media page at 100 items.
const MEDIA_PAGE_SIZE = 100;

export async function getUserMedia(
  auth: MetaAuth,
  limit = 25,
  igUserId?: string
): Promise<InstagramMedia[]> {
  const accessToken = tokenOf(auth);
  const node = instagramNode(auth, igUserId);
  const url = new URL(`${instagramGraphBase(auth)}/${node}/media`);
  url.searchParams.set("fields", MEDIA_FIELDS);
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("access_token", accessToken);

  const response = await metaFetch(auth, url.toString());
  const data = await handleResponse<{ data: InstagramMedia[] }>(response);
  return data.data;
}

/**
 * Fetch media by following pagination cursors until `max` items are collected
 * or there are no more pages. Pass a large `max` for an "all time" view; the
 * cap is a safety ceiling so an account with thousands of posts can't spin
 * forever (and so downstream per-media insight calls stay bounded).
 */
export async function getAllUserMedia(
  auth: MetaAuth,
  max = 500,
  igUserId?: string
): Promise<InstagramMedia[]> {
  const accessToken = tokenOf(auth);
  const results: InstagramMedia[] = [];

  const node = instagramNode(auth, igUserId);
  const first = new URL(`${instagramGraphBase(auth)}/${node}/media`);
  first.searchParams.set("fields", MEDIA_FIELDS);
  first.searchParams.set("limit", String(Math.min(MEDIA_PAGE_SIZE, max)));
  first.searchParams.set("access_token", accessToken);

  let nextUrl: string | null = first.toString();

  while (nextUrl !== null && results.length < max) {
    const response: Response = await metaFetch(auth, nextUrl);
    const page = await handleResponse<{
      data: InstagramMedia[];
      paging?: { next?: string };
    }>(response);
    results.push(...page.data);
    nextUrl = page.paging?.next ?? null;
  }

  return results.slice(0, max);
}

/**
 * Fetch per-media insight metrics (views, reach, saved, shares, etc.).
 *
 * Requires the `instagram_business_manage_insights` permission — accounts
 * connected before that scope was requested will throw a PermissionError.
 * Metric validity varies by media type, so pass only metrics that apply to
 * the given media (e.g. `views` is not valid for image posts on some accounts).
 */
export async function getMediaInsights(
  auth: MetaAuth,
  mediaId: string,
  metrics: string[]
): Promise<InstagramMediaInsights> {
  const accessToken = tokenOf(auth);
  const url = new URL(`${instagramGraphBase(auth)}/${mediaId}/insights`);
  url.searchParams.set("metric", metrics.join(","));
  url.searchParams.set("access_token", accessToken);

  const response = await metaFetch(auth, url.toString());
  const data = await handleResponse<{
    data: Array<{ name: string; values: Array<{ value: number }> }>;
  }>(response);

  const result: InstagramMediaInsights = {};
  for (const entry of data.data) {
    result[entry.name as keyof InstagramMediaInsights] =
      entry.values?.[0]?.value ?? 0;
  }
  return result;
}

/** One day of net follower change, as reported by account insights. */
export interface FollowerCountPoint {
  /** ISO date (YYYY-MM-DD) the change is attributed to. */
  date: string;
  /** Net followers gained (or lost, if negative) that day. */
  delta: number;
}

// Instagram only retains ~30 days of account insights, and rejects windows
// wider than 30 days outright. Stay just inside the limit.
const FOLLOWER_INSIGHT_MAX_DAYS = 30;

/**
 * Fetch the daily net follower change for an account.
 *
 * Requires `instagram_business_manage_insights`. Note this metric is *not*
 * universally available: Instagram omits it for accounts under 100 followers
 * and it is unsupported on some account types. Callers must treat `null` as
 * "no series available" rather than an error — see the backfill in
 * `lib/reports/follower-history.ts`.
 *
 * Returns daily deltas, not running totals. Reconstruct absolute counts by
 * anchoring on a known `followers_count` and walking backwards.
 */
export async function getFollowerCountSeries(
  auth: MetaAuth,
  instagramAccountId: string,
  days: number = FOLLOWER_INSIGHT_MAX_DAYS
): Promise<FollowerCountPoint[] | null> {
  const accessToken = tokenOf(auth);
  const span = Math.min(Math.max(days, 1), FOLLOWER_INSIGHT_MAX_DAYS);
  const until = Math.floor(Date.now() / 1000);
  const since = until - (span - 1) * 86_400;

  const url = new URL(`${instagramGraphBase(auth)}/${instagramAccountId}/insights`);
  url.searchParams.set("metric", "follower_count");
  url.searchParams.set("period", "day");
  url.searchParams.set("since", String(since));
  url.searchParams.set("until", String(until));
  url.searchParams.set("access_token", accessToken);

  try {
    const response = await metaFetch(auth, url.toString());
    const data = await handleResponse<{
      data: Array<{
        name: string;
        values: Array<{ value: number; end_time?: string }>;
      }>;
    }>(response);

    const metric = data.data.find((d) => d.name === "follower_count");
    if (!metric?.values?.length) return null;

    return metric.values.map((v) => ({
      date: (v.end_time ?? new Date().toISOString()).slice(0, 10),
      delta: v.value ?? 0,
    }));
  } catch (err) {
    // A missing permission is a real signal the caller may want to surface;
    // anything else here means the metric is simply unavailable for this
    // account, which is not worth failing the whole dashboard over.
    if (err instanceof PermissionError) throw err;
    console.warn(
      "[Instagram] follower_count insights unavailable:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// Instagram Login only: exchanges the short-lived token from the OAuth code for
// a 60-day one. A Unified login code already yields the final token.
export async function getLongLivedToken(
  shortLivedToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(`${instagramGraphBase(shortLivedToken)}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", requireEnv("INSTAGRAM_APP_SECRET"));
  url.searchParams.set("access_token", shortLivedToken);

  const response = await metaFetch(shortLivedToken, url.toString());
  const data = await handleResponse<TokenResponse>(response);

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 5184000,
  };
}

// Instagram Login only. Unified login tokens are not refreshable this way, so
// the refresh cron leaves those accounts alone.
export async function refreshLongLivedToken(
  longLivedToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(`${instagramGraphBase(longLivedToken)}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", longLivedToken);

  const response = await metaFetch(longLivedToken, url.toString());
  const data = await handleResponse<TokenResponse>(response);

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 5184000,
  };
}

export const INSTAGRAM_WEBHOOK_FIELDS = [
  "comments",
  "messages",
  "messaging_postbacks",
];

export async function subscribeInstagramAccountToWebhooks(
  instagramAccountId: string,
  auth: MetaAuth
): Promise<{ success: boolean }> {
  const accessToken = tokenOf(auth);
  const response = await metaFetch(
    auth,
    `${instagramGraphBase(auth)}/${instagramAccountId}/subscribed_apps`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        // Button taps (follow gate, opening DM) arrive only with
        // messaging_postbacks; "messages" does not include them. Read receipts
        // (messaging_seen) are left out: they only feed the opening-DM
        // fallback and would wake the database on every read.
        subscribed_fields: INSTAGRAM_WEBHOOK_FIELDS,
      }),
    }
  );

  return handleResponse(response);
}

/**
 * When a Unified login token expires, or null if it never does. The expiry is
 * set by the login configuration, so it is read from the token rather than
 * assumed. Asked with the app's own token, which debug_token accepts for any
 * token the app issued.
 */
export async function getUnifiedTokenExpiry(
  accessToken: string,
  appId: string,
  appSecret: string
): Promise<Date | null> {
  const data = (await debugToken(accessToken, `${appId}|${appSecret}`)) as {
    data?: { expires_at?: number };
  };
  const expiresAt = data.data?.expires_at;
  return expiresAt ? new Date(expiresAt * 1000) : null;
}

export async function debugToken(inputToken: string, accessToken: string) {
  const url = new URL(`${facebookGraphBase()}/debug_token`);
  url.searchParams.set("input_token", inputToken);
  url.searchParams.set("access_token", accessToken);
  const response = await metaFetch(accessToken, url.toString());
  return handleResponse(response);
}
