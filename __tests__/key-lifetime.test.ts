/**
 * Service key lifetimes and expiry warnings (R1 item 9).
 *
 * A key that only reports sign-ups lives on a landing page's server; when it
 * expires the sign-up feedback stops and nobody notices. It may live up to a
 * year, a year by default, while campaign keys keep 30 to 90 days. Every key
 * warns on the API & MCP page and in Diagnostics from 14 days before it
 * expires, and after that while something used it in the last 30 days.
 */
import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_KEY_LIFETIME,
  KEY_EXPIRY_WARNING_DAYS,
  KEY_RECENT_USE_DAYS,
  keyExpired,
  keyExpiryBounds,
  keyExpiryWarning,
  keyLifetime,
  SIGNUP_KEY_LIFETIME,
} from "../lib/integrations/key-lifetime";
import { ACCESS_SCOPES } from "../lib/integrations/scopes";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-21T12:00:00.000Z");

function key(overrides: Partial<{ expiresAt: Date | string; revokedAt: Date | string | null; lastUsedAt: Date | string | null }> = {}) {
  return {
    expiresAt: new Date(NOW + 60 * DAY),
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

describe("key lifetimes", () => {
  it("lets a sign-up key live up to a year, a year by default", () => {
    expect(SIGNUP_KEY_LIFETIME).toMatchObject({ maxDays: 365, defaultDays: 365 });
    expect(keyLifetime(ACCESS_SCOPES.signups)).toBe(SIGNUP_KEY_LIFETIME);
    expect(keyLifetime(["signups:write", "signups:write"])).toBe(SIGNUP_KEY_LIFETIME);
  });

  it("keeps campaign keys at 90 days at most, 30 by default", () => {
    expect(CAMPAIGN_KEY_LIFETIME).toMatchObject({ maxDays: 90, defaultDays: 30 });
    for (const scopes of [ACCESS_SCOPES.read, ACCESS_SCOPES.write, ACCESS_SCOPES.createOnly, ["campaigns:write", "campaigns:read"]]) {
      expect(keyLifetime(scopes), scopes.join(" ")).toBe(CAMPAIGN_KEY_LIFETIME);
    }
    // A set the keys route refuses anyway gets no longer life either.
    expect(keyLifetime(["signups:write", "campaigns:read"])).toBe(CAMPAIGN_KEY_LIFETIME);
  });

  it("offers the default and nothing beyond the maximum", () => {
    for (const lifetime of [CAMPAIGN_KEY_LIFETIME, SIGNUP_KEY_LIFETIME]) {
      expect(lifetime.choices).toContain(lifetime.defaultDays);
      expect(Math.max(...lifetime.choices)).toBe(lifetime.maxDays);
      expect(lifetime.choices.every((days) => Number.isInteger(days) && days >= 1)).toBe(true);
    }
    expect(CAMPAIGN_KEY_LIFETIME.choices).toEqual([30, 60, 90]);
  });
});

describe("key expiry warnings", () => {
  it("warns from 14 days before a key expires", () => {
    expect(KEY_EXPIRY_WARNING_DAYS).toBe(14);
    expect(keyExpiryWarning(key({ expiresAt: new Date(NOW + 14 * DAY + 1) }), NOW)).toBeNull();
    expect(keyExpiryWarning(key({ expiresAt: new Date(NOW + 14 * DAY) }), NOW)).toBe("expiring");
    expect(keyExpiryWarning(key({ expiresAt: new Date(NOW + 1) }), NOW)).toBe("expiring");
    // Whether or not anything uses the key yet.
    expect(keyExpiryWarning(key({ expiresAt: new Date(NOW + DAY), lastUsedAt: new Date(NOW - 90 * DAY) }), NOW)).toBe("expiring");
  });

  it("counts a key as expired from its expiry on, as the service API does", () => {
    expect(keyExpired(key({ expiresAt: new Date(NOW) }), NOW)).toBe(true);
    expect(keyExpired(key({ expiresAt: new Date(NOW + 1) }), NOW)).toBe(false);
  });

  it("keeps warning after the expiry while the key was used in the last 30 days", () => {
    expect(KEY_RECENT_USE_DAYS).toBe(30);
    const expired = { expiresAt: new Date(NOW - 2 * DAY) };
    expect(keyExpiryWarning(key({ ...expired, lastUsedAt: new Date(NOW - 3 * DAY) }), NOW)).toBe("expired");
    expect(keyExpiryWarning(key({ ...expired, lastUsedAt: new Date(NOW - 30 * DAY) }), NOW)).toBe("expired");
    expect(keyExpiryWarning(key({ ...expired, lastUsedAt: new Date(NOW - 30 * DAY - 1) }), NOW)).toBeNull();
    // A key nothing ever used expires quietly.
    expect(keyExpiryWarning(key({ ...expired, lastUsedAt: null }), NOW)).toBeNull();
    // At its expiry, right after its last request.
    expect(keyExpiryWarning(key({ expiresAt: new Date(NOW), lastUsedAt: new Date(NOW - 1) }), NOW)).toBe("expired");
  });

  it("ends the warning once the key is revoked", () => {
    const revokedAt = new Date(NOW - DAY);
    expect(keyExpiryWarning(key({ expiresAt: new Date(NOW + DAY), revokedAt }), NOW)).toBeNull();
    expect(keyExpiryWarning(key({ expiresAt: new Date(NOW - DAY), lastUsedAt: new Date(NOW - DAY), revokedAt }), NOW)).toBeNull();
  });

  it("reads the dates of a JSON response as well", () => {
    expect(keyExpiryWarning(key({ expiresAt: new Date(NOW + DAY).toISOString() }), NOW)).toBe("expiring");
    expect(
      keyExpiryWarning(key({ expiresAt: new Date(NOW - DAY).toISOString(), lastUsedAt: new Date(NOW - 2 * DAY).toISOString() }), NOW)
    ).toBe("expired");
  });

  it("gives a database query the same bounds", () => {
    const { expiresBy, usedSince } = keyExpiryBounds(NOW);
    expect(expiresBy.getTime()).toBe(NOW + 14 * DAY);
    expect(usedSince.getTime()).toBe(NOW - 30 * DAY);
    expect(keyExpiryWarning(key({ expiresAt: expiresBy }), NOW)).toBe("expiring");
    expect(keyExpiryWarning(key({ expiresAt: new Date(NOW - DAY), lastUsedAt: usedSince }), NOW)).toBe("expired");
  });
});
