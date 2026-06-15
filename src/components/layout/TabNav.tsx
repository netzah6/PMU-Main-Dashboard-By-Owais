"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { label: "Overview", href: "/overview" },
  { label: "Clients", href: "/clients" },
  { label: "Performance", href: "/performance" },
  { label: "Deposits", href: "/deposits" },
  { label: "Bookings", href: "/bookings" },
  { label: "Leads", href: "/leads" },
  { label: "Calls", href: "/calls" },
  { label: "Agreements", href: "/agreements" },
  // Hidden from the menu (pages still exist): CPL 7 Days, CPL 14 Days, Budget
  { label: "LTV", href: "/ltv" },
  { label: "Map", href: "/map" },
  { label: "Reports", href: "/reports" },
];

export function TabNav() {
  const pathname = usePathname();

  return (
    <nav
      className="flex overflow-x-auto border-b border-[#e4ebf2] bg-white px-2 gap-0 flex-shrink-0"
      style={{ scrollbarWidth: "none" }}
    >
      {TABS.map((tab) => {
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
