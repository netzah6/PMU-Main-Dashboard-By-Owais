"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { label: "Clients", href: "/clients" },
  { label: "Performance", href: "/performance" },
  { label: "Deposits", href: "/deposits" },
  { label: "Bookings", href: "/bookings" },
  { label: "Leads", href: "/leads" },
  { label: "Calls", href: "/calls" },
  { label: "Agreements", href: "/agreements" },
  { label: "CPL 7 Days", href: "/cpl-7days" },
  { label: "CPL 14 Days", href: "/cpl-14days" },
  { label: "Budget", href: "/budget" },
  { label: "LTV", href: "/ltv" },
  { label: "Map", href: "/map" },
];

export function TabNav() {
  const pathname = usePathname();

  return (
    <nav
      className="flex overflow-x-auto border-b border-slate-700 bg-slate-900 px-2 gap-0 flex-shrink-0"
      style={{ scrollbarWidth: "none" }}
    >
      {TABS.map((tab) => {
        const active = pathname === tab.href || (tab.href !== "/clients" && pathname.startsWith(tab.href));
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors",
              active
                ? "border-teal-500 text-teal-400"
                : "border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
