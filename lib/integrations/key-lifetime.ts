/**
 * How long a service key lives, and when the API & MCP page and Diagnostics
 * warn that one runs out. Client-safe: no database import.
 *
 * A key that only reports sign-ups (signups:write alone) sits on a landing
 * page's server, where nobody looks at it: once it expires the sign-up
 * feedback stops without anyone noticing. Such a key may therefore live up
 * to a year, and gets a year unless its creator picks less. Campaign keys
 * keep their 30 to 90 days.
 */

import { keyAccess } from "./scopes";

const DAY_MS = 86_400_000;

export interface KeyLifetime {
  /** The longest lifetime the keys route accepts, in whole days. */
  maxDays: number;
  /** What a new key gets when the request names no lifetime. */
  defaultDays: number;
  /** The lifetimes the API & MCP page offers, the default among them. */
  choices: readonly number[];
}

export const CAMPAIGN_KEY_LIFETIME: KeyLifetime = {
  maxDays: 90,
  defaultDays: 30,
  choices: [30, 60, 90],
};

export const SIGNUP_KEY_LIFETIME: KeyLifetime = {
  maxDays: 365,
  defaultDays: 365,
  choices: [90, 180, 365],
};

/**
 * The lifetime rules for a key with these scopes, in any order: the sign-up
 * key's for signups:write alone, the campaign keys' for everything else.
 */
export function keyLifetime(scopes: readonly string[]): KeyLifetime {
  return keyAccess(scopes) === "signups"
    ? SIGNUP_KEY_LIFETIME
    : CAMPAIGN_KEY_LIFETIME;
}

/**
 * The lifetime the API & MCP page's form shows once its access changes from
 * one kind of key to another: the chosen one while both kinds follow the
 * same rules (read-only and read-and-write keys share them), otherwise the
 * new kind's default, a year for a sign-up key.
 */
export function lifetimeAfterAccessChange(
  days: number,
  from: readonly string[],
  to: readonly string[]
): number {
  const next = keyLifetime(to);
  return keyLifetime(from) === next && next.choices.includes(days)
    ? days
    : next.defaultDays;
}

/** From this many days before a key expires, the page and Diagnostics warn. */
export const KEY_EXPIRY_WARNING_DAYS = 14;

/**
 * An expired key still warns while something used it within this many days:
 * that client is refused now. Only successful requests count as a use
 * (ServiceKey.lastUsedAt), so the warning ends at the latest this long after
 * the key expired.
 */
export const KEY_RECENT_USE_DAYS = 30;

/** "expiring": within KEY_EXPIRY_WARNING_DAYS. "expired": expired, used lately. */
export type KeyExpiryWarning = "expiring" | "expired";

export interface KeyExpiryFields {
  expiresAt: Date | string;
  revokedAt: Date | string | null;
  lastUsedAt: Date | string | null;
}

/**
 * The times keyExpiryWarning compares with, for a database query that finds
 * the same keys: a key expiring by `expiresBy`, or expired and used since
 * `usedSince`.
 */
export function keyExpiryBounds(now: number = Date.now()): {
  expiresBy: Date;
  usedSince: Date;
} {
  return {
    expiresBy: new Date(now + KEY_EXPIRY_WARNING_DAYS * DAY_MS),
    usedSince: new Date(now - KEY_RECENT_USE_DAYS * DAY_MS),
  };
}

/** Whether the key has expired: the service API refuses it from then on. */
export function keyExpired(
  key: Pick<KeyExpiryFields, "expiresAt">,
  now: number = Date.now()
): boolean {
  return new Date(key.expiresAt).getTime() <= now;
}

/**
 * Whether a key needs a new one: it expires within KEY_EXPIRY_WARNING_DAYS,
 * or it has expired although something used it within KEY_RECENT_USE_DAYS.
 * A revoked key never warns, so revoking the old key after replacing it
 * ends the warning.
 */
export function keyExpiryWarning(
  key: KeyExpiryFields,
  now: number = Date.now()
): KeyExpiryWarning | null {
  if (key.revokedAt) return null;
  const { expiresBy, usedSince } = keyExpiryBounds(now);
  const expiresAt = new Date(key.expiresAt).getTime();
  if (!keyExpired(key, now)) {
    return expiresAt <= expiresBy.getTime() ? "expiring" : null;
  }
  const lastUsedAt = key.lastUsedAt ? new Date(key.lastUsedAt).getTime() : null;
  return lastUsedAt !== null && lastUsedAt >= usedSince.getTime()
    ? "expired"
    : null;
}
