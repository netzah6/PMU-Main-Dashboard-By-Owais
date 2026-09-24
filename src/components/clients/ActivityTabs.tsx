"use client";
import { useState } from "react";
import { formatDate, formatCurrency, sortNewestFirst, cn } from "@/lib/utils";
import { parseMs, dedupeBookings } from "@/lib/booking-dedupe";

type Range = "7" | "14" | "30" | "all";

interface ActivityTabsProps {
  clientName: string;
  deposits: Record<string, unknown>[];
  bookings: Record<string, unknown>[];
  leads: Record<string, unknown>[];
  calls: Record<string, unknown>[];
}

export function ActivityTabs({ clientName, deposits, bookings, leads, calls }: ActivityTabsProps) {
  const [range, setRange] = useState<Range>("all");
  const normalize = (name: string) => name.toLowerCase().trim();
  const cn2 = normalize(clientName);

  const now = Date.now();
  const inRange = (dateStr: unknown) => {
    if (range === "all") return true;
    const ms = parseMs(String(dateStr ?? ""));
    if (isNaN(ms)) return false;
    const days = (now - ms) / 86400000;
    return days <= Number(range) && days >= -1;
  };

  const dDeposits = sortNewestFirst(deposits.filter((r) => normalize(String(r.client_name ?? "")) === cn2 && inRange(r.date)));
  const dBookings = sortNewestFirst(dedupeBookings(
    bookings.filter((r) => normalize(String(r.client_name ?? "")) === cn2 && inRange(r.date))));
  const bookingDupes = dBookings.reduce((n, r) => n + ((r._dupes ?? 1) - 1), 0);
  const dLeads = sortNewestFirst(leads.filter((r) => normalize(String(r.business ?? r.name ?? "")) === cn2 && inRange(r.date)));
  const dCalls = sortNewestFirst(calls.filter((r) => normalize(String(r.client_name ?? "")) === cn2 && inRange(r.date)));

  const depositTotal = dDeposits.reduce((s, r) => {
    const v = parseFloat(String(r.amount ?? "").replace(/[$,]/g, ""));
    return s + (isNaN(v) ? 0 : v);
  }, 0);

  return (
    <div className="space-y-3">
      {/* Date-range filter */}
      <div className="flex gap-1.5">
        {([["7", "7 Days"], ["14", "14 Days"], ["30", "30 Days"], ["all", "All Time"]] as const).map(([val, label]) => (
          <button key={val} onClick={() => setRange(val)}
            className={cn("px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors",
              range === val ? "bg-[#15B7AE] text-white border-[#15B7AE]" : "bg-white text-[#697a91] border-[#e4ebf2] hover:bg-[#f1f5f9]")}>
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Column
        label="Deposits from auto bookings"
        color="#0e8f88"
        count={dDeposits.length}
        rows={dDeposits}
        empty="No deposits matched."
        subtitle={
          dDeposits.length ? (
            <>
              <strong className="text-[#0e8f88]">{formatCurrency(depositTotal)}</strong> total recorded
            </>
          ) : null
        }
        render={(r) => (
          <>
            <span className="text-[#697a91] whitespace-nowrap">{formatDate(String(r.date ?? ""))}</span>
            <span className="flex-1 text-[#1f3559] truncate px-2">{String(r.name ?? r.client_name ?? "—")}</span>
            <span className="text-[#0e8f88] font-medium whitespace-nowrap">{formatCurrency(String(r.amount ?? ""))}</span>
          </>
        )}
      />

      <Column
        label="Bookings"
        color="#3a5a8c"
        count={dBookings.length}
        rows={dBookings}
        empty="No bookings matched."
        subtitle={bookingDupes > 0 ? (
          <span title={`The bookings sheet holds ${dBookings.length + bookingDupes} rows for this client. Rows for the same person on the same day, or one day apart (a reschedule), are shown once. Bookings further apart are separate appointments and stay separate rows.`}>
            {bookingDupes} duplicate {bookingDupes === 1 ? "row" : "rows"} merged
          </span>
        ) : null}
        render={(r) => (
          <>
            <span className="text-[#697a91] whitespace-nowrap">{formatDate(String(r.date ?? ""))}</span>
            <span className="flex-1 text-[#1f3559] truncate px-2">{String(r.name ?? r.type ?? "—")}</span>
            {Number(r._dupes ?? 1) > 1 ? (
              <span title={`${Number(r._dupes)} rows in the sheet for this appointment — shown once`}
                className="shrink-0 px-1.5 py-px rounded text-[10px] font-bold bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]">
                &times;{Number(r._dupes)}
              </span>
            ) : (
              <span className="text-[#697a91] whitespace-nowrap">{String(r.status ?? "")}</span>
            )}
          </>
        )}
      />

      <Column
        label="Leads"
        color="#7e22ce"
        count={dLeads.length}
        rows={dLeads}
        empty="No leads matched."
        render={(r) => (
          <>
            <span className="text-[#697a91] whitespace-nowrap">{formatDate(String(r.date ?? ""))}</span>
            <span className="flex-1 text-[#1f3559] truncate px-2">{String(r.name ?? "—")}</span>
          </>
        )}
      />

      <Column
        label="Outgoing Calls"
        color="#c2410c"
        count={dCalls.length}
        rows={dCalls}
        empty="No calls matched."
        render={(r) => (
          <>
            <span className="text-[#697a91] whitespace-nowrap">{formatDate(String(r.date ?? ""))}</span>
            <span className="flex-1 text-[#1f3559] truncate px-2">{String(r.name ?? r.client_name ?? "—")}</span>
          </>
        )}
      />
      </div>
    </div>
  );
}

function Column({
  label, color, count, rows, empty, subtitle, render,
}: {
  label: string;
  color: string;
  count: number;
  rows: Record<string, unknown>[];
  empty: string;
  subtitle?: React.ReactNode;
  render: (row: Record<string, unknown>) => React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-80 rounded-xl border border-[#e4ebf2] bg-white overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#eef3f8]">
        <span className="text-xs font-bold uppercase tracking-wide" style={{ color }}>{label}</span>
        <span className="text-sm font-semibold" style={{ color }}>{count}</span>
      </div>

      {subtitle && (
        <div className="px-3 py-2 text-xs text-[#697a91] border-b border-[#eef3f8]">{subtitle}</div>
      )}

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto p-2">
        {rows.length === 0 ? (
          <p className="text-xs text-[#8595a8] px-1 py-2">{empty}</p>
        ) : (
          <div className="rounded-lg border border-[#eef3f8] divide-y divide-[#eef3f8]">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-1 px-2 py-1.5 text-xs">
                {render(r)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
