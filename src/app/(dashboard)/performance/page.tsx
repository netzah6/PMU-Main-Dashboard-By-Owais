"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency, formatDate, userColor, cn } from "@/lib/utils";
import { Search, ChevronDown } from "lucide-react";

interface PerfRow {
  sheet_row: number;
  client_status: string | null;
  owner_name: string | null;
  ad_account_name: string | null;
  assigned: string | null;
  media_buyer: string | null;
  pmu_services: string | null;
  campaign_status: string | null;
  daily_budget: number | string | null;
  booking_pct: number | string | null;
  l3: number; l7: number; l14: number; l30: number;
  cpl30: number | string | null;
  cpl14: number | string | null;
  cpl7: number | string | null;
  spent14: number | string | null;
  spent7: number | string | null;
  spent_all: number | string | null;
  sessions_done: string | null;
  last_strategy: string | null;
  campaigns: { name: string; norm: string; budget: number | null; spent: number | null; active: boolean; included: boolean }[] | null;
  acct_key: string | null;
}

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[$,]/g, ""));
  return isNaN(n) ? null : n;
};
// "$20" not "$20.00"; keeps decimals only when needed ("$22.5")
const money0 = (v: unknown) => {
  const n = num(v);
  return n == null ? "—" : "$" + +n.toFixed(2);
};

// ── vivid full-cell colors (spreadsheet style) ───────────────────────────────
type Vivid = { bg: string; fg: string };
const V = {
  green:  { bg: "#33d15b", fg: "#0a3d18" },
  yellow: { bg: "#ffe000", fg: "#5c4600" },
  orange: { bg: "#ff9f1a", fg: "#5c3200" },
  red:    { bg: "#ff4d40", fg: "#5c0000" },
  gray:   { bg: "#e3e8ec", fg: "#8a96a3" },
};
// Leads: higher is better (3 tiers, per the owner's thresholds)
const leadVivid = (v: number, g: number, a: number): Vivid => (v >= g ? V.green : v >= a ? V.yellow : V.red);
// Paused clients: gray when 0, orange when any leads still come in.
const leadCellTone = (v: number, g: number, a: number, paused: boolean): Vivid =>
  paused ? (v !== 0 ? V.orange : V.gray) : leadVivid(v, g, a);
// CPL: lower is better; $0/none = gray
const cplVivid = (v: number | null): Vivid =>
  v == null || v <= 0 ? V.gray : v < 6 ? V.green : v < 8 ? V.yellow : v < 10 ? V.orange : V.red;

// Spend vs budget: expected = dailyBudget * days. Off-budget (flag purple) when
// actual is outside 0.6x–1.8x of expected. Returns false when no budget to judge.
function offBudget(spent: unknown, dailyBudget: unknown, days: number): boolean {
  const s = num(spent), b = num(dailyBudget);
  if (s == null || b == null || b <= 0) return false;
  const expected = b * days;
  if (expected <= 0) return false;
  const ratio = s / expected;
  return ratio < 0.6 || ratio > 1.8;
}

// Booking %: green intensity scale (higher % = darker green), like the sheet
const bookingFill = (p: number | null): Vivid => {
  if (p == null) return { bg: "transparent", fg: "#a6b3c4" };
  const t = Math.max(0, Math.min(1, p / 20)); // cap at 20%
  return { bg: `hsl(135, 42%, ${96 - t * 44}%)`, fg: "#0f3320" };
};

// ── campaign status ──────────────────────────────────────────────────────────
function shortStatus(s: string | null): string {
  const u = (s ?? "").toUpperCase();
  if (!u) return "—";
  if (u.includes("GRACE")) return "GRACE";
  if (u.includes("UNSETTLED")) return "UNSETTLED";
  if (u.includes("ACTIVE")) return "ACTIVE";
  if (u.includes("PAUSE")) return "PAUSED";
  if (u.includes("DISABLE")) return "DISABLED";
  if (u.includes("REVIEW")) return "REVIEW";
  if (u.includes("PENDING")) return "PENDING";
  if (u.includes("CLOSED")) return "CLOSED";
  return s ?? "—";
}
function statusTone(s: string | null): string {
  const u = (s ?? "").toUpperCase();
  if (u.includes("ACTIVE")) return "bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df]";
  if (u.includes("GRACE") || u.includes("PENDING") || u.includes("REVIEW")) return "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]";
  if (u.includes("UNSETTLED") || u.includes("DISABLE") || u.includes("CLOSED")) return "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]";
  return "bg-[#f1f5f9] text-[#64748b] border-[#d7e0ea]";
}

function UserCell({ name }: { name: string | null }) {
  if (!name) return <span className="text-[#a6b3c4]">—</span>;
  const c = userColor(name);
  return (
    <span
      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap border"
      style={{ background: c?.bg, color: c?.text, borderColor: c?.border }}
    >
      {name}
    </span>
  );
}

function PmuServicesCell({ value }: { value: string | null }) {
  const [open, setOpen] = useState(false);
  const items = String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== "false");
  if (!items.length) return <span className="text-[#a6b3c4]">—</span>;
  return (
    <div className="min-w-[110px]">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-xs font-medium text-[#0e8f88] hover:underline">
        Services ({items.length})
        <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-1 space-y-0.5">
          {items.map((s, i) => (
            <div key={i} className="text-xs text-[#34568a] bg-[#f1f5f9] rounded px-1.5 py-0.5 whitespace-nowrap">{s}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function CampaignsCell({ campaigns, acctKey, onChanged }: { campaigns: PerfRow["campaigns"]; acctKey: string | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const list = campaigns ?? [];
  if (!list.length) return <span className="text-[#a6b3c4]">—</span>;
  const shown = list.filter((c) => c.included).length;

  async function toggle(norm: string, next: boolean) {
    if (!acctKey || saving) return;
    setSaving(true);
    const supabase = createClient();
    await supabase.from("campaign_overrides").upsert(
      { account_key: acctKey, campaign_norm: norm, include: next, updated_at: new Date().toISOString() },
      { onConflict: "account_key,campaign_norm" }
    );
    setSaving(false);
    onChanged();
  }

  return (
    <div className="min-w-[120px]">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-xs font-medium text-[#0e8f88] hover:underline">
        {shown}/{list.length} shown
        <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {list.map((c, i) => (
            <label key={i} className="flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer">
              <input type="checkbox" checked={c.included} disabled={saving}
                onChange={(e) => toggle(c.norm, e.target.checked)}
                className="w-3.5 h-3.5 accent-teal-500 flex-shrink-0" />
              <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold uppercase", c.active ? "bg-[#e6f7f5] text-[#0e8f88]" : "bg-[#f1f5f9] text-[#94a3b8]")}>
                {c.active ? "Active" : "Paused"}
              </span>
              <span className="text-[#1f3559]">{c.name}</span>
              {c.budget != null && <span className="text-[#697a91]">${+Number(c.budget).toFixed(2)}/d</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const HEADERS = ["Owner Name", "Ad Account Name", "Daily Budget", "Assigned", "Media Buyer", "PMU Services", "Status", "Booking %", "L 30", "L 14", "L 7", "L 3", "CPL 30", "CPL 14", "CPL 7", "Spent 14", "Spent 7", "Spent (All)", "Sessions Done", "Last Strategy", "Campaigns"];

export default function PerformancePage() {
  const [rows, setRows] = useState<PerfRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [assignee, setAssignee] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase.from("performance_overview").select("*");
    if (error) { setError(error.message); setLoading(false); return; }
    setRows((data as PerfRow[]) ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const assignees = useMemo(
    () => ["All", ...Array.from(new Set(rows.map((r) => r.assigned).filter(Boolean) as string[])).sort()],
    [rows]
  );
  const UNSETTLED_EMPTY = "Unsettled / No status";
  const statuses = useMemo(
    () => ["All", UNSETTLED_EMPTY, ...Array.from(new Set(rows.map((r) => shortStatus(r.campaign_status)).filter((s) => s && s !== "—"))).sort()],
    [rows]
  );

  const filtered = useMemo(() => {
    const list = rows.filter((r) => {
      if (assignee !== "All" && r.assigned !== assignee) return false;
      const ss = shortStatus(r.campaign_status);
      if (statusFilter === UNSETTLED_EMPTY) {
        if (!(ss === "UNSETTLED" || ss === "—")) return false;
        // Unsettled/no-status should surface active clients only, not paused ones.
        if (String(r.client_status ?? "").toLowerCase() === "paused") return false;
      } else if (statusFilter !== "All" && ss !== statusFilter) {
        return false;
      }
      if (search) {
        const q = search.toLowerCase();
        if (!`${r.owner_name ?? ""} ${r.ad_account_name ?? ""}`.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    // Active clients first, Paused at the bottom; master order within each group.
    const rank = (s: string | null) => (String(s ?? "").toLowerCase() === "paused" ? 1 : 0);
    return list.sort((a, b) => rank(a.client_status) - rank(b.client_status) || (a.sheet_row ?? 0) - (b.sheet_row ?? 0));
  }, [rows, search, assignee, statusFilter]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-semibold text-[#1f3559]">Performance</h1>
          <p className="text-xs text-[#697a91]">Live clients & campaign data</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
            <input type="text" placeholder="Search owner or ad account…" value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE] w-60" />
          </div>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}
            className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
            {assignees.map((a) => <option key={a} value={a}>{a === "All" ? "All assigned" : a}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
            {statuses.map((s) => <option key={s} value={s}>{s === "All" ? "All statuses" : s}</option>)}
          </select>
          <span className="text-xs text-[#697a91]">{filtered.length} shown</span>
        </div>
      </div>

      {error ? (
        <div className="px-4 py-3 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-sm">
          <strong>Error:</strong> {error}
        </div>
      ) : loading ? (
        <div className="text-sm text-[#697a91] py-12 text-center">Loading performance data…</div>
      ) : (
        <div className="rounded-[14px] border border-[#e4ebf2] bg-white overflow-auto max-h-[calc(100vh-180px)]" style={{ boxShadow: "var(--shadow-sm)" }}>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                {HEADERS.map((h, idx) => {
                  const divider = idx === 7 || idx === 11 || idx === 14; // after Booking %, L 3, CPL 7
                  return (
                    <th
                      key={h}
                      className={cn(
                        "sticky top-0 px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider whitespace-nowrap text-white",
                        idx === 0 || idx === 1 ? "z-30" : "z-20",
                        divider && "border-r-2 border-[#9fb0c4]"
                      )}
                      style={{
                        background: "#2d4c79",
                        ...(idx === 0 && { left: 0, width: 180, minWidth: 180, maxWidth: 180 }),
                        ...(idx === 1 && { left: 180, width: 160, minWidth: 160, maxWidth: 160, boxShadow: "2px 0 0 0 #cbd5e1, 6px 0 8px -6px rgba(0,0,0,0.30)" }),
                      }}
                    >
                      {h}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const booking = num(r.booking_pct);
                const bookingPctVal = booking == null ? null : (booking < 1 ? booking * 100 : booking);
                const cpl30 = num(r.cpl30), cpl14 = num(r.cpl14), cpl7 = num(r.cpl7);
                const off14 = num(r.spent14) != null && offBudget(r.spent14, r.daily_budget, 14);
                const off7 = num(r.spent7) != null && offBudget(r.spent7, r.daily_budget, 7);
                const paused = String(r.client_status ?? "").toLowerCase() === "paused";
                const rowBgClass = paused ? "bg-[#e2e5ea] text-[#7c8794]" : i % 2 ? "bg-[#fafcfe]" : "bg-white";
                return (
                  <tr key={r.sheet_row ?? i} className={cn("group border-b border-[#eef3f8]", rowBgClass, "hover:bg-[#a7e3df]")}>
                    <td className={cn("sticky left-0 z-10 px-3 py-2 text-[#1f3559] font-medium whitespace-nowrap overflow-hidden text-ellipsis group-hover:bg-[#a7e3df]", rowBgClass)}
                      style={{ left: 0, width: 180, minWidth: 180, maxWidth: 180 }} title={r.owner_name ?? ""}>
                      {r.owner_name || "—"}
                      {paused && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]">Paused</span>}
                    </td>
                    <td className={cn("sticky z-10 px-3 py-2 text-[#34568a] whitespace-nowrap overflow-hidden text-ellipsis group-hover:bg-[#a7e3df]", rowBgClass)}
                      style={{ left: 180, width: 160, minWidth: 160, maxWidth: 160, boxShadow: "2px 0 0 0 #cbd5e1, 6px 0 8px -6px rgba(0,0,0,0.20)" }} title={r.ad_account_name ?? ""}>{r.ad_account_name || "—"}</td>
                    <td className="px-3 py-2 text-[#1e2a3a] whitespace-nowrap">{money0(r.daily_budget)}</td>
                    <td className="px-3 py-2"><UserCell name={r.assigned} /></td>
                    <td className="px-3 py-2"><UserCell name={r.media_buyer} /></td>
                    <td className="px-3 py-2 align-top"><PmuServicesCell value={r.pmu_services} /></td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={cn("inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase border", statusTone(r.campaign_status))}>
                        {shortStatus(r.campaign_status)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap border-r-2 border-[#cbd5e1]"
                      style={bookingPctVal == null ? undefined : { background: bookingFill(bookingPctVal).bg, color: bookingFill(bookingPctVal).fg }}>
                      {bookingPctVal == null ? <span className="text-[#a6b3c4]">—</span> : `${bookingPctVal.toFixed(2)}%`}
                    </td>
                    <td className="px-3 py-2 text-center font-bold" style={{ background: leadCellTone(r.l30, 86, 65, paused).bg, color: leadCellTone(r.l30, 86, 65, paused).fg }}>{r.l30}</td>
                    <td className="px-3 py-2 text-center font-bold" style={{ background: leadCellTone(r.l14, 43, 33, paused).bg, color: leadCellTone(r.l14, 43, 33, paused).fg }}>{r.l14}</td>
                    <td className="px-3 py-2 text-center font-bold" style={{ background: leadCellTone(r.l7, 22, 17, paused).bg, color: leadCellTone(r.l7, 22, 17, paused).fg }}>{r.l7}</td>
                    <td className="px-3 py-2 text-center font-bold border-r-2 border-[#cbd5e1]" style={{ background: leadCellTone(r.l3, 11, 8, paused).bg, color: leadCellTone(r.l3, 11, 8, paused).fg }}>{r.l3}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ background: cplVivid(cpl30).bg, color: cplVivid(cpl30).fg }}>{cpl30 == null ? "$0.00" : formatCurrency(cpl30)}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ background: cplVivid(cpl14).bg, color: cplVivid(cpl14).fg }}>{cpl14 == null ? "$0.00" : formatCurrency(cpl14)}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap border-r-2 border-[#cbd5e1]" style={{ background: cplVivid(cpl7).bg, color: cplVivid(cpl7).fg }}>{cpl7 == null ? "$0.00" : formatCurrency(cpl7)}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap"
                      style={off14 ? { background: "#a855f7", color: "#ffffff" } : undefined}
                      title={off14 ? "Off budget (vs daily budget × 14)" : undefined}>
                      {num(r.spent14) == null ? <span className="text-[#a6b3c4]">—</span> : formatCurrency(num(r.spent14))}
                    </td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap"
                      style={off7 ? { background: "#a855f7", color: "#ffffff" } : undefined}
                      title={off7 ? "Off budget (vs daily budget × 7)" : undefined}>
                      {num(r.spent7) == null ? <span className="text-[#a6b3c4]">—</span> : formatCurrency(num(r.spent7))}
                    </td>
                    <td className="px-3 py-2 text-[#1e2a3a] whitespace-nowrap">{num(r.spent_all) ? formatCurrency(num(r.spent_all)) : "—"}</td>
                    <td className="px-3 py-2 text-center text-[#1e2a3a] whitespace-nowrap">{r.sessions_done || <span className="text-[#a6b3c4]">—</span>}</td>
                    <td className="px-3 py-2 text-[#34568a] whitespace-nowrap">{r.last_strategy ? formatDate(r.last_strategy) : <span className="text-[#a6b3c4]">—</span>}</td>
                    <td className="px-3 py-2 align-top"><CampaignsCell campaigns={r.campaigns} acctKey={r.acct_key} onChanged={load} /></td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={21} className="px-4 py-12 text-center text-[#8595a8]">No live clients match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
