/**
 * The messaging silence check (A2): notice when Instagram stops passing on
 * what people do in their DMs, while comments still arrive.
 *
 * Seen live on 2026-11-25/26 (lib/instagram/messaging-silence-signal.ts): for
 * 21 hours every button tap after the first DM was lost, and nothing in the
 * app noticed it. With every comment sweep (COMMENT_POLL_INTERVAL_MS,
 * worker/dm-worker.ts) the worker now judges each account connected through
 * Meta from the database alone, without a single Meta call:
 * - the opening DMs it sent (SENT DmLog rows of a comment, of campaigns whose
 *   DM has a button, not the links a tap delivered), with their send time;
 * - the inbound messaging events that arrived for it (WebhookEvent rows whose
 *   payload has a button tap, a DM that is not an echo, a read receipt or a
 *   reaction for the account, in `messaging` or `standby`).
 * The judgment and its thresholds are in messaging-silence-signal.ts.
 *
 * No judgment while the account's connection is lost (an A1 incident: no
 * webhook arrives at all) or in doubt (A1's first failed check, until the
 * next one decides), while it is paused for a Meta limit (R1), or while it
 * has no active campaign whose DM has a button: such a check changes
 * nothing. Two silent checks in a row, at least one sweep interval apart (A1's
 * gap, connectionStrikeGapMs), open an incident: messagingSilentSince is the
 * time of the last inbound messaging event before it (or the first unanswered
 * opening DM when none arrived in the last 7 days). The owners and admins get
 * an e-mail (lib/ops/messaging-silence-alert.ts), and the dashboard,
 * Diagnostics and /api/health show it. One inbound messaging event ends it:
 * the webhook route at once (lib/instagram/messaging-silence-state.ts), or
 * else the next check, which looks for one first, whatever else holds.
 *
 * Every write is conditional on the state it was decided on, so a check and
 * the webhook route at the same moment never undo each other.
 */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  connectionStrikeGapMs,
  DEFAULT_COMMENT_POLL_INTERVAL_MS,
} from "@/lib/instagram/connection-check";
import {
  INBOUND_LOOKBACK_MS,
  judgeMessagingSilence,
  messagingSilenceThresholds,
  nextSilenceStep,
  silenceDmBounds,
  type MessagingSilenceThresholds,
  type OpeningDm,
} from "@/lib/instagram/messaging-silence-signal";
import { endMessagingSilence } from "@/lib/instagram/messaging-silence-state";
import { inboundMessagingAccountIds } from "@/lib/meta/webhook";
import { MESSAGING_SILENT_EVENT } from "@/lib/ops/event-details";
import type { MailTransport } from "@/lib/ops/mail";
import {
  sendMessagingSilenceAlert,
  sendMessagingSilenceAllClear,
} from "@/lib/ops/messaging-silence-alert";
import { checkAccountPause } from "@/lib/queue/account-pause";
import { formatError, logWorkerEvent } from "@/lib/queue/send-helpers";

// Messaging events are read newest first, a page at a time, until the first
// one that counts. Rows that only look like one (the account's own actions)
// are skipped; after this many the check gives up for this sweep.
const INBOUND_PAGE_SIZE = 50;
const INBOUND_MAX_PAGES = 20;
// Opening DMs read per check, the newest first: far more than any account
// sends in a window, and enough people either way.
const MAX_OPENING_DMS = 2_000;

const ACCOUNT_SELECT = {
  id: true,
  workspaceId: true,
  instagramId: true,
  username: true,
  connectionCheckFailedAt: true,
  connectionLostAt: true,
  connectionRecoveredAt: true,
  messagingSilenceCheckAt: true,
  messagingSilentSince: true,
  messagingAlertSentAt: true,
  messagingAlertCount: true,
  messagingAlertRearmedAt: true,
  messagingAllClearSentAt: true,
  messagingAllClearDueAt: true,
} satisfies Prisma.InstagramAccountSelect;

export type SilenceAccount = Prisma.InstagramAccountGetPayload<{
  select: typeof ACCOUNT_SELECT;
}>;

type StoredPayload = Parameters<typeof inboundMessagingAccountIds>[0];

/**
 * The newest inbound messaging event for the account that arrived after
 * `after` and at the latest at `until` (its WebhookEvent's createdAt), or
 * null for none. `complete` is false when the look gave up early (see above).
 * The database narrows the rows to the account's payloads with `messaging`
 * or `standby` items; what counts is decided here, by the same rule as the
 * webhook route's (inboundMessagingAccountIds).
 */
export async function latestInboundMessagingAt(
  instagramId: string,
  { after, until }: { after: Date; until: Date }
): Promise<{ at: Date | null; complete: boolean }> {
  for (let page = 0; page < INBOUND_MAX_PAGES; page++) {
    const rows = await prisma.webhookEvent.findMany({
      where: {
        createdAt: { gt: after, lte: until },
        OR: [
          { payload: { path: ["entry"], array_contains: [{ id: instagramId, messaging: [] }] } },
          { payload: { path: ["entry"], array_contains: [{ id: instagramId, standby: [] }] } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: page * INBOUND_PAGE_SIZE,
      take: INBOUND_PAGE_SIZE,
      select: { createdAt: true, payload: true },
    });
    for (const row of rows) {
      if (inboundMessagingAccountIds(row.payload as unknown as StoredPayload).includes(instagramId)) {
        return { at: row.createdAt, complete: true };
      }
    }
    if (rows.length < INBOUND_PAGE_SIZE) return { at: null, complete: true };
  }
  return { at: null, complete: false };
}

/**
 * The account's campaigns whose DM has a button (an opening DM): the ones
 * whose DMs count, and whether one of them is active.
 */
async function openingDmCampaigns(accountId: string) {
  const campaigns = await prisma.automation.findMany({
    where: { instagramAccountId: accountId, openingDmEnabled: true },
    select: { id: true, isActive: true, openingDmMessage: true, openingDmButtonLabel: true },
  });
  // As the worker decides whether a comment gets the opening DM
  // (lib/queue/dm-worker.ts, useOpeningDm).
  const opening = campaigns.filter(
    (campaign) => Boolean(campaign.openingDmMessage) && Boolean(campaign.openingDmButtonLabel)
  );
  return {
    ids: opening.map((campaign) => campaign.id),
    active: opening.some((campaign) => campaign.isActive),
  };
}

/**
 * The opening DMs the account sent within the bounds, newest first: SENT
 * rows of a comment (not "reveal:" or "dm:" rows, which a tap or a DM
 * brought), of the given campaigns, whose delivery is confirmed.
 */
export async function openingDmsFor(
  accountId: string,
  campaignIds: readonly string[],
  { after, until }: { after: Date; until: Date }
): Promise<OpeningDm[]> {
  if (campaignIds.length === 0 || until.getTime() <= after.getTime()) return [];
  const rows = await prisma.dmLog.findMany({
    where: {
      instagramAccountId: accountId,
      automationId: { in: [...campaignIds] },
      status: "SENT",
      dmDeliveryUnconfirmed: false,
      dmSentAt: { gt: after, lte: until },
      NOT: [{ commentId: { startsWith: "reveal:" } }, { commentId: { startsWith: "dm:" } }],
    },
    orderBy: { dmSentAt: "desc" },
    take: MAX_OPENING_DMS,
    select: { commenterId: true, dmSentAt: true },
  });
  return rows.flatMap((row) =>
    row.dmSentAt ? [{ recipientId: row.commenterId, sentAt: row.dmSentAt }] : []
  );
}

export type SilenceOutcome =
  /** Judged: messaging events arrive (or too few people to tell). */
  | "quiet"
  /** No judgment: no active campaign whose DM has a button. */
  | "no-campaign"
  /** No judgment: the account's connection is lost or in doubt (A1). */
  | "connection-lost"
  /** No judgment: the account is paused for a Meta limit (R1). */
  | "paused"
  /** No judgment: the events could not all be read, or the state changed meanwhile. */
  | "inconclusive"
  /** The first silent check: the next one decides. */
  | "strike"
  /** The second silent check: the incident opened. */
  | "opened"
  /** The incident goes on. */
  | "silent"
  /** An inbound messaging event ended the incident. */
  | "ended";

interface CheckOptions {
  thresholds: MessagingSilenceThresholds;
  strikeGapMs: number;
  now: number;
  transport?: MailTransport | null;
  env?: Record<string, string | undefined>;
}

/** One account: look, judge, write, e-mail when one is due. */
export async function checkAccountMessagingSilence(
  account: SilenceAccount,
  { thresholds, strikeGapMs, now, transport, env }: CheckOptions
): Promise<SilenceOutcome> {
  const name = `@${account.username}`;
  const mail = {
    now,
    ...(transport !== undefined ? { transport } : {}),
    ...(env ? { env } : {}),
  };

  // An open silence ends with any inbound event since it began, whatever
  // else holds: that is evidence, not a judgment.
  const openSince = account.messagingSilentSince;
  if (openSince) {
    const latest = await latestInboundMessagingAt(account.instagramId, {
      after: openSince,
      until: new Date(now),
    });
    if (latest.at) {
      await endMessagingSilence(account.id, { via: "check", at: latest.at });
      return "ended";
    }
  }

  // No judgment while no webhook arrives at all (A1), also while its check
  // has seen the connection refused once and the next one decides, or while
  // Meta's limit pauses the account (R1).
  if (account.connectionLostAt || account.connectionCheckFailedAt) return "connection-lost";
  if ((await checkAccountPause(account.instagramId, now)) !== null) return "paused";

  // The silence goes on: the reminder may be due.
  if (openSince) {
    await sendMessagingSilenceAlert(account, mail);
    return "silent";
  }

  const campaigns = await openingDmCampaigns(account.id);
  if (!campaigns.active) return "no-campaign";

  const bounds = silenceDmBounds(now, thresholds, account.connectionRecoveredAt);
  const dms = await openingDmsFor(account.id, campaigns.ids, bounds);
  // Only with enough people is the newest inbound event worth a read.
  let lastInboundAt: Date | null = null;
  if (new Set(dms.map((dm) => dm.recipientId)).size >= thresholds.minPeople) {
    const latest = await latestInboundMessagingAt(account.instagramId, {
      after: new Date(now - INBOUND_LOOKBACK_MS),
      until: new Date(now),
    });
    if (!latest.complete) {
      console.log(`[Messaging silence] ${name}: too many messaging events to read, no judgment`);
      return "inconclusive";
    }
    lastInboundAt = latest.at;
  }
  const judgment = judgeMessagingSilence({
    dms,
    lastInboundAt,
    bounds,
    minPeople: thresholds.minPeople,
  });
  const step = nextSilenceStep(account, judgment, now, strikeGapMs);

  switch (step.kind) {
    case "none":
      return judgment.silent ? "strike" : "quiet";

    case "strike":
      await prisma.instagramAccount.updateMany({
        where: { id: account.id, messagingSilentSince: null, messagingSilenceCheckAt: null },
        data: { messagingSilenceCheckAt: new Date(now) },
      });
      console.warn(
        `[Messaging silence] ${name}: ${judgment.people} people got their opening DM and nothing came back since; the next check decides`
      );
      return "strike";

    case "clear-strike":
      await prisma.instagramAccount.updateMany({
        where: {
          id: account.id,
          messagingSilentSince: null,
          messagingSilenceCheckAt: account.messagingSilenceCheckAt,
        },
        data: { messagingSilenceCheckAt: null },
      });
      return "quiet";

    case "still-silent":
      return "silent";

    case "open": {
      if (!judgment.silent) return "quiet";
      // Never while a pause is on, should one have begun meanwhile.
      if ((await checkAccountPause(account.instagramId, now)) !== null) return "paused";
      const since = lastInboundAt ?? judgment.firstDmAt;
      // Nor once A1's check saw the connection refused meanwhile.
      const opened = await prisma.instagramAccount.updateMany({
        where: {
          id: account.id,
          messagingSilentSince: null,
          messagingSilenceCheckAt: account.messagingSilenceCheckAt,
          connectionLostAt: null,
          connectionCheckFailedAt: null,
        },
        data: { messagingSilentSince: since, messagingAlertCount: 0 },
      });
      if (opened.count !== 1) return "inconclusive";
      await logWorkerEvent({
        workspaceId: account.workspaceId,
        level: "WARNING",
        message: `Instagram passes on no button taps, DMs or read receipts for ${name} since ${since.toISOString()}: ${judgment.people} people got their opening DM (the first at ${judgment.firstDmAt.toISOString()}) and nothing came back; taps on its button are lost until it passes them on again`,
        payload: {
          kind: MESSAGING_SILENT_EVENT,
          instagramAccountId: account.instagramId,
          account: account.username,
          since: since.toISOString(),
          firstDmAt: judgment.firstDmAt.toISOString(),
          people: judgment.people,
        },
      });
      await sendMessagingSilenceAlert(
        { ...account, messagingSilentSince: since, messagingAlertCount: 0 },
        mail
      );
      return "opened";
    }
  }
}

let warnedThresholds = false;

// One WARNING per process start for thresholds that were not taken as
// written: it shows in every workspace's Diagnostics.
async function warnAdjustedThresholds(notes: readonly string[]): Promise<void> {
  if (warnedThresholds || notes.length === 0) return;
  warnedThresholds = true;
  const message = `Messaging silence check: ${notes.join("; ")}`;
  console.warn(`[Messaging silence] ${message}`);
  await logWorkerEvent({ workspaceId: null, level: "WARNING", message });
}

/** Tests: forget that the thresholds warning was recorded in this process. */
export function resetMessagingSilenceWarnings(): void {
  warnedThresholds = false;
}

export interface SilenceCheckSummary {
  accounts: number;
  outcomes: Partial<Record<SilenceOutcome | "error", number>>;
  /** All-clear e-mails that went out. */
  mailed: number;
}

/**
 * The worker's look at every account connected through Meta, one after the
 * other, with every comment sweep; then the all-clear of a silence that
 * ended, if one is owed. An account that fails (the database, say) is logged
 * and skipped; the others are still looked at.
 */
export async function checkMessagingSilences({
  intervalMs = DEFAULT_COMMENT_POLL_INTERVAL_MS,
  clock = Date.now,
  env = process.env,
  transport,
}: {
  intervalMs?: number;
  clock?: () => number;
  env?: Record<string, string | undefined>;
  /** The e-mails' transport (tests); the worker's from its settings by default. */
  transport?: MailTransport | null;
} = {}): Promise<SilenceCheckSummary> {
  const { thresholds, notes } = messagingSilenceThresholds(env);
  await warnAdjustedThresholds(notes);
  const accounts = await prisma.instagramAccount.findMany({
    where: { provider: "META", accessToken: { not: "" } },
    select: ACCOUNT_SELECT,
    orderBy: { connectedAt: "asc" },
  });
  const strikeGapMs = connectionStrikeGapMs(intervalMs);
  const summary: SilenceCheckSummary = { accounts: accounts.length, outcomes: {}, mailed: 0 };
  for (const account of accounts) {
    let outcome: SilenceOutcome | "error";
    try {
      outcome = await checkAccountMessagingSilence(account, {
        thresholds,
        strikeGapMs,
        now: clock(),
        transport,
        env,
      });
    } catch (error) {
      outcome = "error";
      console.error(
        `[Messaging silence] @${account.username} could not be checked:`,
        formatError(error)
      );
    }
    summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;

    if (account.messagingAllClearDueAt || outcome === "ended") {
      try {
        const sent = await sendMessagingSilenceAllClear(account.id, {
          now: clock(),
          ...(transport !== undefined ? { transport } : {}),
          env,
        });
        if (sent === "sent") summary.mailed += 1;
      } catch (error) {
        console.error(
          `[Messaging silence] @${account.username}: the all-clear could not be sent:`,
          formatError(error)
        );
      }
    }
  }
  return summary;
}
