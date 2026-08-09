"use client";

import { useEffect, useMemo, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { useTableData } from "@/lib/hooks/useTableData";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// CEO view, rebuilt natively.
//
// It used to embed a standalone HTML page that fetched five Google Sheets from
// the browser against a hardcoded month list ending in May, so June onward were
// invisible and nothing could be cross-checked. Now:
//   Live vs Paused   -> clients_master (the Clients Master tab we mirror)
//   New vs recurring -> /api/ceo/finance, read server-side from the Financing
//                       workbook, every month tab, both layouts.
// A client is NEW the first month their name appears and recurring thereafter.

interface MonthFinance {
  label: string; ym: string;
  newClients: number; newCash: number;
  recurringClients: number; recurringCash: number;
  depositIncome: number; totalCash: number;
  totalIncome: number | null; totalExpense: number | null; totalProfit: number | null;
  newNames: string[];
}

const money0 = (n: number | null | undefined) =>
  n == null ? "—" : "$" + Math.round(n).toLocaleString();

// One legend for the whole page: new cash, recurring, and the deposits the
// team collects from clients (the "… Deposits From Clients" rows).
const SERIES = {
  new:      { fill: "#15B7AE", label: "New cash" },
  recurring:{ fill: "#bfe6e3", label: "Recurring" },
  deposits: { fill: "#f0a83c", label: "Deposits from clients" },
};

export default function CeoPage() {
  const { role, loading } = useUser();
  const { data: clients } = useTableData<Record<string, unknown>>({ table: "clients_master" });
  const [fin, setFin] = useState<MonthFinance[] | null>(null);
  const [finErr, setFinErr] = useState<string | null>(null);
  const [ym, setYm] = useState<string | null>(null);

  useEffect(() => {
    if (role !== "admin") return;
    fetch("/api/ceo/finance")
      .then((r) => r.json())
      .then((j) => {
        if (j.error) return setFinErr(String(j.error));
        const months: MonthFinance[] = j.months ?? [];
        setFin(months);
        setYm((cur) => cur ?? months[months.length - 1]?.ym ?? null);
      })
      .catch((e) => setFinErr(String(e)));
  }, [role]);

  // Column A of Clients Master holds the status but has no header cell, so the
  // sheet sync names it col_1.
  const st = useMemo(() => {
    const c = { live: 0, paused: 0, offboarded: 0, blank: 0 };
    for (const r of clients) {
      const s = String(r?.["col_1"] ?? "").trim().toLowerCase();
      if (s === "live") c.live++;
      else if (s === "paused") c.paused++;
      else if (s === "offboarded") c.offboarded++;
      else c.blank++;
    }
    return c;
  }, [clients]);

  const sel = fin?.find((m) => m.ym === ym) ?? null;
  const selIdx = fin && sel ? fin.indexOf(sel) : -1;
  const prev = fin && selIdx > 0 ? fin[selIdx - 1] : null;
  const delta = sel && prev ? sel.totalCash - prev.totalCash : null;
  const maxBar = Math.max(1, ...(fin ?? []).map((m) => m.totalCash));

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-[#15B7AE]" /></div>;
  if (role !== "admin") return <div className="p-8 text-sm text-[#697a91]">Admins only.</div>;

  return (
    <div className="p-3 md:p-4 space-y-2.5">
      {/* ── Header + month selector ───────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-[#1f3559]">CEO</h1>
        <select
          value={ym ?? ""}
          onChange={(e) => setYm(e.target.value)}
          disabled={!fin}
          className="px-3 py-1.5 bg-white border border-[#e4ebf2] rounded-lg text-sm
                     text-[#1f3559] focus:outline-none focus:border-[#15B7AE] disabled:opacity-50"
        >
          {(fin ?? []).map((m) => (
            <option key={m.ym} value={m.ym}>{m.label} 2026</option>
          ))}
        </select>
      </div>

      {finErr && (
        <div className="rounded-lg border border-[#fcd9a8] bg-[#fff7ec] px-3 py-2 text-xs text-[#b45309]">
          Finance sheet unavailable: {finErr}
        </div>
      )}

      {/* ── One compact stat strip ────────────────────────────────── */}
      <div className="rounded-xl border border-[#e4ebf2] bg-white px-3 py-2.5 flex flex-wrap
                      items-center gap-x-6 gap-y-2 text-sm" style={{ boxShadow: "var(--shadow-sm)" }}>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[#8595a8]">Live</span>
          <span className="text-lg font-bold text-[#15803d] tabular-nums">{st.live}</span>
          <span className="text-[11px] text-[#8595a8]">· {st.paused} paused · {st.offboarded} offboarded
            {st.blank > 0 && <> · <span className="text-[#b45309]">{st.blank} no status</span></>}
          </span>
        </div>
        <div className="h-5 w-px bg-[#e4ebf2] hidden sm:block" />
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[#8595a8]">
            {sel?.label ?? "Month"} cash
          </span>
          <span className="text-lg font-bold text-[#1f3559] tabular-nums">{money0(sel?.totalCash)}</span>
          {delta != null && prev && (
            <span className={cn("text-[11px] font-medium tabular-nums",
                                delta >= 0 ? "text-[#15803d]" : "text-[#dc2626]")}>
              {delta >= 0 ? "+" : ""}{money0(delta)} vs {prev.label}
            </span>
          )}
        </div>
        <div className="h-5 w-px bg-[#e4ebf2] hidden sm:block" />
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[#8595a8]">Profit</span>
          <span className="text-lg font-bold text-[#0f8f88] tabular-nums">{money0(sel?.totalProfit)}</span>
          {sel?.totalExpense != null && (
            <span className="text-[11px] text-[#8595a8]">{money0(sel.totalExpense)} expenses</span>
          )}
        </div>
      </div>

      {/* ── Merged: bars carry the numbers, no second table ───────── */}
      <div className="rounded-xl border border-[#e4ebf2] bg-white p-3" style={{ boxShadow: "var(--shadow-sm)" }}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
          <h2 className="text-sm font-semibold text-[#1f3559]">New Cash vs Recurring Revenue</h2>
          <div className="flex items-center gap-3 text-[11px] text-[#697a91]">
            {Object.values(SERIES).map((s) => (
              <span key={s.label} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: s.fill }} />
                {s.label}
              </span>
            ))}
          </div>
        </div>

        {!fin ? (
          <div className="py-8 text-center text-sm text-[#8595a8]">Reading the Financing sheet…</div>
        ) : (
          <>
            {/* column headings for the inline numbers */}
            <div className="hidden md:flex items-center gap-2 px-1 pb-1 text-[9px] font-semibold
                            uppercase tracking-wide text-[#8595a8]">
              <span className="w-16 shrink-0">Month</span>
              <span className="flex-1" />
              <span className="w-24 text-right">New</span>
              <span className="w-24 text-right">Recurring</span>
              <span className="w-20 text-right">Deposits</span>
              <span className="w-24 text-right">Total</span>
            </div>

            <div className="space-y-1">
              {fin.map((m) => {
                const on = m.ym === ym;
                const pct = (v: number) => (m.totalCash > 0 ? (v / m.totalCash) * 100 : 0);
                return (
                  <button
                    key={m.ym}
                    onClick={() => setYm(m.ym)}
                    className={cn(
                      "w-full flex items-center gap-2 rounded-md px-1 py-1 text-left transition-colors",
                      on ? "bg-[#f2fbfa]" : "hover:bg-[#f8fbfd]"
                    )}
                  >
                    <span className={cn("w-16 shrink-0 text-[11px]",
                                        on ? "font-bold text-[#0f8f88]" : "font-medium text-[#34568a]")}>
                      {m.label}
                    </span>

                    <span className="flex-1 min-w-[80px] h-5 rounded bg-[#f1f5f9] overflow-hidden">
                      <span className="h-full flex" style={{ width: `${(m.totalCash / maxBar) * 100}%` }}>
                        <span className="h-full" style={{ width: `${pct(m.newCash)}%`, background: SERIES.new.fill }} />
                        <span className="h-full" style={{ width: `${pct(m.recurringCash)}%`, background: SERIES.recurring.fill }} />
                        <span className="h-full" style={{ width: `${pct(m.depositIncome)}%`, background: SERIES.deposits.fill }} />
                      </span>
                    </span>

                    <span className="w-24 text-right text-[11px] tabular-nums font-semibold text-[#0f8f88]">
                      {money0(m.newCash)}<span className="text-[#8595a8] font-normal"> ·{m.newClients}</span>
                    </span>
                    <span className="w-24 text-right text-[11px] tabular-nums text-[#34568a]">
                      {money0(m.recurringCash)}<span className="text-[#8595a8]"> ·{m.recurringClients}</span>
                    </span>
                    <span className="w-20 text-right text-[11px] tabular-nums"
                          style={{ color: m.depositIncome ? "#b4701a" : "#c3ccd6" }}>
                      {m.depositIncome ? money0(m.depositIncome) : "—"}
                    </span>
                    <span className="w-24 text-right text-[11px] tabular-nums font-bold text-[#1f3559]">
                      {money0(m.totalCash)}
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="text-[10px] text-[#8595a8] mt-2 leading-snug">
              Deposits are the &ldquo;Deposits From Clients&rdquo; rows (Whop + Fanbasis) &mdash; money collected
              from clients rather than a subscription, so they sit outside new and recurring. Counting them is
              what makes each month tie to the sheet&rsquo;s own Total Income.
            </p>
          </>
        )}
      </div>

      {/* ── New clients for whichever month is selected ───────────── */}
      {sel && (
        <div className="rounded-xl border border-[#e4ebf2] bg-white p-3" style={{ boxShadow: "var(--shadow-sm)" }}>
          <div className="flex flex-wrap items-baseline gap-x-2 mb-2">
            <h2 className="text-sm font-semibold text-[#1f3559]">New clients in {sel.label}</h2>
            <span className="text-[11px] text-[#8595a8]">
              {sel.newClients} first-time {sel.newClients === 1 ? "payer" : "payers"} · {money0(sel.newCash)}
            </span>
          </div>
          {sel.newNames.length === 0 ? (
            <p className="text-[11px] text-[#8595a8]">No first-time payers this month.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {sel.newNames.map((n) => (
                <span key={n} className="px-2 py-0.5 rounded text-[11px] font-medium
                                         bg-[#eefaf9] text-[#0f8f88] border border-[#bfe6e3]">
                  {n}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
