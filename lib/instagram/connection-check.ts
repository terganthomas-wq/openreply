/**
 * The connection check (A1): notice when Meta has dropped the app's access
 * to a connected Instagram account.
 *
 * Seen live on 2026-11-25: after the account was linked with Facebook, Meta
 * took the app's Instagram permissions away. Every read of the account failed
 * with 100/33 ("Object with ID … does not exist, cannot be loaded due to
 * missing permissions"), no webhook arrived, /api/health and the worker
 * stayed green, the settings page kept saying "Verbunden", and nobody noticed
 * for four hours.
 *
 * With every comment sweep (COMMENT_POLL_INTERVAL_MS, worker/dm-worker.ts)
 * the worker reads each connected account's own node once
 * (`/{ig-id}?fields=id,username`, `me` for an Instagram Login token): one
 * cheap call per account and sweep, also for an account without an active
 * campaign, and none at all while the account is paused for a Meta limit
 * (R1, lib/queue/account-pause.ts). Accounts connected through Zernio have
 * no Meta token and are not checked. The answer counts as:
 * - lost: a token error (190, 102, 463, 467), a permission error (10,
 *   200–299), or 100 with subcode 33 on the account's own node;
 * - inconclusive: a request limit (R1's codes), a network error or timeout,
 *   a 5xx, any other code, a token that cannot be decrypted. Neither a strike
 *   nor a success: it changes nothing;
 * - ok: the read went through.
 *
 * Two lost checks at least one sweep interval apart open an incident (the
 * second may come up to a tenth of the interval early, at most 5 minutes, so
 * timer drift or the sweep right after a restart cannot push the incident to
 * the third check). connectionLostAt is the time of the first one: from then
 * on the connection was seen lost. The incident is never opened while the
 * account is paused. The owners and admins get an e-mail
 * (lib/ops/connection-alert.ts), and the dashboard, Diagnostics and
 * /api/health show it. One check that gets through ends it, and so does a
 * reconnect (app/api/instagram/callback/route.ts): clearConnectionIncident
 * (lib/instagram/connection-state.ts), which keeps the incident's start for
 * the catch-up of the missed comments.
 *
 * Every write is conditional on the state it was decided on, so a check and
 * a reconnect at the same moment never undo each other.
 */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  formatConnectionLostReason,
  type ConnectionLostKind,
} from "@/lib/instagram/connection-incident";
import { createInstagramContext } from "@/lib/instagram/context";
import { clearConnectionIncident } from "@/lib/instagram/connection-state";
import { getAccountNode, MetaApiError } from "@/lib/meta/client";
import { isMetaLimitCode } from "@/lib/meta/limits";
import { sendConnectionAlert } from "@/lib/ops/connection-alert";
import { CONNECTION_LOST_EVENT } from "@/lib/ops/event-details";
import { checkAccountPause } from "@/lib/queue/account-pause";
import { formatError, logWorkerEvent } from "@/lib/queue/send-helpers";

/** The sweep's interval without COMMENT_POLL_INTERVAL_MS (worker/dm-worker.ts). */
export const DEFAULT_COMMENT_POLL_INTERVAL_MS = 5 * 60_000;

/** Token errors: Meta no longer accepts the token. */
const TOKEN_ERROR_CODES: readonly number[] = [190, 102, 463, 467];

export type ConnectionCheckResult =
  | { outcome: "ok" }
  | {
      outcome: "lost";
      kind: Exclude<ConnectionLostKind, "unknown">;
      /** As stored in connectionLostReason. */
      reason: string;
    }
  | { outcome: "inconclusive"; detail: string };

/**
 * What a failed read of the account's own node says about the connection.
 * Only Meta's own refusals of the token, of a permission or of the account
 * count as lost; everything that may pass on its own does not.
 */
export function classifyConnectionError(error: unknown): ConnectionCheckResult {
  if (!(error instanceof MetaApiError)) {
    return {
      outcome: "inconclusive",
      detail: error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    };
  }
  const code = error.code;
  // Meta leaves the subcode out, or (rarely) sends null.
  const subcode = typeof error.subcode === "number" ? error.subcode : undefined;
  const meta = `Meta ${code}${subcode === undefined ? "" : `/${subcode}`}`;
  // A request limit says nothing about the connection (R1 pauses for it).
  if (isMetaLimitCode(code)) {
    return { outcome: "inconclusive", detail: `request limit (${meta})` };
  }
  const kind = TOKEN_ERROR_CODES.includes(code)
    ? "token"
    : code === 10 || (code >= 200 && code <= 299)
      ? "permission"
      : code === 100 && subcode === 33
        ? "missing"
        : null;
  if (!kind) return { outcome: "inconclusive", detail: meta };
  return {
    outcome: "lost",
    kind,
    reason: formatConnectionLostReason(kind, code, subcode),
  };
}

/** The part of the account row the two strikes are decided on. */
export interface ConnectionState {
  connectionCheckFailedAt: Date | null;
  connectionLostAt: Date | null;
}

export type ConnectionStep =
  /** Nothing to write. */
  | { kind: "none" }
  /** The first lost check: remember it. */
  | { kind: "strike" }
  /** A second lost check, far enough after the first: the incident begins. */
  | { kind: "start"; lostAt: Date }
  /** The incident goes on; the reminder may be due. */
  | { kind: "still-lost" }
  /** A check got through after one lost check: forget it. */
  | { kind: "clear-strike" }
  /** A check got through during an incident: it ends. */
  | { kind: "recover"; lostAt: Date };

/**
 * The second lost check opens an incident when it comes at least this long
 * after the first: the sweep's interval, less a tenth of it (at most five
 * minutes) for timer drift and the sweep 10 seconds after a start.
 */
export function connectionStrikeGapMs(intervalMs: number): number {
  const interval =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : DEFAULT_COMMENT_POLL_INTERVAL_MS;
  return interval - Math.min(interval / 10, 5 * 60_000);
}

/** What one check's result does to the account's state. */
export function nextConnectionStep(
  state: ConnectionState,
  result: ConnectionCheckResult,
  now: number,
  strikeGapMs: number
): ConnectionStep {
  if (result.outcome === "inconclusive") return { kind: "none" };
  if (result.outcome === "ok") {
    if (state.connectionLostAt) {
      return { kind: "recover", lostAt: state.connectionLostAt };
    }
    return state.connectionCheckFailedAt ? { kind: "clear-strike" } : { kind: "none" };
  }
  if (state.connectionLostAt) return { kind: "still-lost" };
  const first = state.connectionCheckFailedAt;
  if (!first) return { kind: "strike" };
  return now - first.getTime() >= strikeGapMs
    ? { kind: "start", lostAt: first }
    : { kind: "none" };
}

const ACCOUNT_SELECT = {
  id: true,
  workspaceId: true,
  instagramId: true,
  username: true,
  provider: true,
  metaLogin: true,
  accessToken: true,
  zernioAccountId: true,
  connectionCheckFailedAt: true,
  connectionLostAt: true,
  connectionLostReason: true,
  connectionAlertSentAt: true,
  connectionAlertCount: true,
  connectionAllClearSentAt: true,
  connectionAlertRearmedAt: true,
} satisfies Prisma.InstagramAccountSelect;

export type CheckedAccount = Prisma.InstagramAccountGetPayload<{
  select: typeof ACCOUNT_SELECT;
}>;

/** One read of the account's own node, and what it says. */
export async function readConnection(
  account: CheckedAccount
): Promise<ConnectionCheckResult> {
  let context;
  try {
    context = await createInstagramContext(account);
  } catch (error) {
    // The token could not be decrypted: this installation's problem, which
    // a reconnect would not fix, not Meta's.
    return {
      outcome: "inconclusive",
      detail: `token could not be read: ${formatError(error)}`,
    };
  }
  if (context.provider !== "META") {
    return { outcome: "inconclusive", detail: "not connected through Meta" };
  }
  try {
    await getAccountNode(context, account.instagramId);
    return { outcome: "ok" };
  } catch (error) {
    return classifyConnectionError(error);
  }
}

export type AccountCheckOutcome =
  | "ok"
  | "paused"
  | "inconclusive"
  | "strike"
  | "lost"
  | "recovered";

/** One account: read its node, apply the result, e-mail when one is due. */
export async function checkAccountConnection(
  account: CheckedAccount,
  {
    strikeGapMs,
    clock = Date.now,
  }: { strikeGapMs: number; clock?: () => number }
): Promise<AccountCheckOutcome> {
  // No call while the account is paused for a Meta limit: it would only
  // keep the limit going, and its answer would say nothing.
  if ((await checkAccountPause(account.instagramId, clock())) !== null) {
    return "paused";
  }

  const result = await readConnection(account);
  const now = clock();
  const step = nextConnectionStep(account, result, now, strikeGapMs);
  const name = `@${account.username}`;

  switch (step.kind) {
    case "none":
      if (result.outcome === "inconclusive") {
        console.log(`[Connection check] ${name}: no answer that counts (${result.detail})`);
        return "inconclusive";
      }
      return result.outcome === "ok" ? "ok" : "strike";

    case "strike": {
      await prisma.instagramAccount.updateMany({
        where: {
          id: account.id,
          connectionLostAt: null,
          connectionCheckFailedAt: null,
        },
        data: { connectionCheckFailedAt: new Date(now) },
      });
      console.warn(
        `[Connection check] ${name}: Meta refused the account (${result.outcome === "lost" ? result.reason : "?"}); the next check decides`
      );
      return "strike";
    }

    case "clear-strike":
      await prisma.instagramAccount.updateMany({
        where: {
          id: account.id,
          connectionLostAt: null,
          connectionCheckFailedAt: account.connectionCheckFailedAt,
        },
        data: { connectionCheckFailedAt: null },
      });
      return "ok";

    case "start": {
      if (result.outcome !== "lost") return "inconclusive";
      // Never while a pause is on, should one have begun during the read.
      if ((await checkAccountPause(account.instagramId, now)) !== null) {
        return "paused";
      }
      const started = await prisma.instagramAccount.updateMany({
        where: {
          id: account.id,
          connectionLostAt: null,
          connectionCheckFailedAt: step.lostAt,
        },
        data: {
          connectionLostAt: step.lostAt,
          connectionLostReason: result.reason,
          connectionAlertCount: 0,
        },
      });
      if (started.count !== 1) return "inconclusive";
      await logWorkerEvent({
        workspaceId: account.workspaceId,
        level: "WARNING",
        message: `Instagram connection lost for ${name} since ${step.lostAt.toISOString()} (${result.reason}): no comment DMs, button replies or public replies until it is reconnected`,
        payload: {
          kind: CONNECTION_LOST_EVENT,
          instagramAccountId: account.instagramId,
          account: account.username,
          lostAt: step.lostAt.toISOString(),
          reason: result.reason,
        },
      });
      await sendConnectionAlert(
        {
          ...account,
          connectionLostAt: step.lostAt,
          connectionLostReason: result.reason,
          connectionAlertCount: 0,
        },
        { now }
      );
      return "lost";
    }

    case "still-lost":
      await sendConnectionAlert(account, { now });
      return "lost";

    case "recover":
      await clearConnectionIncident(account.id, { via: "check", now });
      return "recovered";
  }
}

export interface ConnectionCheckSummary {
  accounts: number;
  outcomes: Partial<Record<AccountCheckOutcome | "error", number>>;
}

/**
 * The worker's check of every account connected through Meta, one after
 * the other, with every comment sweep. An account that fails to be checked
 * (the database, say) is logged and skipped; the others are still checked.
 */
export async function checkInstagramConnections({
  intervalMs = DEFAULT_COMMENT_POLL_INTERVAL_MS,
  clock = Date.now,
}: { intervalMs?: number; clock?: () => number } = {}): Promise<ConnectionCheckSummary> {
  const accounts = await prisma.instagramAccount.findMany({
    where: { provider: "META", accessToken: { not: "" } },
    select: ACCOUNT_SELECT,
    orderBy: { connectedAt: "asc" },
  });
  const strikeGapMs = connectionStrikeGapMs(intervalMs);
  const summary: ConnectionCheckSummary = { accounts: accounts.length, outcomes: {} };
  for (const account of accounts) {
    let outcome: AccountCheckOutcome | "error";
    try {
      outcome = await checkAccountConnection(account, { strikeGapMs, clock });
    } catch (error) {
      outcome = "error";
      console.error(
        `[Connection check] @${account.username} could not be checked:`,
        formatError(error)
      );
    }
    summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
  }
  return summary;
}
