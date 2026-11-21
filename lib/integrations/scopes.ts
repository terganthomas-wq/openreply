/** Client-safe constants; do not import the database into client components. */
// campaigns:read lists and reads campaigns; campaigns:write creates them.
export const SERVICE_SCOPES = ["campaigns:read", "campaigns:write"] as const;

/**
 * What a key may do. The API & MCP page creates "read" and "write" keys; the
 * keys route also takes campaigns:write alone, a key that only creates.
 */
export type KeyAccess = "read" | "write" | "createOnly";

// A key that creates campaigns reads them too: get_campaign is how a client
// checks what it made.
export const ACCESS_SCOPES: Record<
  KeyAccess,
  readonly (typeof SERVICE_SCOPES)[number][]
> = {
  read: ["campaigns:read"],
  write: ["campaigns:read", "campaigns:write"],
  createOnly: ["campaigns:write"],
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
