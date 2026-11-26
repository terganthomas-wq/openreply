/**
 * A messaging silence (A2) as the dashboard shows it: the banner on every
 * page, the account on the settings page and Diagnostics, next to A1's lost
 * connection (lib/instagram/connection-incident.ts).
 *
 * The worker's check (lib/instagram/messaging-silence-check.ts) records an
 * open silence on the InstagramAccount row (messagingSilentSince), and the
 * last one that ended as JSON (messagingSilenceResult). This module turns a
 * row into what the pages need and reads the stored result back.
 *
 * Client-safe: no database, queue or Meta import.
 */

import { readLostTapResult, type LostTapResult } from "@/lib/instagram/lost-tap-state";

/** An open silence of one account, as the pages get it. */
export interface MessagingSilenceIncident {
  accountId: string;
  username: string;
  /** ISO time since when no button tap, DM, read receipt or reaction arrived. */
  since: string;
}

/** The fields of an InstagramAccount row (or its JSON) that tell a silence. */
export interface MessagingSilenceFields {
  id: string;
  username: string;
  messagingSilentSince?: Date | string | null;
  /** A1: while the connection itself is lost, that is what to show. */
  connectionLostAt?: Date | string | null;
}

/**
 * The account's open silence, or null while messaging events arrive. Also
 * null while the account's connection is lost (A1): the lost connection
 * explains it, and its banner says what to do.
 */
export function messagingSilenceOf(
  account: MessagingSilenceFields
): MessagingSilenceIncident | null {
  if (!account.messagingSilentSince || account.connectionLostAt) return null;
  const since = new Date(account.messagingSilentSince);
  if (Number.isNaN(since.getTime())) return null;
  return { accountId: account.id, username: account.username, since: since.toISOString() };
}

/** How the last silence ended: an inbound event at the webhook route, or the check found one. */
export type MessagingSilenceEnd = "webhook" | "check";

/**
 * The last silence that ended, as messagingSilenceResult stores it. The
 * search for lost taps after it (A2 requirement 4,
 * lib/instagram/lost-tap-search.ts) adds its result once it has finished;
 * whatever this version does not know is left out when read.
 */
export interface MessagingSilenceResult {
  v: 1;
  /** Since when nothing arrived (the incident's messagingSilentSince), ISO. */
  since: string;
  /** When it ended: the time of the inbound event that ended it, ISO. */
  endedAt: string;
  via: MessagingSilenceEnd;
  /** The search for lost taps, once it has finished. */
  taps?: LostTapResult;
}

/** How long Diagnostics shows the last silence after it ended. */
export const MESSAGING_SILENCE_REPORT_MS = 7 * 24 * 60 * 60_000;

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** The stored result, or null for none or one this version cannot read. */
export function readMessagingSilenceResult(value: unknown): MessagingSilenceResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || !isTime(raw.since) || !isTime(raw.endedAt)) return null;
  const taps = readLostTapResult(raw.taps);
  return {
    v: 1,
    since: raw.since,
    endedAt: raw.endedAt,
    via: raw.via === "webhook" ? "webhook" : "check",
    ...(taps ? { taps } : {}),
  };
}

/** One account's last silence, as Diagnostics gets it. */
export interface MessagingSilenceReport {
  accountId: string;
  username: string;
  since: string;
  endedAt: string;
  /** The search for its lost taps is owed or running. */
  searching: boolean;
  /** What that search found, once it has finished; null before (or for an older silence). */
  taps: LostTapResult | null;
}

/**
 * The accounts whose last silence ended within 7 days, in the given order,
 * with the search for its lost taps.
 */
export function messagingSilenceReports(
  accounts: readonly {
    id: string;
    username: string;
    messagingSilentSince?: Date | null;
    messagingSilenceResult?: unknown;
    messagingTapSearchFrom?: Date | null;
  }[],
  now: number = Date.now()
): MessagingSilenceReport[] {
  return accounts.flatMap((account): MessagingSilenceReport[] => {
    // While a new silence is open, that is what to show.
    if (account.messagingSilentSince) return [];
    const result = readMessagingSilenceResult(account.messagingSilenceResult);
    if (!result || now - Date.parse(result.endedAt) > MESSAGING_SILENCE_REPORT_MS) return [];
    return [
      {
        accountId: account.id,
        username: account.username,
        since: result.since,
        endedAt: result.endedAt,
        searching: Boolean(account.messagingTapSearchFrom),
        taps: result.taps ?? null,
      },
    ];
  });
}
