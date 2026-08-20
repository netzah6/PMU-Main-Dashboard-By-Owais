"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useUser } from "@/lib/hooks/useUser";

type Tab = { label: string; href: string; adminOnly?: boolean };

const TABS: Tab[] = [
  // Hidden from the menu (page still exists at /overview): Overview
  { label: "👥 Clients", href: "/clients" },
  { label: "📈 Performance", href: "/performance" },
  { label: "💰 Cost / Deposit", href: "/cost-per-deposit" },
  { label: "💵 Deposits", href: "/deposits" },
  { label: "📅 Bookings", href: "/bookings" },
  { label: "🧲 Leads", href: "/leads" },
  { label: "📞 Calls", href: "/calls" },
  { label: "✅ Tasks", href: "/tasks" },
  // Hidden from the menu (page still exists at /reply): AI Replies — merged into the AI chat
  // Hidden from the menu (page still exists at /agreements) — user request 2026-08-21
  // { label: "📝 Agreements", href: "/agreements" },
  // Hidden from the menu (pages still exist): CPL 7 Days, CPL 14 Days, Budget
  { label: "💎 LTV", href: "/ltv", adminOnly: true }, // admins only
  { label: "🔄 Subscriptions", href: "/subscriptions", adminOnly: true }, // Square billing — admins only
  { label: "🛡️ Chargebacks", href: "/chargebacks", adminOnly: true }, // Square disputes + evidence prep — admins only
  { label: "🧾 PPS Billing", href: "/v3-billing", adminOnly: true }, // pay-per-show tracking — admins only
  { label: "💼 Sales", href: "/sales" }, // demo checker — paste contacts, get showed/no-show from the pipeline stage
  { label: "🚀 Onboarding", href: "/onboarding" }, // setup checklist + Check Setup — whole team runs their own checks
  { label: "🧪 Funnels", href: "/funnels", adminOnly: true }, // one-box funnels on Vercel — existence, health, leads/bookings
  { label: "🧹 Cleanup", href: "/cleanup", adminOnly: true }, // offboarded sub-account wipe + pool recycling — admins only
  { label: "👑 CEO", href: "/ceo", adminOnly: true }, // offboarded sub-account wipe + pool recycling — admins only
  { label: "🕵️ Logs", href: "/activity", adminOnly: true }, // team-member change log
  { label: "🗺️ Map", href: "/map" },
  { label: "🤖 AI", href: "/ask" },
  { label: "📊 Reports", href: "/reports" },
];

// A VA sees only these two. The real enforcement is in src/middleware.ts —
// this just keeps the tab bar honest about what they can reach.
const VA_TABS = new Set(["/clients", "/onboarding"]);

export function TabNav() {
  const pathname = usePathname();
  const { role } = useUser();
  const tabs = TABS.filter((t) =>
    role === "va" ? VA_TABS.has(t.href) : !t.adminOnly || role === "admin"
  );

  return (
    <nav
      className="flex overflow-x-auto border-b border-[#e4ebf2] bg-white px-2 gap-0 flex-shrink-0"
      style={{ scrollbarWidth: "none" }}
    >
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(tab.href + "/");
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "px-4 py-3 text-sm font-semibold whitespace-nowrap border-b-2 transition-colors tracking-tight",
              active
                ? "border-[#15B7AE] text-[#0e8f88]"
                : "border-transparent text-[#34568a] hover:text-[#0e8f88] hover:border-[#d7e0ea]"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
