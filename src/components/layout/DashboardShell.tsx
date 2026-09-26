"use client";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Navbar } from "./Navbar";
import { TabNav, pathAllowedFor, homeFor } from "./TabNav";
import { FetchActivity } from "./FetchActivity";
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
    if (!loading && !allowed) router.replace(homeFor(role));
  }, [loading, allowed, role, router]);
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
    // h-screen is 100vh, which on a phone is the LARGE viewport — the height
    // the page would have if the browser's toolbars were gone. They aren't, so
    // the shell hung off the bottom of the screen, the page itself started
    // scrolling behind the bar and the tabs, and the bottom of every page sat
    // under the browser chrome ("fix the phone view on side", 2026-09-26).
    // 100dvh is the height actually on screen; the h-screen class stays as the
    // fallback for browsers that don't know dvh (an unparsable inline value is
    // dropped and the class wins), and on desktop the two are the same number.
    <div className="flex flex-col h-screen overflow-hidden" style={{ height: "100dvh" }}>
      <Navbar userEmail={userEmail} syncing={syncing} sticky={false} />
      <TabNav />
      <FetchActivity />
      {/* overflow-x-hidden: pages must never scroll sideways into dead space —
          wide tables scroll inside their own overflow-x-auto containers.
          min-h-0: a flex child refuses to shrink under its content unless it
          is told it may, and a long page must not be able to push the tab row
          off the top. In-page `sticky top-0` headers stick to THIS box, which
          is why the bar and the tabs have to stay outside it. */}
      <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <RoleGate>{children}</RoleGate>
      </main>
    </div>
  );
}
