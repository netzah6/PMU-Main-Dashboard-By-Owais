"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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
  { label: "✅ Tasks", href: "/tasks" }, // second, next to Clients — user request 2026-08-27
  { label: "🚨 Alerts", href: "/alerts", adminOnly: true }, // CEO notification center — user request 2026-08-28
  { label: "📈 Performance", href: "/performance" },
  { label: "💰 Cost / Deposit", href: "/cost-per-deposit", adminOnly: true }, // CEO only — user request 2026-08-27
  { label: "💵 Deposits", href: "/deposits" },
  { label: "📅 Bookings", href: "/bookings", collapsed: true },
  { label: "🧲 Leads", href: "/leads", collapsed: true },
  { label: "📞 Calls", href: "/calls", collapsed: true },
  // Hidden from the menu (page still exists at /reply): AI Replies — merged into the AI chat
  // Hidden from the menu (page still exists at /agreements) — user request 2026-08-21
  // { label: "📝 Agreements", href: "/agreements" },
  // Hidden from the menu (pages still exist): CPL 7 Days, CPL 14 Days, Budget
  { label: "💎 LTV", href: "/ltv", adminOnly: true, collapsed: true }, // admins only
  { label: "🔄 Subscriptions", href: "/subscriptions", adminOnly: true, collapsed: true }, // Square billing — admins only
  { label: "🛡️ Chargebacks", href: "/chargebacks", adminOnly: true, collapsed: true }, // Square disputes + evidence prep — admins only
  { label: "🧾 PPS Billing", href: "/v3-billing", adminOnly: true }, // pay-per-show tracking — admins only
  { label: "💼 Team", href: "/sales", adminOnly: true, collapsed: true }, // sales-team salary tracking: closer demo checker + coach tracker
  { label: "🚀 Onboarding", href: "/onboarding" }, // setup checklist + Check Setup — whole team runs their own checks
  { label: "🧑‍💼 My Clients", href: "/my-clients" }, // a coach's own book — clients, receipts, credit (2026-09-05)
  { label: "🧪 Funnels", href: "/funnels", adminOnly: true }, // one-box funnels on Vercel — existence, health, leads/bookings
  { label: "📡 Pixel Checking", href: "/pixel-checking", adminOnly: true }, // per-client funnel pixel/conversion audit — user request 2026-09-01
  { label: "🧹 Cleanup", href: "/cleanup", adminOnly: true, collapsed: true }, // offboarded sub-account wipe + pool recycling — admins only
  { label: "👑 CEO", href: "/ceo", adminOnly: true }, // offboarded sub-account wipe + pool recycling — admins only
  { label: "🕵️ Logs", href: "/activity", adminOnly: true, collapsed: true }, // team-member change log
  { label: "📣 Blast", href: "/blast" }, // text blasts — human-confirmed; admins + coaches (user request 2026-08-27)
  { label: "🗺️ Map", href: "/map" },
  { label: "🤖 AI", href: "/ask" },
  { label: "📊 Reports", href: "/reports" },
];

// Strict per-role allowlists — these roles see ONLY the listed tabs.
const VA_TABS = new Set(["/clients", "/onboarding"]);
const MEDIA_BUYER_TABS = new Set([
  "/clients", "/tasks", "/performance", "/onboarding", "/leads", "/pixel-checking",
]); // user request 2026-09-01

const ALLOWLISTS: Partial<Record<NonNullable<UserRole>, Set<string>>> = {
  va: VA_TABS,
  media_buyer: MEDIA_BUYER_TABS,
};

// Which pages each role may actually OPEN. Hiding a tab is not access
// control — RoleGate in DashboardShell calls this on every navigation and
// bounces a disallowed URL to /clients. Kept next to TABS so the tab list
// and the gate can never disagree.
export function pathAllowedFor(role: UserRole | null, pathname: string): boolean {
  const hit = TABS.find((t) => pathname === t.href || pathname.startsWith(t.href + "/"));
  // Allowlist roles (VA, Media Buyer): their tabs and nothing else — the
  // allowlist wins over adminOnly (e.g. Pixel Checking for media buyers).
  const allow = role ? ALLOWLISTS[role] : undefined;
  if (allow) return !!hit && allow.has(hit.href);
  // Pages outside the tab list guard themselves (/settings is admin-gated).
  if (!hit) return true;
  return !hit.adminOnly || role === "admin";
}

export function TabNav() {
  const pathname = usePathname();
  const { role } = useUser();
  const allow = role ? ALLOWLISTS[role] : undefined;
  const tabs = TABS.filter((t) =>
    allow ? allow.has(t.href) : !t.adminOnly || role === "admin"
  )
    // An allowlist role's bar is short — show every tab directly instead of
    // hiding some (e.g. Leads) behind "⋯ More".
    .map((t) => (allow ? { ...t, collapsed: false } : t));

  const isActive = (t: Tab) => pathname === t.href || pathname.startsWith(t.href + "/");
  const collapsedTabs = tabs.filter((t) => t.collapsed);
  // Being ON one of the hidden pages keeps the group visible — otherwise the
  // active tab would have no highlight anywhere on the bar.
  const onCollapsed = collapsedTabs.some(isActive);
  const [moreOpen, setMoreOpen] = useState(false);
  const showCollapsed = moreOpen || onCollapsed;

  // Open-alert count for the 🚨 tab's red badge — admins only, refreshed
  // every minute so a new alert shows up without touching the page.
  const [alertCount, setAlertCount] = useState(0);
  useEffect(() => {
    if (role !== "admin") return;
    let stop = false;
    const poll = () =>
      fetch("/api/alerts?count=1")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (!stop && j) setAlertCount(Number(j.open) || 0); })
        .catch(() => {});
    poll();
    const t = setInterval(() => { if (document.visibilityState === "visible") poll(); }, 60_000);
    return () => { stop = true; clearInterval(t); };
  }, [role]);

  const linkCls = (active: boolean) => cn(
    "px-4 py-3 text-sm font-semibold whitespace-nowrap border-b-2 transition-colors tracking-tight",
    active
      ? "border-[#15B7AE] text-[#0e8f88]"
      : "border-transparent text-[#34568a] hover:text-[#0e8f88] hover:border-[#d7e0ea]"
  );

  // The bar: main tabs in order, then the collapsed group at the VERY RIGHT —
  // a "⋯ More" chip when hidden, the tabs (+ a ✕ to re-hide) when shown.
  return (
    <nav
      className="flex overflow-x-auto border-b border-[#e4ebf2] bg-white px-2 gap-0 flex-shrink-0"
      style={{ scrollbarWidth: "none" }}
    >
      {tabs.filter((t) => !t.collapsed).map((tab) => (
        <Link key={tab.href} href={tab.href} className={linkCls(isActive(tab))}>
          {tab.label}
          {tab.href === "/alerts" && alertCount > 0 && (
            <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold align-middle">
              {alertCount > 99 ? "99+" : alertCount}
            </span>
          )}
        </Link>
      ))}
      {collapsedTabs.length > 0 && !showCollapsed && (
        <button key="more" onClick={() => setMoreOpen(true)}
          title={`Show ${collapsedTabs.map((t) => t.label.replace(/^\S+\s/, "")).join(", ")}`}
          className={linkCls(false)}>
          ⋯ More
        </button>
      )}
      {showCollapsed && collapsedTabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={linkCls(isActive(tab))}>
          {tab.label}
        </Link>
      ))}
      {/* ✕ only when the group CAN close — hiding the page you're standing on
          would drop its highlight. */}
      {showCollapsed && !onCollapsed && (
        <button key="less" onClick={() => setMoreOpen(false)} title="Hide these tabs again"
          className={cn(linkCls(false), "text-[#8595a8]")}>
          ✕
        </button>
      )}
    </nav>
  );
}
