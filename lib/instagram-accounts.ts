import { prisma } from "@/lib/db/client";

export async function canConnectInstagramAccount({
  workspaceId,
  instagramId,
}: {
  workspaceId: string;
  instagramId: string;
}) {
  const existingAccount = await prisma.instagramAccount.findUnique({
    where: { instagramId },
    select: { workspaceId: true, provider: true },
  });

  if (existingAccount && (existingAccount.workspaceId !== workspaceId || existingAccount.provider === "ZERNIO")) {
    return {
      allowed: false,
      reason: "already_connected" as const,
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

export async function getWorkspaceInstagramAccount(
  workspaceId: string,
  instagramAccountId?: string | null
) {
  if (instagramAccountId && instagramAccountId !== "all") {
    return prisma.instagramAccount.findFirst({
      where: { id: instagramAccountId, workspaceId },
    });
  }

  return prisma.instagramAccount.findFirst({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
  });
}

/**
 * The account a page that works through Meta only (the Kommentare page)
 * opens with: the one asked for, or else the workspace's newest account
 * connected through Meta, and the newest of any kind when there is none (the
 * page then says why it cannot work with it).
 */
export async function getWorkspaceMetaAccount(
  workspaceId: string,
  instagramAccountId?: string | null
) {
  if (instagramAccountId && instagramAccountId !== "all") {
    return getWorkspaceInstagramAccount(workspaceId, instagramAccountId);
  }
  return (
    (await prisma.instagramAccount.findFirst({
      where: { workspaceId, provider: "META" },
      orderBy: { connectedAt: "desc" },
    })) ?? getWorkspaceInstagramAccount(workspaceId)
  );
}
