import { SIGNUP_CALLBACK_PATH } from "@/lib/offers/signup-link";

export interface MessageTrackedLink {
  slug: string;
  destinationUrl: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;

function trimTrailingPunctuation(url: string) {
  return url.replace(/[.,!?;:]+$/, "");
}

export function extractFirstUrl(message: string): string | null {
  const match = message.match(URL_PATTERN);
  if (!match) return null;

  try {
    const url = trimTrailingPunctuation(match[0]);
    return new URL(url).toString();
  } catch {
    return null;
  }
}

export function replaceUrlWithTrackedPlaceholder(
  message: string,
  destinationUrl: string | null | undefined
) {
  if (!destinationUrl) return message;
  if (message.includes(destinationUrl)) {
    return message.replace(destinationUrl, "{link}");
  }

  const withoutTrailingSlash = destinationUrl.replace(/\/$/, "");
  return message.replace(withoutTrailingSlash, "{link}");
}

/**
 * Personalize {username} and strip the {link} token — used when the link is
 * delivered as a separate button rather than inline in the message text.
 *
 * Without a name, {username} becomes `fallbackName`. Campaign messages keep
 * the English "there". Offer messages pass "", so a German text never gets an
 * English word; the token then takes its surrounding spaces along and leaves
 * one only where it stood between two words: "Hey {username} schau" reads
 * "Hey schau", not "Hey  schau", and "Hey {username}, schau" reads
 * "Hey, schau". The rest of the text keeps its spacing.
 */
export function renderMessageWithoutLink({
  message,
  commenterName,
  fallbackName = "there",
}: {
  message: string;
  commenterName?: string | null;
  fallbackName?: string;
}) {
  const name = commenterName ?? fallbackName;
  const personalized =
    name || fallbackName
      ? message.replace(/\{username\}/gi, name)
      : message.replace(
          /([ \t]*)\{username\}([ \t]*)/gi,
          (_token, before: string, after: string) =>
            before && after ? " " : ""
        );
  return personalized.replace(/\s*\{link\}\s*/gi, " ").trim();
}

// The web app's origin: the page's own in the browser, NEXTAUTH_URL on the
// server. The web app and the worker get the same NEXTAUTH_URL, so links the
// worker sends point at the app that serves them.
function resolveBaseUrl(baseUrl?: string) {
  const resolvedBaseUrl =
    baseUrl ??
    (typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXTAUTH_URL ?? "http://localhost:3000");
  return resolvedBaseUrl.replace(/\/$/, "");
}

export function buildTrackedUrl(
  slug: string,
  baseUrl?: string,
  recipientToken?: string
) {
  const url = `${resolveBaseUrl(baseUrl)}/r/${slug}`;
  return recipientToken ? `${url}?r=${recipientToken}` : url;
}

/**
 * The link behind an offer's card and reminder buttons: the offer's own
 * redirect, not a campaign's tracked link, so campaign click counts keep
 * their meaning and deleting a campaign never breaks a card already sent.
 * The recipient token is what lets a click tag the contact.
 */
export function buildOfferUrl(
  slug: string,
  recipientToken?: string,
  baseUrl?: string
) {
  const url = `${resolveBaseUrl(baseUrl)}/o/${slug}`;
  return recipientToken ? `${url}?r=${recipientToken}` : url;
}

/**
 * Where an offer's landing page reports a sign-up (POST, server to server).
 * On the server it is NEXTAUTH_URL's, the address the offer links go out
 * with, whatever address the dashboard was opened at.
 */
export function buildSignupCallbackUrl(baseUrl?: string) {
  return `${resolveBaseUrl(baseUrl)}${SIGNUP_CALLBACK_PATH}`;
}

export function renderMessageWithTracking({
  message,
  commenterName,
  trackedLinks,
  baseUrl,
  recipientToken,
}: {
  message: string;
  commenterName?: string | null;
  trackedLinks?: MessageTrackedLink[];
  baseUrl?: string;
  recipientToken?: string;
}) {
  let rendered = message.replace(/\{username\}/gi, commenterName ?? "there");
  const primaryLink = trackedLinks?.[0];

  if (!primaryLink) return rendered;

  const trackedUrl = buildTrackedUrl(primaryLink.slug, baseUrl, recipientToken);

  if (/\{link\}/i.test(rendered)) {
    return rendered.replace(/\{link\}/gi, trackedUrl);
  }

  if (rendered.includes(primaryLink.destinationUrl)) {
    rendered = rendered.replaceAll(primaryLink.destinationUrl, trackedUrl);
  } else {
    const withoutTrailingSlash = primaryLink.destinationUrl.replace(/\/$/, "");
    rendered = rendered.replaceAll(withoutTrailingSlash, trackedUrl);
  }

  return rendered;
}
