"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "@/components/sidebar";
import TopBar from "@/components/top-bar";
import { ConnectionIncidentBanner } from "@/components/connection-incident";
import { MessagingSilenceBanner } from "@/components/messaging-silence";
import { pruneInboxCopies } from "@/lib/inbox/copies";
import type { ConnectionIncident } from "@/lib/instagram/connection-incident";
import type { MessagingSilenceIncident } from "@/lib/instagram/messaging-silence-incident";

interface DashboardShellProps {
  children: React.ReactNode;
  workspaceName: string;
  instagramUsername: string | null;
  instagramAccountCount: number;
  /** Owner or admin: sees the pages only they can use. */
  canManage: boolean;
  /** Accounts whose connection Meta dropped (A1): the banner above every page. */
  connectionIncidents?: readonly ConnectionIncident[];
  /** Accounts whose button taps, DMs and read receipts do not arrive (A2): a banner too. */
  messagingSilences?: readonly MessagingSilenceIncident[];
}

export default function DashboardShell({
  children,
  workspaceName,
  instagramUsername,
  instagramAccountCount,
  canManage,
  connectionIncidents = [],
  messagingSilences = [],
}: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  // Every dashboard page, when it opens (the layout keeps this shell mounted
  // and it renders again with the new path): the Inbox's browser copies older
  // than a minute go, so DM texts read there do not stay in the tab after the
  // Inbox is left (lib/inbox/copies.ts).
  useEffect(() => {
    pruneInboxCopies();
  }, [pathname]);

  return (
    // h-dvh, not h-screen: on mobile browsers the URL bar eats into 100vh, which
    // would push the composer and pagination controls below the fold.
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        workspaceName={workspaceName}
        canManage={canManage}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          onMenuClick={() => setSidebarOpen(true)}
          instagramUsername={instagramUsername}
          instagramAccountCount={instagramAccountCount}
        />

        {/* overflow-x-hidden: enabling vertical scrolling makes the browser
            allow horizontal scrolling too, which lets a wide child drag the
            whole page sideways on a phone. */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          {/* The first thing on every page while a connection is lost, and
              it scrolls away with the page: fixed above it, it would take
              a third of a phone's screen. */}
          <ConnectionIncidentBanner
            incidents={connectionIncidents}
            canManage={canManage}
          />
          <MessagingSilenceBanner silences={messagingSilences} canManage={canManage} />
          <div className="px-4 lg:px-8 py-5 sm:py-6 max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
