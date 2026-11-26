/**
 * The catch-up after a lost Instagram connection (A1) as Diagnostics shows
 * it (app/api/admin/diagnostics/route.ts, components/connection-catch-up.tsx):
 * while it runs, and for 7 days after it finished, how many comments got
 * their DM queued and which comments the owner had answered by hand, which
 * got none automatically.
 *
 * Client-safe: no database, queue or Meta import.
 */

import {
  CATCH_UP_REPORT_MS,
  readCatchUpResult,
  type OwnerAnsweredComment,
} from "@/lib/instagram/catch-up-state";

/** One account's catch-up, as the page gets it. */
export interface CatchUpReport {
  accountId: string;
  username: string;
  /** The catch-up of the account's last incident is owed or running. */
  running: boolean;
  /** The last finished catch-up, if it finished within the last 7 days. */
  last: {
    lostAt: string;
    recoveredAt: string;
    finishedAt: string;
    queued: number;
    ownerAnswered: OwnerAnsweredComment[];
    ownerAnsweredTotal: number;
    /** Nothing was left out for a cap, a failed read or time. */
    complete: boolean;
  } | null;
}

/** The fields of an InstagramAccount row the report is made of. */
export interface CatchUpReportFields {
  id: string;
  username: string;
  connectionLostAt: Date | null;
  connectionCatchUpFrom: Date | null;
  connectionCatchUpResult: unknown;
}

/** The accounts with a catch-up to show, in the given order. */
export function connectionCatchUpReports(
  accounts: readonly CatchUpReportFields[],
  now: number = Date.now()
): CatchUpReport[] {
  return accounts.flatMap((account): CatchUpReport[] => {
    // While a new incident is open, the incident itself is what to show.
    const running = Boolean(account.connectionCatchUpFrom) && !account.connectionLostAt;
    const result = readCatchUpResult(account.connectionCatchUpResult);
    const recent =
      result !== null && now - Date.parse(result.finishedAt) <= CATCH_UP_REPORT_MS;
    if (!running && !recent) return [];
    return [
      {
        accountId: account.id,
        username: account.username,
        running,
        last:
          recent && result
            ? {
                lostAt: result.lostAt,
                recoveredAt: result.recoveredAt,
                finishedAt: result.finishedAt,
                queued: result.queued,
                ownerAnswered: result.ownerAnswered,
                ownerAnsweredTotal: result.ownerAnsweredTotal,
                complete: result.complete,
              }
            : null,
      },
    ];
  });
}
