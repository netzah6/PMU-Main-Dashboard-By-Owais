"use client";
import { Navbar } from "./Navbar";
import { TabNav } from "./TabNav";

interface DashboardShellProps {
  children: React.ReactNode;
  userEmail?: string;
  syncing?: boolean;
}

export function DashboardShell({ children, userEmail, syncing }: DashboardShellProps) {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Navbar userEmail={userEmail} syncing={syncing} />
      <TabNav />
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
