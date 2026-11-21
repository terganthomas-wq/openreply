/** Client-safe constants; do not import the database into client components. */
// campaigns:read lists and reads campaigns; campaigns:write creates them.
export const SERVICE_SCOPES = ["campaigns:read", "campaigns:write"] as const;
