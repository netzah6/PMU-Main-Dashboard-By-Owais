"use client";
import { useState } from "react";
import { formatDate, formatCurrency, sortNewestFirst, cn } from "@/lib/utils";

type Range = "7" | "14" | "30" | "all";

// Parse DD/MM/YYYY, MM/DD/YYYY, or ISO dates into a timestamp for range filtering.
function parseMs(s: string): number {
  const str = s.trim();
  if (!str) return NaN;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    let day: number, mon: number;
    if (a > 12) { day = a; mon = b; }
    else if (b > 12) { mon = a; day = b; }
    else { day = a; mon = b; }
    const dt = new Date(y, mon - 1, day);
    return isNaN(dt.getTime()) ? NaN : dt.getTime();
  }
  const dt = new Date(str);
  return isNaN(dt.getTime()) ? NaN : dt.getTime();
}

// ── booking de-duplication ───────────────────────────────────────────────────
// The bookings sheet repeats the same appointment: 1,383 of 3,750 dated rows
// (37%) are the same person on the same day, and another 143 are the same
// person within three days — a reschedule written as a second row rather than
// an edit. Both read as "double bookings" in this list (owner, 2026-09-23).
//
// Collapsed here, NOT filtered away: the kept row carries how many raw rows it
// stands for, so the count on screen still traces back to the sheet.
//
// Three days is the window the owner already uses to call duplicate DEPOSITS
// the same payment, so bookings follow the same rule. Anything further apart is
// a genuine repeat visit (295 fleet-wide) and stays its own row — several of
// this agency's clients rebook every few weeks.
const DUP_WINDOW_DAYS = 3;

/** phone (digits) > email > name — the first one this row actually has. */
function personKey(r: Record<string, unknown>): string {
  const phone = String(r.phone ?? "").replace(/\D/g, "");
  if (phone.length >= 7) return "p:" + phone;
  const email = String(r.email ?? "").trim().toLowerCase();
  if (email) return "e:" + email;
  return "n:" + String(r.name ?? "").trim().toLowerCase();
}

type Deduped = Record<string, unknown> & { _dupes?: number };

/** Collapse same-person bookings within DUP_WINDOW_DAYS; keep the latest. */
function dedupeBookings(rows: Record<string, unknown>[]): Deduped[] {
  const byPerson = new Map<string, Record<string, unknown>[]>();
  const undated: Deduped[] = [];
  for (const r of rows) {
    const key = personKey(r);
    // No person and no date to group on — never merge, or unrelated blanks
    // would collapse into one another.
    if (key === "n:" || isNaN(parseMs(String(r.date ?? "")))) { undated.push(r); continue; }
    byPerson.set(key, [...(byPerson.get(key) ?? []), r]);
  }

  const kept: Deduped[] = [];
  for (const group of byPerson.values()) {
    const sorted = [...group].sort((a, b) => parseMs(String(a.date ?? "")) - parseMs(String(b.date ?? "")));
    let run: Record<string, unknown>[] = [];
    const flush = () => {
      if (!run.length) return;
      // Keep the LAST row of the run: for a reschedule that is the date the
      // appointment actually moved to.
      kept.push({ ...run[run.length - 1], _dupes: run.length });
      run = [];
    };
    for (const r of sorted) {
      if (!run.length) { run = [r]; continue; }
      const gap = (parseMs(String(r.date ?? "")) - parseMs(String(run[run.length - 1].date ?? ""))) / 86400000;
      // Compare against the PREVIOUS row, not the run's first, so a genuine
      // weekly series does not chain into one row.
      if (gap <= DUP_WINDOW_DAYS) run.push(r); else { flush(); run = [r]; }
    }
    flush();
  }
  return [...kept, ...undated];
}

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
          <span title={`The bookings sheet holds ${dBookings.length + bookingDupes} rows for this client. Rows for the same person on the same day — or within ${DUP_WINDOW_DAYS} days, which is a reschedule — are shown once. Repeat visits further apart are still listed separately.`}>
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
