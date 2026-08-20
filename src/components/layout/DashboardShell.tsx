"use client";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Navbar } from "./Navbar";
import { TabNav, pathAllowedFor } from "./TabNav";
import { useUser } from "@/lib/hooks/useUser";

// Role enforcement lives HERE, not in middleware. A per-request role lookup
// in middleware is what caused the 2026-08-15 sitewide timeout — this way the
// role is fetched once per browser session (useUser) and checked on each
// client-side navigation. Content stays hidden until the role is known so a
// restricted page never flashes. Sensitive APIs still re-check server-side.
function RoleGate({ children }: { children: React.ReactNode }) {
  const { role, loading } = useUser();
  const pathname = usePathname();
  const router = useRouter();
  const allowed = pathAllowedFor(role, pathname);
  useEffect(() => {
    if (!loading && !allowed) router.replace("/clients");
  }, [loading, allowed, router]);
  if (loading || !allowed) return null;
  return <>{children}</>;
}

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
        <RoleGate>{children}</RoleGate>
      </main>
    </div>
  );
}
