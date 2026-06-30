"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useTableData } from "@/lib/hooks/useTableData";
import { cn } from "@/lib/utils";
import { Search, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { computeHealth, scoreColor, type HealthInputs } from "@/lib/health-score";

const STEP_FIELDS = ["Launch Call", "A2P Verified", "FB Group", "Sync Schedule", "UNSUBSCRIBE Removed", "Agreement", "AI Agent Access", "GMB", "Instagram Widget"];
const isDone = (v: unknown) => ["true", "yes", "1", "on", "installed", "done", "complete"].includes(String(v ?? "").trim().toLowerCase());
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/[$,%]/g, ""));
  return isNaN(n) ? null : n;
};
function daysSince(dateStr: unknown): number | null {
  const s = String(dateStr ?? "").trim();
  if (!s) return null;
  let dt: Date | null = null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) { const a = +m[1], b = +m[2]; const mo = a > 12 ? b : a, da = a > 12 ? a : b; dt = new Date(+m[3], mo - 1, da); }
  else { const d = new Date(s); if (!isNaN(d.getTime())) dt = d; }
  if (!dt || isNaN(dt.getTime())) return null;
  return Math.floor((Date.now() - dt.getTime()) / 86400000);
}
const key = (s: unknown) => String(s ?? "").trim().toLowerCase();

interface ScoredRow {
  owner: string; business: string; version: string;
  total: number; subs: ReturnType<typeof computeHealth>["subs"]; flags: ReturnType<typeof computeHealth>["flags"];
  d30: number; l30: number; bookingPct: number | null; conv30: number | null; daysStrat: number | null;
}

export function ClientHealthList() {
  const { data: rawClients, loading: clientsLoading } = useTableData<Record<string, unknown>>({ table: "clients_master" });
  const [dep, setDep] = useState<Record<string, unknown>[]>([]);
  const [perf, setPerf] = useState<Record<string, unknown>[]>([]);
  const [eng, setEng] = useState<{ owner_key: string; status: string; price_signal: string | null }[]>([]);
  const [pay, setPay] = useState<{ owner_key: string; payment_status: string | null; updated_at: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"score" | "name" | "deposits">("score");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const sb = createClient();
    const [d, p, e, y] = await Promise.all([
      sb.from("deposit_overview").select("owner_name,d30,l30,cpd30"),
      sb.from("performance_overview").select("owner_name,booking_pct,l30,cpl30,last_strategy,campaign_paused"),
      sb.from("ghl_lead_status").select("owner_key,status,price_signal"),
      sb.from("client_payments").select("owner_key,payment_status,updated_at"),
    ]);
    setDep((d.data as Record<string, unknown>[]) ?? []);
    setPerf((p.data as Record<string, unknown>[]) ?? []);
    setEng((e.data as { owner_key: string; status: string; price_signal: string | null }[]) ?? []);
    setPay((y.data as { owner_key: string; payment_status: string | null; updated_at: string | null }[]) ?? []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const rows = useMemo<ScoredRow[]>(() => {
    const depMap = new Map(dep.map((r) => [key(r.owner_name), r]));
    const perfMap = new Map(perf.map((r) => [key(r.owner_name), r]));
    const engMap = new Map<string, { total: number; cold: number; price: number }>();
    eng.forEach((r) => {
      const k = key(r.owner_key);
      const g = engMap.get(k) ?? { total: 0, cold: 0, price: 0 };
      g.total++;
      if (r.status === "v3_only" || r.status === "ai_off_stalled") g.cold++;
      if (r.price_signal) g.price++;
      engMap.set(k, g);
    });
    const payMap = new Map<string, string | null>();
    [...pay].sort((a, b) => String(a.updated_at ?? "").localeCompare(String(b.updated_at ?? ""))).forEach((r) => payMap.set(key(r.owner_key), r.payment_status));

    return rawClients
      .filter((c) => key(c["col_1"]) === "live")
      .map((c) => {
        const owner = String(c["Owner Full Name"] ?? "").trim();
        const k = key(owner);
        const d = depMap.get(k); const pf = perfMap.get(k); const en = engMap.get(k);
        const d30 = Number(d?.d30 ?? 0);
        const dl30 = Number(d?.l30 ?? 0);
        const conv30 = dl30 > 0 ? (d30 / dl30) * 100 : null;
        const l30 = Number(pf?.l30 ?? d?.l30 ?? 0);
        const bookingPct = num(pf?.booking_pct);
        const daysStrat = daysSince(pf?.last_strategy);
        const stepsDone = STEP_FIELDS.filter((f) => isDone(c[f])).length;
        const inputs: HealthInputs = {
          d30, bookingPct, conv30,
          l30, cpl30: num(pf?.cpl30), campaignPaused: pf?.campaign_paused === true,
          engTotal: en?.total ?? 0, engCold: en?.cold ?? 0, engPrice: en?.price ?? 0,
          daysSinceStrategy: daysStrat, paymentStatus: payMap.get(k) ?? null,
          stepsDone, stepsTotal: STEP_FIELDS.length, gmb: isDone(c["GMB"]),
        };
        const h = computeHealth(inputs);
        return { owner, business: String(c["Business Name"] ?? "—"), version: String(c["Version"] ?? ""), total: h.total, subs: h.subs, flags: h.flags, d30, l30, bookingPct, conv30, daysStrat };
      });
  }, [rawClients, dep, perf, eng, pay]);

  const listed = useMemo(() => {
    let l = rows;
    if (search) { const q = search.toLowerCase(); l = l.filter((r) => `${r.owner} ${r.business}`.toLowerCase().includes(q)); }
    const s = [...l];
    if (sort === "name") s.sort((a, b) => a.owner.localeCompare(b.owner));
    else if (sort === "deposits") s.sort((a, b) => b.d30 - a.d30);
    else s.sort((a, b) => a.total - b.total);
    return s;
  }, [rows, search, sort]);

  const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.total, 0) / rows.length) : 0;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <h2 className="text-xs font-semibold text-[#8595a8] uppercase tracking-widest">
          Client Health — {rows.length} active · avg {avg} · lowest first
        </h2>
        <button onClick={load} disabled={loading} className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client…" className="w-full pl-8 pr-3 py-2 bg-[#eef2f7] border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <div className="grid grid-cols-3 gap-1">
          {([["score", "Score"], ["deposits", "Deposits"], ["name", "A–Z"]] as const).map(([v, l]) => (
            <button key={v} onClick={() => setSort(v)} className={cn("px-3 py-2 rounded-lg text-xs font-medium border", sort === v ? "bg-[#15B7AE] text-white border-[#15B7AE]" : "bg-white text-[#697a91] border-[#e4ebf2]")}>{l}</button>
          ))}
        </div>
      </div>

      {loading || clientsLoading ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-12 justify-center"><Loader2 size={15} className="animate-spin" /> Scoring clients…</div>
      ) : (
        <div className="rounded-xl border border-[#e4ebf2] bg-white divide-y divide-[#eef3f8] overflow-hidden">
          {listed.map((r) => {
            const c = scoreColor(r.total); const open = openId === r.owner;
            return (
              <div key={r.owner}>
                <button onClick={() => setOpenId(open ? null : r.owner)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[#fafcfe]">
                  <ChevronRight size={14} className={cn("shrink-0 text-[#94a3b8] transition-transform", open && "rotate-90")} />
                  <span className="shrink-0 w-11 h-9 rounded-lg flex items-center justify-center text-sm font-bold" style={{ background: c.bg, color: c.fg }}>{r.total}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[#1f3559] truncate">{r.business}</div>
                    <div className="text-xs text-[#697a91] truncate">{r.owner}{r.version ? ` · ${r.version}` : ""}</div>
                  </div>
                  <div className="hidden sm:flex items-center gap-1.5 shrink-0">
                    {r.flags.slice(0, 2).map((f, i) => (
                      <span key={i} className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap", f.sev === "red" ? "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]" : "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]")}>{f.label}</span>
                    ))}
                  </div>
                </button>
                {open && (
                  <div className="px-3 pb-3 bg-[#fbfdff] space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 pt-2">
                      {([["Conversion", r.subs.conversion], ["Lead flow", r.subs.leadFlow], ["AI engage", r.subs.engagement], ["Relationship", r.subs.relationship], ["Setup", r.subs.setup]] as const).map(([label, v]) => {
                        const sc = scoreColor(v);
                        return (
                          <div key={label} className="rounded-lg px-2 py-1.5 text-center" style={{ background: sc.bg, color: sc.fg }}>
                            <div className="text-[9px] font-bold uppercase tracking-wide opacity-80">{label}</div>
                            <div className="text-sm font-bold">{v}</div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px] text-[#34568a]">
                      <span className="px-2 py-0.5 rounded bg-[#f1f5f9]">Deposits 30d: <b>{r.d30}</b></span>
                      <span className="px-2 py-0.5 rounded bg-[#f1f5f9]">Leads 30d: <b>{r.l30}</b></span>
                      <span className="px-2 py-0.5 rounded bg-[#f1f5f9]">Booking: <b>{r.bookingPct == null ? "—" : `${(r.bookingPct < 1 ? r.bookingPct * 100 : r.bookingPct).toFixed(0)}%`}</b></span>
                      <span className="px-2 py-0.5 rounded bg-[#f1f5f9]">Conv: <b>{r.conv30 == null ? "—" : `${r.conv30.toFixed(1)}%`}</b></span>
                      <span className="px-2 py-0.5 rounded bg-[#f1f5f9]">Last strategy: <b>{r.daysStrat == null ? "none" : `${r.daysStrat}d ago`}</b></span>
                    </div>
                    {r.flags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {r.flags.map((f, i) => (
                          <span key={i} className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold border", f.sev === "red" ? "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]" : "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]")}>{f.label}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {listed.length === 0 && <div className="px-4 py-12 text-center text-[#8595a8]">No active clients match.</div>}
        </div>
      )}
    </div>
  );
}
