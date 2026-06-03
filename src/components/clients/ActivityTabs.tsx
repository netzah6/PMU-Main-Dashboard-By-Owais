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
      <div className="flex gap-1 border-b border-slate-700 mb-3">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-3 py-2 text-xs font-medium rounded-t transition-colors",
              activeTab === tab
                ? "text-teal-400 border-b-2 border-teal-500 -mb-px"
                : "text-slate-400 hover:text-slate-200"
            )}
          >
            {tab}
            <span className="ml-1.5 text-xs text-slate-500">
              ({datasets[tab].length})
            </span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="max-h-52 overflow-y-auto space-y-2 pr-1">
        {current.length === 0 ? (
          <p className="text-xs text-slate-500 py-4 text-center">No {activeTab.toLowerCase()} found</p>
        ) : (
          current.slice(0, 20).map((row, i) => (
            <div
              key={i}
              className="flex items-center justify-between px-3 py-2 bg-slate-800/50 rounded border border-slate-700/50 text-xs"
            >
              {activeTab === "Deposits" && (
                <>
                  <span className="text-slate-300">{formatDate(String(row.date ?? ""))}</span>
                  <span className="text-emerald-400 font-medium">
                    {formatCurrency(String(row.amount ?? ""))}
                  </span>
                  <span className="text-slate-400">{String(row.status ?? "—")}</span>
                </>
              )}
              {activeTab === "Bookings" && (
                <>
                  <span className="text-slate-300">{formatDate(String(row.date ?? ""))}</span>
                  <span className="text-slate-200">{String(row.type ?? row.service ?? "—")}</span>
                  <span className="text-slate-400">{String(row.status ?? "—")}</span>
                </>
              )}
              {activeTab === "Leads" && (
                <>
                  <span className="text-slate-300">{String(row.name ?? "—")}</span>
                  <span className="text-slate-400">{formatDate(String(row.date ?? ""))}</span>
                  <span className="text-slate-400">{String(row.source ?? "—")}</span>
                </>
              )}
              {activeTab === "Calls" && (
                <>
                  <span className="text-slate-300">{formatDate(String(row.date ?? ""))}</span>
                  <span className="text-slate-400">{String(row.outcome ?? row.notes ?? "—")}</span>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
