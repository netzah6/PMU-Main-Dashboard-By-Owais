"use client";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { CreditsPanel } from "@/components/billing/CreditsPanel";

// A Client Success Coach's own dashboard: only the clients assigned to them,
// how each is performing, what they have actually paid us (receipts), and the
// credit they are owed. Admins get a coach picker to look at anyone's book.

type Client = {
  ownerKey: string; ownerName: string; business: string; status: string; mediaBuyer: string;
  dailyBudget: number; bookingPct: number | null; leads30: number; leads7: number;
  cpl30: number | null; spentAll: number; spent14: number; sessionsDone: number; paused: boolean;
};
type Receipt = {
  paymentId: string | null; chargedAt: string | null; chargedBy: string | null;
  shows: number; total: number; manual: boolean; receiptUrl: string | null;
};
type Payload = {
  coach: string; isAdmin: boolean; coaches: string[];
  clients: Client[]; receipts: Record<string, Receipt[]>; credits: Record<string, number>;
};

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const money2 = (n: number) => `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function MyClientsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [coach, setCoach] = useState("");

  const load = useCallback(async (who?: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/my-clients${who ? `?coach=${encodeURIComponent(who)}` : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load");
      setData(j as Payload);
      setCoach(j.coach ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const clients = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = data?.clients ?? [];
    return q ? list.filter((c) => `${c.ownerName} ${c.business}`.toLowerCase().includes(q)) : list;
  }, [data, search]);

  const totals = useMemo(() => {
    const t = { clients: clients.length, leads30: 0, spent: 0, paid: 0, credit: 0, live: 0 };
    for (const c of clients) {
      t.leads30 += c.leads30;
      t.spent += c.spentAll;
      t.credit += data?.credits?.[c.ownerKey] ?? 0;
      if ((c.status ?? "").toLowerCase() === "live") t.live++;
      for (const r of data?.receipts?.[c.ownerKey] ?? []) t.paid += r.total;
    }
    return t;
  }, [clients, data]);

  return (
    <div className="p-3 sm:p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-semibold text-[#1f3559]">My Clients</h1>
        {data?.coach && (
          <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[#eef2ff] text-[#3a5a8c] border border-[#c7d2fe]">
            {data.coach}
          </span>
        )}
        {data?.isAdmin && (data.coaches?.length ?? 0) > 0 && (
          <select value={coach} onChange={(e) => { setCoach(e.target.value); load(e.target.value); }}
            className="px-2 py-1 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-xs text-[#34568a]">
            {data.coaches.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <button onClick={() => load(coach)} title="Refresh"
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> Refresh
        </button>
      </div>

      {error && <div className="px-3 py-2 rounded-lg bg-[#fde8ee] border border-[#f5c2cf] text-[#e11d48] text-sm">{error}</div>}

      {/* Book-level totals */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        {[
          { label: "Clients", value: `${totals.clients}`, sub: `${totals.live} live` },
          { label: "Leads · 30d", value: totals.leads30.toLocaleString(), sub: "across your clients" },
          { label: "Ad spend · all time", value: money(totals.spent), sub: "their ad accounts" },
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

      {/* Give a client credit (goes to Nicolas for approval) */}
      <CreditsPanel
        clients={(data?.clients ?? []).map((c) => ({ ownerKey: c.ownerKey, label: `${c.ownerName}${c.business ? ` — ${c.business}` : ""}` }))}
        onChanged={() => load(coach)}
      />

      <div className="relative max-w-xs">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search your clients…"
          className="w-full pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-10 justify-center"><Loader2 size={15} className="animate-spin" /> Loading your clients…</div>
      ) : !data?.coach ? (
        <div className="rounded-xl border border-[#fcd9a8] bg-[#fffdf7] px-4 py-6 text-sm text-[#8a6d3b]">
          No clients are assigned to your name yet. The Performance sheet&apos;s <b>Assigned</b> column is what links a client to you —
          ask an admin to set it to your first name.
        </div>
      ) : clients.length === 0 ? (
        <div className="py-10 text-center text-[#8595a8]">No clients match.</div>
      ) : (
        <div className="rounded-xl border border-[#e4ebf2] bg-white overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[#e4ebf2] bg-[#f8fafc]">
                {[["Client", ""], ["Status", "hidden sm:table-cell"], ["Leads 30d", ""], ["CPL 30d", "hidden sm:table-cell"],
                  ["Booking %", "hidden md:table-cell"], ["Spent", "hidden md:table-cell"], ["Paid us", ""], ["Credit", ""]].map(([h, cls]) => (
                  <th key={h} className={cn("px-2 sm:px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-wider text-[#697a91] whitespace-nowrap", cls)}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clients.map((c, i) => {
                const receipts = data?.receipts?.[c.ownerKey] ?? [];
                const paid = receipts.reduce((t, r) => t + r.total, 0);
                const credit = data?.credits?.[c.ownerKey] ?? 0;
                const open = openKey === c.ownerKey;
                return (
                  <Fragment key={c.ownerKey}>
                    <tr className={cn("border-b border-[#eef3f8]", i % 2 ? "bg-[#fafcfe]" : "bg-white")}>
                      <td className="px-2 sm:px-3 py-1.5 cursor-pointer max-w-[46vw] sm:max-w-none"
                        onClick={() => setOpenKey(open ? null : c.ownerKey)}>
                        <div className="flex items-center gap-1 font-medium text-[#1f3559]">
                          <ChevronRight size={13} className={cn("text-[#94a3b8] transition-transform shrink-0", open && "rotate-90")} />
                          <span className="truncate">{c.ownerName}</span>
                          {c.paused && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8] shrink-0">Paused</span>}
                        </div>
                        <div className="text-[11px] text-[#8595a8] truncate pl-4">{c.business}</div>
                      </td>
                      <td className="hidden sm:table-cell px-3 py-1.5 text-[#697a91] whitespace-nowrap">{c.status || "\u2014"}</td>
                      <td className="px-2 sm:px-3 py-1.5 text-[#1f3559] font-semibold whitespace-nowrap">{c.leads30}</td>
                      <td className="hidden sm:table-cell px-3 py-1.5 text-[#697a91] whitespace-nowrap">{c.cpl30 == null ? "\u2014" : money2(c.cpl30)}</td>
                      <td className="hidden md:table-cell px-3 py-1.5 text-[#697a91] whitespace-nowrap">{c.bookingPct == null ? "\u2014" : `${(c.bookingPct * 100).toFixed(1)}%`}</td>
                      <td className="hidden md:table-cell px-3 py-1.5 text-[#697a91] whitespace-nowrap">{money(c.spentAll)}</td>
                      <td className="px-2 sm:px-3 py-1.5 font-semibold text-[#0e8f88] whitespace-nowrap">{money(paid)}</td>
                      <td className="px-2 sm:px-3 py-1.5 whitespace-nowrap">
                        {credit > 0
                          ? <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#e6f7ee] text-[#15803d] border border-[#c7edd4]">{money2(credit)}</span>
                          : <span className="text-[#b6c0cd]">\u2014</span>}
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-[#f8fafc] border-b border-[#eef3f8]">
                        <td colSpan={8} className="px-3 pb-3">
                          <p className="text-[11px] font-bold uppercase tracking-wide text-[#8595a8] py-2">
                            Receipts &mdash; service fees this client paid ({receipts.length})
                          </p>
                          {receipts.length === 0 ? (
                            <p className="text-xs text-[#8595a8] pb-2">Nothing charged yet.</p>
                          ) : (
                            <ul className="space-y-1">
                              {receipts.map((r, ri) => (
                                <li key={ri} className="flex items-center gap-2 flex-wrap rounded-lg border border-[#e4ebf2] bg-white px-2.5 py-1.5">
                                  <span className="text-[12px] font-semibold text-[#1f3559]">{money2(r.total)}</span>
                                  <span className="text-[11px] text-[#697a91]">{r.shows} show{r.shows === 1 ? "" : "s"}</span>
                                  <span className="text-[11px] text-[#8595a8]">{fmtDate(r.chargedAt)}</span>
                                  {r.manual
                                    ? <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#f1f5f9] text-[#64748b] border border-[#e2e8f0]">marked manually</span>
                                    : <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#e6f7ee] text-[#15803d] border border-[#c7edd4]">card</span>}
                                  {r.chargedBy && <span className="text-[10px] text-[#8595a8]">by {r.chargedBy.split("@")[0]}</span>}
                                  {r.receiptUrl && (
                                    <a href={r.receiptUrl} target="_blank" rel="noopener noreferrer"
                                      className="ml-auto flex items-center gap-1 text-[11px] font-semibold text-[#0e8f88] hover:underline">
                                      Receipt <ExternalLink size={11} />
                                    </a>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
