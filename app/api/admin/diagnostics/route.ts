import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import { readAccountPauses } from "@/lib/queue/account-pause";
import { keyExpiryBounds, keyExpiryWarning } from "@/lib/integrations/key-lifetime";
import { eventDetail } from "@/lib/ops/event-details";
import {
  connectionLostCode,
  connectionLostKind,
} from "@/lib/instagram/connection-incident";
import { connectionCatchUpReports } from "@/lib/instagram/catch-up-report";
import {
  messagingSilenceOf,
  messagingSilenceReports,
} from "@/lib/instagram/messaging-silence-incident";
import { getWorkerAlerts, getWorkerHealth } from "@/lib/ops/worker-health";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const runtime = "nodejs";

export async function GET() {
  // Open to every member of the workspace; the role only decides what the
  // key notice asks of the reader.
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  const { workspaceId } = context;

  // Service keys that need a new one: expiring within 14 days, or expired
  // although something used them within 30 (lib/integrations/key-lifetime.ts).
  const now = Date.now();
  const { expiresBy, usedSince } = keyExpiryBounds(now);

  const [
    queueCounts,
    workerHealth,
    workerAlerts,
    webhookFailures,
    dmFailures,
    tokenRefreshFailures,
    operationalEvents,
    accounts,
    expiringKeys,
  ] = await Promise.all([
    getDMQueue().getJobCounts("waiting", "active", "delayed", "failed"),
    getWorkerHealth(),
    getWorkerAlerts(10),
    prisma.webhookEvent.findMany({
      where: { workspaceId, status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        object: true,
        errorMessage: true,
        createdAt: true,
        processedAt: true,
      },
    }),
    prisma.dmLog.findMany({
      where: {
        workspaceId,
        status: {
          in: [
            "FAILED",
            "SKIPPED_RATE_LIMIT",
            "SKIPPED_PLAN_LIMIT",
            "SKIPPED_NO_MATCH",
          ],
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        status: true,
        commentId: true,
        commentText: true,
        errorMessage: true,
        updatedAt: true,
        automation: { select: { name: true } },
      },
    }),
    prisma.operationalEvent.findMany({
      where: { workspaceId, source: "TOKEN_REFRESH", level: "ERROR" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        message: true,
        createdAt: true,
        payload: true,
      },
    }),
    prisma.operationalEvent.findMany({
      where: {
        OR: [{ workspaceId }, { workspaceId: null }],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        source: true,
        level: true,
        message: true,
        createdAt: true,
        resolvedAt: true,
        payload: true,
      },
    }),
    prisma.instagramAccount.findMany({
      where: { workspaceId },
      select: {
        id: true,
        instagramId: true,
        username: true,
        connectionLostAt: true,
        connectionLostReason: true,
        connectionAlertSentAt: true,
        connectionAlertCount: true,
        connectionCatchUpFrom: true,
        connectionCatchUpResult: true,
        messagingSilentSince: true,
        messagingAlertSentAt: true,
        messagingAlertCount: true,
        messagingSilenceResult: true,
        messagingTapSearchFrom: true,
      },
    }),
    prisma.serviceKey.findMany({
      where: {
        workspaceId,
        revokedAt: null,
        OR: [
          { expiresAt: { gt: new Date(now), lte: expiresBy } },
          { expiresAt: { lte: new Date(now) }, lastUsedAt: { gte: usedSince } },
        ],
      },
      orderBy: { expiresAt: "asc" },
      take: 20,
      select: {
        id: true,
        name: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    }),
  ]);
  // Accounts whose sending is paused for a Meta request limit, until when
  // and how many jobs wait for it (lib/queue/account-pause.ts).
  const accountPauses = await readAccountPauses(accounts);
  // A1: accounts whose connection Meta dropped (lib/instagram/connection-check.ts),
  // since when, why, and whether the owners got an e-mail about it.
  const connectionIncidents = accounts
    .filter((account) => account.connectionLostAt)
    .map((account) => ({
      username: account.username,
      since: account.connectionLostAt!.toISOString(),
      reason: connectionLostKind(account.connectionLostReason),
      code: connectionLostCode(account.connectionLostReason),
      // Only an e-mail about this incident: the time stays from earlier ones.
      alertSentAt:
        account.connectionAlertCount > 0 && account.connectionAlertSentAt
          ? account.connectionAlertSentAt.toISOString()
          : null,
    }));
  // A1: the catch-up after an incident, while it runs and for 7 days after:
  // how many comments it queued, and the comments the owner had answered by
  // hand, which got no automatic DM.
  const connectionCatchUps = connectionCatchUpReports(accounts, now);
  // A2: accounts whose button taps, DMs and read receipts no longer arrive
  // (lib/instagram/messaging-silence-check.ts), since when, and whether the
  // owners got an e-mail about it; and the last silence of each account for
  // 7 days after it ended, with the search for its lost taps (running, or
  // what it found: handles, campaign names and times, never an id).
  const messagingSilences = accounts.flatMap((account) => {
    const silence = messagingSilenceOf(account);
    return silence
      ? [
          {
            username: silence.username,
            since: silence.since,
            // Only an e-mail about this silence: the time stays from earlier ones.
            alertSentAt:
              account.messagingAlertCount > 0 && account.messagingAlertSentAt
                ? account.messagingAlertSentAt.toISOString()
                : null,
          },
        ]
      : [];
  });
  const endedMessagingSilences = messagingSilenceReports(accounts, now);
  // The keys by the same rule as the API & MCP page; when they were last
  // used stays on the server.
  const keyWarnings = expiringKeys.flatMap((key) => {
    const warning = keyExpiryWarning(key, now);
    return warning
      ? [
          {
            id: key.id,
            name: key.name,
            scopes: key.scopes,
            expiresAt: key.expiresAt,
            warning,
          },
        ]
      : [];
  });

  return NextResponse.json({
    success: true,
    data: {
      queueCounts,
      workerHealth,
      workerAlerts,
      webhookFailures,
      dmFailures,
      tokenRefreshFailures,
      // The payload stays on the server: only what Diagnostics needs to
      // show an event in the reader's language leaves it.
      operationalEvents: operationalEvents.map(({ payload, ...event }) => ({
        ...event,
        detail: eventDetail(payload),
      })),
      accountPauses,
      connectionIncidents,
      connectionCatchUps,
      messagingSilences,
      endedMessagingSilences,
      keyWarnings,
      // Only owners and admins create and revoke keys (the keys route
      // refuses everyone else), and only they can reconnect an account: a
      // member is asked to have one of them do it.
      canManageKeys: canManageWorkspace(context.role),
      canReconnect: canManageWorkspace(context.role),
    },
  });
}
