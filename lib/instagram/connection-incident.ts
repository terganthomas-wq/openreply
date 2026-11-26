/**
 * A lost Instagram connection (A1) as the dashboard shows it: the banner on
 * every page, the account on the settings page, Diagnostics and the
 * Kommentare page.
 *
 * The worker's check (lib/instagram/connection-check.ts) records an incident
 * on the InstagramAccount row: since when (connectionLostAt) and why
 * (connectionLostReason). This module reads the reason back and turns a row
 * into what the pages need.
 *
 * Client-safe: no database, queue or Meta import.
 */

import type { StaticMessageKey } from "@/lib/i18n";

/**
 * Why a connection counts as lost:
 * - token: Meta no longer accepts the token (190, 102, 463, 467);
 * - permission: the token lacks a permission for the account (10, 200–299);
 * - missing: Meta no longer finds the account for the app (100 with
 *   subcode 33), as after linking Instagram with Facebook on 2026-11-25;
 * - unknown: a stored reason this version cannot read.
 */
export type ConnectionLostKind = "token" | "permission" | "missing" | "unknown";

const KNOWN_KINDS = ["token", "permission", "missing"] as const;

/**
 * The reason as stored: "<kind> (Meta <code>/<subcode>)", for example
 * "missing (Meta 100/33)". Short, and never a token or a Meta message.
 */
export function formatConnectionLostReason(
  kind: Exclude<ConnectionLostKind, "unknown">,
  code: number,
  subcode?: number
): string {
  return `${kind} (Meta ${code}${subcode === undefined ? "" : `/${subcode}`})`;
}

/** The kind of a stored reason; "unknown" for anything else. */
export function connectionLostKind(
  reason: string | null | undefined
): ConnectionLostKind {
  const word = /^([a-z]+)\b/.exec(reason ?? "")?.[1];
  return KNOWN_KINDS.find((kind) => kind === word) ?? "unknown";
}

/** Meta's code in a stored reason ("Meta 100/33"), or null. */
export function connectionLostCode(
  reason: string | null | undefined
): string | null {
  return /\((Meta [0-9]+(?:\/[0-9]+)?)\)/.exec(reason ?? "")?.[1] ?? null;
}

/** The reason in the reader's words (the settings page and the banner). */
export const CONNECTION_LOST_REASON_TEXT = {
  token:
    "Meta no longer accepts OpenReply's access to this account, for example after a password or security change.",
  permission:
    "OpenReply is missing permissions for this account, for example because the app was removed under “Apps and websites”.",
  missing:
    "Meta no longer gives OpenReply access to this account, for example after Instagram was linked to or unlinked from Facebook, or after a change in your business portfolio.",
  unknown: "Meta refuses OpenReply's access to this account.",
} as const satisfies Record<ConnectionLostKind, StaticMessageKey>;

/** An open incident of one account, as the pages get it. */
export interface ConnectionIncident {
  accountId: string;
  username: string;
  /** ISO time since when the connection is lost: its first failed check. */
  since: string;
  reason: ConnectionLostKind;
}

/** The fields of an InstagramAccount row (or its JSON) that tell an incident. */
export interface ConnectionIncidentFields {
  id: string;
  username: string;
  connectionLostAt?: Date | string | null;
  connectionLostReason?: string | null;
}

/** The account's open incident, or null while its connection works. */
export function connectionIncidentOf(
  account: ConnectionIncidentFields
): ConnectionIncident | null {
  if (!account.connectionLostAt) return null;
  const since = new Date(account.connectionLostAt);
  if (Number.isNaN(since.getTime())) return null;
  return {
    accountId: account.id,
    username: account.username,
    since: since.toISOString(),
    reason: connectionLostKind(account.connectionLostReason),
  };
}

/**
 * "25.11.2026, 18:45": when an incident began, in the reader's language and
 * time zone. Only for pages that render it in the browser.
 */
export function formatIncidentTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * "Neu verbinden": the same Meta login as "Connect using your own Meta app".
 * The callback updates the existing account and ends the incident.
 */
export const RECONNECT_URL = "/api/instagram/connect";
