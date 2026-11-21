/**
 * The Contacts list's query rules, shared by the page and the API, so both
 * agree on what a search is. Client-safe: no database import.
 */

/** Shorter searches list everyone: one letter would match almost every name. */
export const CONTACT_SEARCH_MIN_LENGTH = 2;
/** Handles are at most 30 characters, IGSIDs about 17 digits. */
const CONTACT_SEARCH_MAX_LENGTH = 100;

export const CONTACTS_PAGE_SIZE = 20;
export const CONTACTS_MAX_PAGE_SIZE = 50;

/**
 * The term the list is filtered by, or "" for no filter. People write a
 * handle with its @, which is not part of the stored username.
 */
export function contactSearchTerm(raw: string | null | undefined): string {
  const term = (raw ?? "")
    .trim()
    .replace(/^@+/, "")
    .trim()
    .slice(0, CONTACT_SEARCH_MAX_LENGTH);
  return Array.from(term).length >= CONTACT_SEARCH_MIN_LENGTH ? term : "";
}

/** A whole number of at least 1 from a query parameter, else the fallback. */
export function positiveIntParam(raw: string | null, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}
