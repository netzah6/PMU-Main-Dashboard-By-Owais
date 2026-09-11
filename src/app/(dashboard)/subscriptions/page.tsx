"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, RefreshCw, CreditCard, Pause, Play, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { DashboardSubscriptions } from "@/components/billing/DashboardSubscriptions";
import { BillingActivity } from "@/components/billing/BillingActivity";

interface Sub {
  id: string;
  status: string;
  squareStatus?: string;
  pauseScheduledOn?: string | null;
  cancelScheduledOn?: string | null;
  pauseActionId?: string | null;
  customerName: string;
  customerEmail: string | null;
  planName: string;
  cadence: string;
  amountCents: number | null;
  currency: string;
  startDate: string | null;
  chargedThroughDate: string | null;
  canceledDate: string | null;
  monthlyBillingAnchor: number | null;
}

const CADENCE_LABEL: Record<string, string> = {
  DAILY: "/day", WEEKLY: "/wk", EVERY_TWO_WEEKS: "/2wk", THIRTY_DAYS: "/30d",
  MONTHLY: "/mo", EVERY_TWO_MONTHS: "/2mo", QUARTERLY: "/qtr",
  EVERY_SIX_MONTHS: "/6mo", ANNUAL: "/yr", EVERY_TWO_YEARS: "/2yr",
};

function money(cents: number | null, currency: string): string {
  if (cents == null) return "—";
  const v = cents / 100;
  return (currency === "USD" ? "$" : currency + " ") + v.toLocaleString(undefined, { minimumFractionDigits: v % 1 ? 2 : 0 });
}
function fmtDate(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(d + "T12:00:00");
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
// Days from today until a YYYY-MM-DD date (negative = past).
function daysUntil(d: string | null): number | null {
  if (!d) return null;
  const target = new Date(d + "T12:00:00").getTime();
  if (isNaN(target)) return null;
  return Math.round((target - Date.now()) / 86400000);
}

function statusStyle(s: string): { bg: string; color: string; border: string } {
  const u = s.toUpperCase();
  if (u === "ACTIVE") return { bg: "#e6f7ee", color: "#15803d", border: "#86efac" };
  if (u === "PAUSE SCHEDULED") return { bg: "#fff3e6", color: "#c2410c", border: "#fdba74" };
  if (u === "PAUSED") return { bg: "#fff7ec", color: "#d97706", border: "#fcd9a8" };
  if (u === "CANCELED" || u === "DEACTIVATED") return { bg: "#fde8ee", color: "#e11d48", border: "#f5c2cf" };
  return { bg: "#f1f5f9", color: "#64748b", border: "#d7e0ea" }; // PENDING / other
}

// Next charge: for an active sub, Square bills again right after the paid-
// through date, so we surface charged_through_date as the upcoming charge.
function ChargeCell({ s }: { s: Sub }) {
  if (s.status.toUpperCase() !== "ACTIVE") return <span className="text-[#a6b3c4]">—</span>;
  const days = daysUntil(s.chargedThroughDate);
  return (
    <span className="whitespace-nowrap">
      {fmtDate(s.chargedThroughDate)}
      {days != null && (
        <span className={cn("ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold",
          days < 0 ? "bg-[#fde8ee] text-[#e11d48]" : days <= 3 ? "bg-[#fff7ec] text-[#d97706]" : "bg-[#e6f7f5] text-[#0e8f88]")}>
          {days < 0 ? `${-days}d overdue` : days === 0 ? "today" : `in ${days}d`}
        </span>
      )}
    </span>
  );
}

type ServerCounts = {
  total: number;
  byStatus: Record<string, number>;
  duplicateActiveCustomers: string[];
};

export default function SubscriptionsPage() {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [serverCounts, setServerCounts] = useState<ServerCounts | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/square/subscriptions");
      // The platform can return plain text (e.g. a gateway timeout page), so
      // never assume JSON — show a readable error instead of a parse crash.
      const text = await res.text();
      let json: { subscriptions?: Sub[]; error?: string; counts?: ServerCounts } = {};
      try { json = JSON.parse(text); } catch {
        throw new Error(res.ok ? "Unexpected response from the server" : `Server error (${res.status}) — try Refresh in a moment`);
      }
      if (!res.ok) throw new Error(json.error || "Failed to load subscriptions");
      setSubs(json.subscriptions ?? []);
      setServerCounts(json.counts ?? null);
    } catch (e) {
      setError(`${e}`.replace("Error: ", ""));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Pause / resume on Square, from here. Square schedules these for the next
  // billing cycle rather than applying them now, and it EMAILS the client
  // either way — so the confirm says both, every time.
  const [acting, setActing] = useState<string | null>(null);
  const [actMsg, setActMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const squareAct = async (s: Sub, action: "pause" | "resume" | "cancel_pause") => {
    const what = action === "pause"
      ? `Pause ${s.customerName}'s Square subscription?\n\nSquare will schedule the pause for the next billing cycle and will EMAIL the client that their subscription is paused.`
      : action === "resume"
        ? `Resume ${s.customerName}'s Square subscription?\n\nSquare will schedule the resume and will EMAIL the client.`
        : `Cancel the scheduled pause for ${s.customerName}?\n\nThe subscription stays active and keeps billing as normal.`;
    if (!window.confirm(what)) return;
    setActing(s.id); setActMsg(null);
    try {
      const r = await fetch("/api/square/subscriptions/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: s.id, action, customerName: s.customerName, actionId: s.pauseActionId ?? undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Square refused");
      setActMsg({ ok: true, text: `${s.customerName}: ${j.detail}` });
      await load();
    } catch (e) {
      setActMsg({ ok: false, text: `${s.customerName}: ${e instanceof Error ? e.message : "failed"}` });
    } finally { setActing(null); }
  };
  const ActionButtons = ({ s }: { s: Sub }) => {
    const st = s.status.toUpperCase();
    const busy = acting === s.id;
    if (st === "PAUSED") return (
      <button onClick={() => squareAct(s, "resume")} disabled={busy}
        className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border bg-[#e6f7ee] text-[#15803d] border-[#c7edd4] hover:bg-[#d5f0e0]">
        {busy ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />} Resume
      </button>
    );
    if (st === "ACTIVE" && s.pauseScheduledOn) return (
      <button onClick={() => squareAct(s, "cancel_pause")} disabled={busy}
        className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border bg-white text-[#34568a] border-[#d7e0ea] hover:bg-[#f6f9fc]">
        {busy ? <Loader2 size={10} className="animate-spin" /> : <Undo2 size={10} />} Cancel pause
      </button>
    );
    if (st === "ACTIVE") return (
      <button onClick={() => squareAct(s, "pause")} disabled={busy}
        className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border bg-[#fff7ec] text-[#b45309] border-[#fcd9a8] hover:bg-[#fdebd3]">
        {busy ? <Loader2 size={10} className="animate-spin" /> : <Pause size={10} />} Pause
      </button>
    );
    return null;
  };

  const counts = useMemo(() => {
    const c = { active: 0, paused: 0, monthlyCents: 0 };
    subs.forEach((s) => {
      const u = s.status.toUpperCase();
      if (u === "ACTIVE") {
        c.active++;
        if ((s.cadence || "MONTHLY") === "MONTHLY" && s.amountCents != null) c.monthlyCents += s.amountCents;
      }
      if (u === "PAUSED" || u === "PAUSE SCHEDULED") c.paused++;
    });
    return c;
  }, [subs]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return subs
      .filter((s) => {
        if (statusFilter !== "All" && s.status.toUpperCase() !== statusFilter) return false;
        if (q && !`${s.customerName} ${s.customerEmail ?? ""} ${s.planName}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        // Soonest upcoming charge first; no-date rows last.
        const da = daysUntil(a.chargedThroughDate), db = daysUntil(b.chargedThroughDate);
        if (da == null && db == null) return a.customerName.localeCompare(b.customerName);
        if (da == null) return 1;
        if (db == null) return -1;
        return da - db;
      });
  }, [subs, search, statusFilter]);

  return (
    <div className="p-3 sm:p-4 space-y-3">
      <DashboardSubscriptions />
      <BillingActivity />
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1f3559]">Square Subscriptions</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#e6f7ee] text-[#15803d] border border-[#86efac]">{counts.active} active</span>
          {counts.paused > 0 && <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]">{counts.paused} paused</span>}
          {counts.monthlyCents > 0 && <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#e6f7f5] text-[#0e8f88] border border-[#a7e3df]">{money(counts.monthlyCents, "USD")}/mo</span>}
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {actMsg && (
        <p className={cn("text-[12px] rounded-lg px-3 py-1.5 border",
          actMsg.ok ? "text-[#15803d] bg-[#e6f7ee] border-[#c7edd4]" : "text-[#be123c] bg-[#fde8ee] border-[#f5c2cf]")}>
          {actMsg.text}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer or plan…"
            className="w-full pl-8 pr-3 py-2 bg-[#eef2f7] border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-[#e4ebf2] bg-white text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
          <option value="ACTIVE">Active</option>
          <option value="PAUSE SCHEDULED">Pause scheduled</option>
          <option value="PAUSED">Paused</option>
          <option value="CANCELED">Canceled</option>
          <option value="All">All statuses</option>
        </select>
      </div>

      {serverCounts && serverCounts.duplicateActiveCustomers.length > 0 && (
        // Two active subscriptions for one person = billed twice. Worth
        // shouting about: nobody goes looking for this.
        <div className="px-3 py-2.5 rounded-xl border border-[#fca5a5] bg-[#fef2f2] space-y-1">
          <p className="text-sm font-semibold text-[#b91c1c]">
            ⚠ {serverCounts.duplicateActiveCustomers.length} customer
            {serverCounts.duplicateActiveCustomers.length > 1 ? "s have" : " has"} more than one ACTIVE subscription — they are being charged multiple times.
          </p>
          <p className="text-xs text-[#7f1d1d]">
            {serverCounts.duplicateActiveCustomers.join(", ")} — check each in Square before the next charge date.
          </p>
        </div>
      )}

      {error ? (
        <div className="px-4 py-6 rounded-xl border border-[#e4ebf2] bg-white text-center space-y-2">
          <CreditCard size={22} className="mx-auto text-[#94a3b8]" />
          <p className="text-sm text-[#34568a] font-medium">{error}</p>
          {error.toLowerCase().includes("not configured") && (
            <p className="text-xs text-[#8595a8]">Add your Square access token in Vercel → Settings → Environment Variables, then redeploy.</p>
          )}
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-12 justify-center"><Loader2 size={15} className="animate-spin" /> Loading subscriptions from Square…</div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-[#8595a8]">No subscriptions match.</div>
      ) : (
        <>
        {/* Mobile cards */}
        <div className="md:hidden space-y-2">
          {filtered.map((s) => {
            const st = statusStyle(s.status);
            return (
              <div key={s.id} className="rounded-xl border border-[#e4ebf2] bg-white p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-[#1f3559] truncate">{s.customerName}</span>
                  <span className="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold" style={{ background: st.bg, color: st.color, border: `1px solid ${st.border}` }} title={s.pauseScheduledOn ? `Pauses ${fmtDate(s.pauseScheduledOn)}` : undefined}>{s.status}</span>
                </div>
                <div className="text-xs text-[#697a91] truncate">{s.planName} · <strong className="text-[#0e8f88]">{money(s.amountCents, s.currency)}{CADENCE_LABEL[s.cadence] ?? ""}</strong></div>
                <div className="text-xs text-[#34568a]">Next charge: <ChargeCell s={s} /></div>
                <ActionButtons s={s} />
              </div>
            );
          })}
        </div>
        {/* Desktop table */}
        <div className="hidden md:block rounded-xl border border-[#e4ebf2] bg-white overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[#e4ebf2] bg-[#f8fafc]">
                {["Customer", "Plan", "Amount", "Status", "Started", "Next Charge", ""].map((h) => (
                  <th key={h} className="px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-wider text-[#697a91] whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => {
                const st = statusStyle(s.status);
                return (
                  <tr key={s.id} className={cn("border-b border-[#eef3f8]", i % 2 ? "bg-[#fafcfe]" : "bg-white")}>
                    <td className="px-3 py-1">
                      <div className="font-medium text-[#1f3559]">{s.customerName}</div>
                      {s.customerEmail && <div className="text-[11px] text-[#8595a8]">{s.customerEmail}</div>}
                    </td>
                    <td className="px-3 py-1 text-[#34568a]">{s.planName}</td>
                    <td className="px-3 py-1 font-semibold text-[#0e8f88] whitespace-nowrap">{money(s.amountCents, s.currency)}<span className="text-[#8595a8] font-normal">{CADENCE_LABEL[s.cadence] ?? ""}</span></td>
                    <td className="px-3 py-1">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold" style={{ background: st.bg, color: st.color, border: `1px solid ${st.border}` }}>{s.status}</span>
                      {s.pauseScheduledOn && <span className="block text-[10px] text-[#c2410c] mt-0.5">pauses {fmtDate(s.pauseScheduledOn)}</span>}
                    </td>
                    <td className="px-3 py-1 text-[#697a91] whitespace-nowrap">{fmtDate(s.startDate)}</td>
                    <td className="px-3 py-1 text-[#1f3559]"><ChargeCell s={s} /></td>
                    <td className="px-3 py-1 text-right"><ActionButtons s={s} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}
