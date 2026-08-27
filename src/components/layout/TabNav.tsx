"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useUser } from "@/lib/hooks/useUser";
import type { UserRole } from "@/lib/types";

// `collapsed` tabs stay off the bar behind a "⋯ More" toggle — their data
// already shows on the Clients tab, but the pages stay reachable for manual
// digging (user request 2026-08-27).
type Tab = { label: string; href: string; adminOnly?: boolean; collapsed?: boolean };

const TABS: Tab[] = [
  // Hidden from the menu (page still exists at /overview): Overview
  { label: "👥 Clients", href: "/clients" },
  { label: "📈 Performance", href: "/performance" },
  { label: "💰 Cost / Deposit", href: "/cost-per-deposit" },
  { label: "💵 Deposits", href: "/deposits" },
  { label: "📅 Bookings", href: "/bookings", collapsed: true },
  { label: "🧲 Leads", href: "/leads", collapsed: true },
  { label: "📞 Calls", href: "/calls", collapsed: true },
  { label: "✅ Tasks", href: "/tasks" },
  // Hidden from the menu (page still exists at /reply): AI Replies — merged into the AI chat
  // Hidden from the menu (page still exists at /agreements) — user request 2026-08-21
  // { label: "📝 Agreements", href: "/agreements" },
  // Hidden from the menu (pages still exist): CPL 7 Days, CPL 14 Days, Budget
  { label: "💎 LTV", href: "/ltv", adminOnly: true }, // admins only
  { label: "🔄 Subscriptions", href: "/subscriptions", adminOnly: true }, // Square billing — admins only
  { label: "🛡️ Chargebacks", href: "/chargebacks", adminOnly: true }, // Square disputes + evidence prep — admins only
  { label: "🧾 PPS Billing", href: "/v3-billing", adminOnly: true }, // pay-per-show tracking — admins only
  { label: "💼 Team", href: "/sales", adminOnly: true }, // sales-team salary tracking: closer demo checker + coach tracker
  { label: "🚀 Onboarding", href: "/onboarding" }, // setup checklist + Check Setup — whole team runs their own checks
  { label: "🧪 Funnels", href: "/funnels", adminOnly: true }, // one-box funnels on Vercel — existence, health, leads/bookings
  { label: "🧹 Cleanup", href: "/cleanup", adminOnly: true }, // offboarded sub-account wipe + pool recycling — admins only
  { label: "👑 CEO", href: "/ceo", adminOnly: true }, // offboarded sub-account wipe + pool recycling — admins only
  { label: "🕵️ Logs", href: "/activity", adminOnly: true }, // team-member change log
  { label: "📣 Blast", href: "/blast", adminOnly: true }, // text blasts — human-confirmed, admins only
  { label: "🗺️ Map", href: "/map" },
  { label: "🤖 AI", href: "/ask" },
  { label: "📊 Reports", href: "/reports" },
];

// A VA sees only these two. The real enforcement is in src/middleware.ts —
// this just keeps the tab bar honest about what they can reach.
const VA_TABS = new Set(["/clients", "/onboarding"]);

// Which pages each role may actually OPEN. Hiding a tab is not access
// control — RoleGate in DashboardShell calls this on every navigation and
// bounces a disallowed URL to /clients. Kept next to TABS so the tab list
// and the gate can never disagree.
export function pathAllowedFor(role: UserRole | null, pathname: string): boolean {
  const hit = TABS.find((t) => pathname === t.href || pathname.startsWith(t.href + "/"));
  // A Virtual Assistant gets a strict allowlist: their two tabs and nothing else.
  if (role === "va") return !!hit && VA_TABS.has(hit.href);
  // Pages outside the tab list guard themselves (/settings is admin-gated).
  if (!hit) return true;
  return !hit.adminOnly || role === "admin";
}

export function TabNav() {
  const pathname = usePathname();
  const { role } = useUser();
  const tabs = TABS.filter((t) =>
    role === "va" ? VA_TABS.has(t.href) : !t.adminOnly || role === "admin"
  );

  const isActive = (t: Tab) => pathname === t.href || pathname.startsWith(t.href + "/");
  const collapsedTabs = tabs.filter((t) => t.collapsed);
  // Being ON one of the hidden pages keeps the group visible — otherwise the
  // active tab would have no highlight anywhere on the bar.
  const onCollapsed = collapsedTabs.some(isActive);
  const [moreOpen, setMoreOpen] = useState(false);
  const showCollapsed = moreOpen || onCollapsed;

  const linkCls = (active: boolean) => cn(
    "px-4 py-3 text-sm font-semibold whitespace-nowrap border-b-2 transition-colors tracking-tight",
    active
      ? "border-[#15B7AE] text-[#0e8f88]"
      : "border-transparent text-[#34568a] hover:text-[#0e8f88] hover:border-[#d7e0ea]"
  );

  // Build the bar: collapsed tabs render in place when shown; when hidden, a
  // single "⋯ More" chip stands where the group was.
  const items: React.ReactNode[] = [];
  let toggleRendered = false;
  for (const tab of tabs) {
    if (tab.collapsed && !showCollapsed) {
      if (!toggleRendered) {
        toggleRendered = true;
        items.push(
          <button key="more" onClick={() => setMoreOpen(true)}
            title={`Show ${collapsedTabs.map((t) => t.label.replace(/^\S+\s/, "")).join(", ")}`}
            className={linkCls(false)}>
            ⋯ More
          </button>
        );
      }
      continue;
    }
    items.push(
      <Link key={tab.href} href={tab.href} className={linkCls(isActive(tab))}>
        {tab.label}
      </Link>
    );
    // Close chip right after the group (only when it CAN close — hiding the
    // page you're standing on would drop its highlight).
    if (tab.collapsed && showCollapsed && !onCollapsed && tab.href === collapsedTabs[collapsedTabs.length - 1].href) {
      items.push(
        <button key="less" onClick={() => setMoreOpen(false)} title="Hide these tabs again"
          className={cn(linkCls(false), "text-[#8595a8]")}>
          ✕
        </button>
      );
    }
  }

  return (
    <nav
      className="flex overflow-x-auto border-b border-[#e4ebf2] bg-white px-2 gap-0 flex-shrink-0"
      style={{ scrollbarWidth: "none" }}
    >
      {items}
    </nav>
  );
}
