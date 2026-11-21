import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import { readAccountPauses } from "@/lib/queue/account-pause";
import { keyExpiryBounds, keyExpiryWarning } from "@/lib/integrations/key-lifetime";
import { eventDetail } from "@/lib/ops/event-details";
import { getWorkerAlerts, getWorkerHealth } from "@/lib/ops/worker-health";

export const runtime = "nodejs";

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

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
      select: { instagramId: true, username: true },
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
      keyWarnings,
    },
  });
}
