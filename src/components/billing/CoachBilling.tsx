"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { CreditsPanel } from "@/components/billing/CreditsPanel";
import { RecentBilling } from "@/components/billing/RecentBilling";

// PPS Billing as a Client Success Coach sees it: their own clients, the money
// already collected from them, and account credit they can request.
//
// What is deliberately NOT here (user request 2026-09-08): the "Need to be
// charged" section, the to-collect total, the "To charge" worklist and the
// appointment-by-appointment amounts. Those are the admin's job — a coach
// needs what a client has paid and what they are owed back, nothing pending.

type Client = {
  ownerKey: string; ownerName: string; business: string; status: string; coach: string;
  shows: number; paid: number; lastChargedAt: string | null; credit: number;
};

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const money2 = (n: number) => `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function CoachBilling() {
  const [clients, setClients] = useState<Client[]>([]);
  const [coach, setCoach] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/ppa/coach");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load");
      setClients((j.clients as Client[]) ?? []);
      setCoach(j.coach ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? clients.filter((c) => `${c.ownerName} ${c.business}`.toLowerCase().includes(q)) : clients;
  }, [clients, search]);

  const totals = useMemo(() => ({
    clients: clients.length,
    paid: clients.reduce((t, c) => t + c.paid, 0),
    shows: clients.reduce((t, c) => t + c.shows, 0),
    credit: clients.reduce((t, c) => t + c.credit, 0),
  }), [clients]);

  const refresh = () => { setRefreshKey((k) => k + 1); load(); };

  return (
    <div className="p-3 sm:p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-xl font-bold text-[#1f3559]">PPS Billing</h1>
        {coach && (
          <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[#eef2ff] text-[#3a5a8c] border border-[#c7d2fe]">
            {coach}&apos;s clients
          </span>
        )}
        <button onClick={refresh}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> Refresh
        </button>
      </div>

      {error && <div className="px-3 py-2 rounded-lg bg-[#fde8ee] border border-[#f5c2cf] text-[#e11d48] text-sm">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {[
          { label: "PPS clients", value: `${totals.clients}`, sub: "in your book" },
          { label: "Shows billed", value: totals.shows.toLocaleString(), sub: "all time" },
          { label: "Service fees paid", value: money(totals.paid), sub: "collected from them" },
          { label: "Credit owed", value: money(totals.credit), sub: "approved, unused" },
        ].map((k) => (
          <div key={k.label} className="rounded-xl border border-[#e4ebf2] bg-white px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8]">{k.label}</p>
            <p className="text-lg font-bold text-[#1f3559] leading-tight">{k.value}</p>
            <p className="text-[10px] text-[#8595a8]">{k.sub}</p>
          </div>
        ))}
      </div>

      <RecentBilling refreshKey={refreshKey} />

      <CreditsPanel
        clients={clients.map((c) => ({ ownerKey: c.ownerKey, label: `${c.ownerName}${c.business ? ` — ${c.business}` : ""}` }))}
        onChanged={refresh}
      />

      <div className="relative max-w-xs">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search your clients…"
          className="w-full pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
      </div>

      {loading && clients.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-10 justify-center">
          <Loader2 size={15} className="animate-spin" /> Loading your PPS clients…
        </div>
      ) : !coach ? (
        <div className="rounded-xl border border-[#fcd9a8] bg-[#fffdf7] px-4 py-6 text-sm text-[#8a6d3b]">
          No clients are assigned to your name yet. The Clients Master sheet&apos;s <b>Assigned</b> column is what links a
          client to you — ask an admin to set it to your first name.
        </div>
      ) : shown.length === 0 ? (
        <div className="py-10 text-center text-[#8595a8]">
          {clients.length === 0 ? "None of your clients are on pay-per-show billing." : "No clients match."}
        </div>
      ) : (
        <div className="rounded-xl border border-[#e4ebf2] bg-white overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[#e4ebf2] bg-[#f8fafc]">
                {[["Client", ""], ["Status", "hidden sm:table-cell"], ["Shows billed", ""],
                  ["Paid us", ""], ["Last charge", "hidden sm:table-cell"], ["Credit", ""]].map(([h, cls]) => (
                  <th key={h} className={cn("px-2 sm:px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-wider text-[#697a91] whitespace-nowrap", cls)}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((c, i) => (
                <tr key={c.ownerKey} className={cn("border-b border-[#eef3f8]", i % 2 ? "bg-[#fafcfe]" : "bg-white",
                  c.status === "paused" && "opacity-60")}>
                  <td className="px-2 sm:px-3 py-1.5 max-w-[46vw] sm:max-w-none">
                    <div className="font-medium text-[#1f3559] truncate">{c.ownerName}</div>
                    <div className="text-[11px] text-[#8595a8] truncate">{c.business}</div>
                  </td>
                  <td className="hidden sm:table-cell px-3 py-1.5 text-[#697a91] whitespace-nowrap capitalize">{c.status || "—"}</td>
                  <td className="px-2 sm:px-3 py-1.5 text-[#1f3559] font-semibold whitespace-nowrap">{c.shows}</td>
                  <td className="px-2 sm:px-3 py-1.5 font-semibold text-[#0e8f88] whitespace-nowrap">{money(c.paid)}</td>
                  <td className="hidden sm:table-cell px-3 py-1.5 text-[#697a91] whitespace-nowrap">{fmtDate(c.lastChargedAt)}</td>
                  <td className="px-2 sm:px-3 py-1.5 whitespace-nowrap">
                    {c.credit > 0
                      ? <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#e6f7ee] text-[#15803d] border border-[#c7edd4]">{money2(c.credit)}</span>
                      : <span className="text-[#b6c0cd]">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
