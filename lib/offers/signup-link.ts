/**
 * The personal code an offer's link carries to the landing page (sign-up
 * feedback): its format, where it goes in the address, and where the landing
 * page reports the sign-up. Client-safe: no database, crypto or queue import,
 * so the offer editor shows the same address the API serves.
 */

/** The query parameter the landing page reads the code from. */
export const SIGNUP_LINK_PARAM = "ig";

/** Where the landing page's server reports a sign-up (app/api/offers/signup). */
export const SIGNUP_CALLBACK_PATH = "/api/offers/signup";

/**
 * A code is 18 random bytes in base64url: 24 characters, 144 bits, nothing
 * to escape in a URL. Neither a recipient token (?r=, 22 characters) nor a
 * service key (orp_…) has this shape.
 */
export const SIGNUP_TOKEN_BYTES = 18;
export const SIGNUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{24}$/;

/** The code when `value` has the code's shape, else null. */
export function parseSignupToken(value: unknown): string | null {
  return typeof value === "string" && SIGNUP_TOKEN_PATTERN.test(value)
    ? value
    : null;
}

/**
 * The offer's destination with the person's code added as ig=<code>. The
 * rest of the address stays as typed: the other query parameters keep their
 * order and their exact encoding (URLSearchParams would write them anew, a
 * space as "+", a slash as %2F), the fragment stays, and an ig the link
 * already carried is replaced. Throws for a destination that is no URL.
 */
export function withSignupToken(destination: string, token: string): string {
  const url = new URL(destination);
  const kept = url.search
    .slice(1)
    .split("&")
    .filter(
      (pair) => pair !== "" && parameterName(pair) !== SIGNUP_LINK_PARAM
    );
  url.search = [...kept, `${SIGNUP_LINK_PARAM}=${token}`].join("&");
  return url.href;
}

// A parameter's name as URLSearchParams reads it: "+" is a space and escapes
// are decoded, so "i%67=…" is an ig as well.
function parameterName(pair: string): string {
  const raw = pair.split("=", 1)[0].replace(/\+/g, " ");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
