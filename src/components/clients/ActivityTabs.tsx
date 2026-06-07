"use client";
import { useState } from "react";
import { cn, formatDate, formatCurrency } from "@/lib/utils";

interface ActivityTabsProps {
  clientName: string;
  deposits: Record<string, unknown>[];
  bookings: Record<string, unknown>[];
  leads: Record<string, unknown>[];
  calls: Record<string, unknown>[];
}

const TABS = ["Deposits", "Bookings", "Leads", "Calls"] as const;
type Tab = (typeof TABS)[number];

export function ActivityTabs({ clientName, deposits, bookings, leads, calls }: ActivityTabsProps) {
  const [activeTab, setActiveTab] = useState<Tab>("Deposits");

  const normalize = (name: string) => name.toLowerCase().trim();
  const cn2 = normalize(clientName);

  const filteredDeposits = deposits.filter(
    (r) => normalize(String(r.client_name ?? "")) === cn2
  );
  const filteredBookings = bookings.filter(
    (r) => normalize(String(r.client_name ?? "")) === cn2
  );
  const filteredLeads = leads.filter(
    (r) => normalize(String(r.business ?? r.name ?? "")) === cn2
  );
  const filteredCalls = calls.filter(
    (r) => normalize(String(r.client_name ?? "")) === cn2
  );

  const datasets: Record<Tab, Record<string, unknown>[]> = {
    Deposits: filteredDeposits,
    Bookings: filteredBookings,
    Leads: filteredLeads,
    Calls: filteredCalls,
  };

  const current = datasets[activeTab];

  return (
    <div>
      {/* Tab headers */}
      <div className="flex gap-1 border-b border-[#e4ebf2] mb-3">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-3 py-2 text-xs font-medium rounded-t transition-colors",
              activeTab === tab
                ? "text-[#0e8f88] border-b-2 border-[#15B7AE] -mb-px"
                : "text-[#697a91] hover:text-[#1e2a3a]"
            )}
          >
            {tab}
            <span className="ml-1.5 text-xs text-[#8595a8]">
              ({datasets[tab].length})
            </span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="max-h-52 overflow-y-auto space-y-2 pr-1">
        {current.length === 0 ? (
          <p className="text-xs text-[#8595a8] py-4 text-center">No {activeTab.toLowerCase()} found</p>
        ) : (
          current.slice(0, 20).map((row, i) => (
            <div
              key={i}
              className="flex items-center justify-between px-3 py-2 bg-white rounded border border-[#e4ebf2] text-xs"
            >
              {activeTab === "Deposits" && (
                <>
                  <span className="text-[#34568a]">{formatDate(String(row.date ?? ""))}</span>
                  <span className="text-[#0e8f88] font-medium">
                    {formatCurrency(String(row.amount ?? ""))}
                  </span>
                  <span className="text-[#697a91]">{String(row.status ?? "—")}</span>
                </>
              )}
              {activeTab === "Bookings" && (
                <>
                  <span className="text-[#34568a]">{formatDate(String(row.date ?? ""))}</span>
                  <span className="text-[#1e2a3a]">{String(row.type ?? row.service ?? "—")}</span>
                  <span className="text-[#697a91]">{String(row.status ?? "—")}</span>
                </>
              )}
              {activeTab === "Leads" && (
                <>
                  <span className="text-[#34568a]">{String(row.name ?? "—")}</span>
                  <span className="text-[#697a91]">{formatDate(String(row.date ?? ""))}</span>
                  <span className="text-[#697a91]">{String(row.source ?? "—")}</span>
                </>
              )}
              {activeTab === "Calls" && (
                <>
                  <span className="text-[#34568a]">{formatDate(String(row.date ?? ""))}</span>
                  <span className="text-[#697a91]">{String(row.outcome ?? row.notes ?? "—")}</span>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
