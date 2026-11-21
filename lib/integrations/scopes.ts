/** Client-safe constants; do not import the database into client components. */
// campaigns:read lists and reads campaigns; campaigns:write creates them.
export const CAMPAIGN_SCOPES = ["campaigns:read", "campaigns:write"] as const;

/**
 * signups:write reports a sign-up from an offer's landing page
 * (POST /api/offers/signup) and does nothing else. Such a key lives on a web
 * server, so it never carries a campaign scope as well.
 */
export const SIGNUP_SCOPE = "signups:write";

export const SERVICE_SCOPES = [...CAMPAIGN_SCOPES, SIGNUP_SCOPE] as const;

/**
 * What a key may do. The API & MCP page creates "read", "write" and
 * "signups" keys; the keys route also takes campaigns:write alone, a key that
 * only creates.
 */
export type KeyAccess = "read" | "write" | "createOnly" | "signups";

// A key that creates campaigns reads them too: get_campaign is how a client
// checks what it made.
export const ACCESS_SCOPES: Record<
  KeyAccess,
  readonly (typeof SERVICE_SCOPES)[number][]
> = {
  read: ["campaigns:read"],
  write: ["campaigns:read", "campaigns:write"],
  createOnly: ["campaigns:write"],
  signups: [SIGNUP_SCOPE],
};

const scopeSet = (scopes: readonly string[]) =>
  [...new Set(scopes)].sort().join(" ");

/**
 * The kind of a stored key by its scopes, in any order, so the key list can
 * name it as the form does. Null for any other set of scopes.
 */
export function keyAccess(scopes: readonly string[]): KeyAccess | null {
  const held = scopeSet(scopes);
  return (
    (Object.keys(ACCESS_SCOPES) as KeyAccess[]).find(
      (access) => scopeSet(ACCESS_SCOPES[access]) === held
    ) ?? null
  );
}

/**
 * Whether a key may be created with these scopes: one or both campaign
 * scopes, or the sign-up scope on its own (least privilege for the key on
 * the landing page's server).
 */
export function isAllowedScopeSet(scopes: readonly string[]): boolean {
  const held = new Set(scopes);
  if (held.size === 0) return false;
  return !held.has(SIGNUP_SCOPE) || held.size === 1;
}
