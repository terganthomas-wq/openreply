import { I18nProvider } from "@/lib/i18n/provider";
import { getI18n } from "@/lib/i18n/server";
import { redirect } from "next/navigation";
import DashboardShell from "@/components/dashboard-shell";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";
import { canManageWorkspace } from "@/lib/workspace-access";
import {
  connectionIncidentOf,
  type ConnectionIncident,
} from "@/lib/instagram/connection-incident";
import {
  messagingSilenceOf,
  type MessagingSilenceIncident,
} from "@/lib/instagram/messaging-silence-incident";

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
      // The incident fields feed the banners about a lost connection (A1)
      // and about missing messaging events (A2).
      select: {
        id: true,
        username: true,
        connectionLostAt: true,
        connectionLostReason: true,
        messagingSilentSince: true,
      },
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

  // Accounts whose connection Meta dropped: a banner above every page with
  // "Neu verbinden". The layout renders on a full page load (the reconnect
  // ends with one), not on every navigation within the dashboard.
  const connectionIncidents = accounts
    .map(connectionIncidentOf)
    .filter((incident): incident is ConnectionIncident => incident !== null);
  // Accounts whose button taps, DMs and read receipts no longer arrive (A2),
  // unless their connection is lost: that banner already covers them.
  const messagingSilences = accounts
    .map(messagingSilenceOf)
    .filter((silence): silence is MessagingSilenceIncident => silence !== null);

  return (
    <I18nProvider locale={locale}>
      <DashboardShell
        workspaceName={workspace.name}
        instagramUsername={accounts[0]?.username ?? null}
        instagramAccountCount={accounts.length}
        canManage={canManageWorkspace(membership?.role ?? "OWNER")}
        connectionIncidents={connectionIncidents}
        messagingSilences={messagingSilences}
      >
        {children}
      </DashboardShell>
    </I18nProvider>
  );
}
