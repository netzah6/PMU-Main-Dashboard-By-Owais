"use client";

import { useEffect, useMemo, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { useTableData } from "@/lib/hooks/useTableData";
import { Loader2, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";

// CEO view, rebuilt natively.
//
// It used to embed a standalone HTML page that fetched five Google Sheets
// straight from the browser against a hardcoded month list ending in May, so
// June onward were invisible and nothing could be cross-checked. Now:
//   Live vs Paused  -> clients_master (the Clients Master tab we already mirror)
//   New vs recurring -> /api/ceo/finance, read server-side from the Financing
//                       workbook, every month tab, both layouts.
// A client counts as NEW the first month their name appears and recurring
// thereafter, which is the rule the team uses.

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

function Card({ title, sub, children, className }: {
  title?: string; sub?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-[#e4ebf2] bg-white p-4", className)}
         style={{ boxShadow: "var(--shadow-sm)" }}>
      {title && (
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-[#1f3559]">{title}</h2>
          {sub && <p className="text-[11px] text-[#8595a8] mt-0.5">{sub}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

function Stat({ label, value, tone, hint }: {
  label: string; value: string; tone?: "teal" | "green" | "amber" | "slate"; hint?: string;
}) {
  const fg = tone === "teal" ? "#0f8f88" : tone === "green" ? "#15803d"
    : tone === "amber" ? "#b45309" : "#1f3559";
  return (
    <div className="rounded-lg border border-[#eef3f8] bg-[#fbfdfe] px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#8595a8]">{label}</div>
      <div className="text-xl font-bold mt-0.5 tabular-nums" style={{ color: fg }}>{value}</div>
      {hint && <div className="text-[11px] text-[#8595a8] mt-0.5">{hint}</div>}
    </div>
  );
}

export default function CeoPage() {
  const { role, loading } = useUser();
  const { data: clients } = useTableData<Record<string, unknown>>({ table: "clients_master" });
  const [fin, setFin] = useState<MonthFinance[] | null>(null);
  const [finErr, setFinErr] = useState<string | null>(null);

  useEffect(() => {
    if (role !== "admin") return;
    fetch("/api/ceo/finance")
      .then((r) => r.json())
      .then((j) => (j.error ? setFinErr(String(j.error)) : setFin(j.months ?? [])))
      .catch((e) => setFinErr(String(e)));
  }, [role]);

  // Column A of Clients Master holds the status but has no header cell, so the
  // sheet sync names it col_1.
  const statuses = useMemo(() => {
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

  const latest = fin?.[fin.length - 1];
  const prev = fin && fin.length > 1 ? fin[fin.length - 2] : null;
  const ytdNew = fin?.reduce((s, m) => s + m.newCash, 0) ?? 0;
  const ytdRec = fin?.reduce((s, m) => s + m.recurringCash, 0) ?? 0;
  const maxBar = Math.max(1, ...(fin ?? []).map((m) => m.totalCash));

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-[#15B7AE]" /></div>;
  if (role !== "admin") return <div className="p-8 text-sm text-[#697a91]">Admins only.</div>;

  const delta = latest && prev ? latest.totalCash - prev.totalCash : 0;

  return (
    <div className="p-3 md:p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[#1f3559]">CEO</h1>
        <span className="text-xs text-[#697a91]">
          {latest ? `${latest.label} 2026` : "loading…"}
        </span>
      </div>

      {finErr && (
        <div className="rounded-lg border border-[#fcd9a8] bg-[#fff7ec] px-3 py-2 text-xs text-[#b45309]">
          Finance sheet unavailable: {finErr}
        </div>
      )}

      {/* ── Headline ─────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <Stat label="Live clients" value={String(statuses.live)} tone="teal"
                hint={`${statuses.paused} paused`} />
        </Card>
        <Card>
          <Stat label={`${latest?.label ?? "Month"} cash`} value={money0(latest?.totalCash)}
                tone="slate"
                hint={prev ? `${delta >= 0 ? "+" : ""}${money0(delta)} vs ${prev.label}` : undefined} />
        </Card>
        <Card>
          <Stat label="New cash YTD" value={money0(ytdNew)} tone="green" />
        </Card>
        <Card>
          <Stat label="Recurring YTD" value={money0(ytdRec)} tone="teal" />
        </Card>
      </div>

      {/* ── Clients ──────────────────────────────────────────────── */}
      <Card title="Clients — Live vs Paused"
            sub="From the Clients Master tab, mirrored every 15 minutes.">
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Live" value={String(statuses.live)} tone="green" />
          <Stat label="Paused" value={String(statuses.paused)} tone="amber" />
          <Stat label="Offboarded" value={String(statuses.offboarded)} tone="slate" />
          <Stat label="No status set" value={String(statuses.blank)} tone="slate"
                hint={statuses.blank ? "not counted anywhere" : undefined} />
        </div>
      </Card>

      {/* ── New vs recurring ─────────────────────────────────────── */}
      <Card title="New Cash vs Recurring Revenue"
            sub="A client is new the first month their name appears in the Financing sheet, and recurring every month after.">
        {!fin ? (
          <div className="py-10 text-center text-sm text-[#8595a8]">Reading the Financing sheet…</div>
        ) : (
          <>
            <div className="space-y-2 mb-4">
              {fin.map((m) => {
                const newPct = m.totalCash > 0 ? (m.newCash / m.totalCash) * 100 : 0;
                const width = (m.totalCash / maxBar) * 100;
                return (
                  <div key={m.ym} className="flex items-center gap-3">
                    <div className="w-20 shrink-0 text-[11px] font-medium text-[#34568a]">{m.label}</div>
                    <div className="flex-1 h-6 rounded-md bg-[#f1f5f9] overflow-hidden">
                      <div className="h-full flex" style={{ width: `${width}%` }}>
                        <div className="h-full bg-[#15B7AE]" style={{ width: `${newPct}%` }}
                             title={`New ${money0(m.newCash)}`} />
                        <div className="h-full bg-[#bfe6e3]" style={{ width: `${100 - newPct}%` }}
                             title={`Recurring ${money0(m.recurringCash)}`} />
                      </div>
                    </div>
                    <div className="w-24 shrink-0 text-right text-[11px] font-semibold text-[#1f3559] tabular-nums">
                      {money0(m.totalCash)}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-4 text-[11px] text-[#697a91] mb-3">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-[#15B7AE] inline-block" /> New cash
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-[#bfe6e3] inline-block" /> Recurring
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-[#8595a8] border-b border-[#eef3f8]">
                    <th className="text-left font-semibold py-2 px-2">Month</th>
                    <th className="text-right font-semibold py-2 px-2">New</th>
                    <th className="text-right font-semibold py-2 px-2">New cash</th>
                    <th className="text-right font-semibold py-2 px-2">Recurring</th>
                    <th className="text-right font-semibold py-2 px-2">Recurring cash</th>
                    <th className="text-right font-semibold py-2 px-2">Deposits</th>
                    <th className="text-right font-semibold py-2 px-2">Total</th>
                    <th className="text-right font-semibold py-2 px-2">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {fin.map((m) => (
                    <tr key={m.ym} className="border-b border-[#f4f8fb] last:border-0">
                      <td className="py-2 px-2 font-medium text-[#1f3559]">{m.label}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-[#34568a]">{m.newClients}</td>
                      <td className="py-2 px-2 text-right tabular-nums font-semibold text-[#0f8f88]">{money0(m.newCash)}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-[#34568a]">{m.recurringClients}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-[#34568a]">{money0(m.recurringCash)}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-[#697a91]">{m.depositIncome ? money0(m.depositIncome) : "—"}</td>
                      <td className="py-2 px-2 text-right tabular-nums font-semibold text-[#1f3559]">{money0(m.totalCash)}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-[#697a91]">{money0(m.totalProfit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-[#8595a8] mt-2">
              Deposits are Whop + Fanbasis money collected from clients &mdash; income, but not a
              subscription, so they sit outside new and recurring. Including them makes each month tie
              to the sheet&rsquo;s own Total Income. Profit comes from the tab&rsquo;s summary row and
              only exists on the V2 layout (April onward).
            </p>
          </>
        )}
      </Card>

      {/* ── This month's new clients ─────────────────────────────── */}
      {latest && latest.newNames.length > 0 && (
        <Card title={`New clients in ${latest.label}`}
              sub={`${latest.newClients} first-time payers · ${money0(latest.newCash)}`}>
          <div className="flex flex-wrap gap-2">
            {latest.newNames.map((n) => (
              <span key={n} className="px-2 py-1 rounded-md text-[11px] font-medium
                                       bg-[#eefaf9] text-[#0f8f88] border border-[#bfe6e3]">
                {n}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* ── Momentum ─────────────────────────────────────────────── */}
      {fin && fin.length > 1 && (
        <Card title="Month over month">
          <div className="grid gap-3 sm:grid-cols-3">
            {fin.slice(-3).map((m, i, arr) => {
              const before = i === 0 ? null : arr[i - 1];
              const d = before ? m.totalCash - before.totalCash : 0;
              const up = d >= 0;
              return (
                <div key={m.ym} className="rounded-lg border border-[#eef3f8] bg-[#fbfdfe] px-3 py-2.5">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-[#8595a8]">{m.label}</div>
                  <div className="text-lg font-bold text-[#1f3559] tabular-nums mt-0.5">{money0(m.totalCash)}</div>
                  {before && (
                    <div className={cn("text-[11px] mt-0.5 flex items-center gap-1",
                                       up ? "text-[#15803d]" : "text-[#dc2626]")}>
                      {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      {up ? "+" : ""}{money0(d)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
