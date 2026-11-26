import { I18nProvider } from "@/lib/i18n/provider";
import { getI18n } from "@/lib/i18n/server";
import { redirect } from "next/navigation";
import DashboardShell from "@/components/dashboard-shell";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";
import { canManageWorkspace } from "@/lib/workspace-access";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: t("OpenReply - Open source Instagram comment-to-DM automation") };
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { locale } = await getI18n();
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const workspace = await ensureWorkspaceForUser(
    session.user.id,
    session.user.email
  );
  const [accounts, membership] = await Promise.all([
    prisma.instagramAccount.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { connectedAt: "desc" },
      select: { username: true },
    }),
    // The menu leaves out what only owners and admins can use. Without a
    // membership row the user is the workspace's owner, as everywhere else
    // (lib/workspace-access.ts).
    prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: session.user.id },
      },
      select: { role: true },
    }),
  ]);

  return (
    <I18nProvider locale={locale}>
      <DashboardShell
        workspaceName={workspace.name}
        instagramUsername={accounts[0]?.username ?? null}
        instagramAccountCount={accounts.length}
        canManage={canManageWorkspace(membership?.role ?? "OWNER")}
      >
        {children}
      </DashboardShell>
    </I18nProvider>
  );
}
