"use client";
import { useEffect, useState } from "react";
import { formatCurrency } from "@/lib/utils";

/* 💎 What one client is worth to us on average (owner, 11/27/2026): lifetime
   service fees + the lead deposits we kept (minus refunds), divided by every
   client in the LTV sheet. Admin only — the page shows it only to admins and
   the data route refuses anyone else. */
type Worth = { clients: number; fees: number; deposits: number; refunds: number; withDeposits: number; months: number };

export function ClientWorthBox() {
  const [w, setW] = useState<Worth | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    fetch("/api/ltv/worth").then((r) => (r.ok ? r.json() : Promise.reject())).then(setW).catch(() => setErr(true));
  }, []);
  if (err) return null;
  const n = w?.clients || 0;
  const fee = n ? w!.fees / n : 0;
  const dep = n ? Math.max(0, w!.deposits - w!.refunds) / n : 0;
  const perMonth = w?.months ? (w.fees + Math.max(0, w.deposits - w.refunds)) / w.months : 0;
  const stay = n && w ? w.months / n : 0;
  const tile = "rounded-lg border border-black/5 px-3 py-2 text-center";
  return (
    <div className="rounded-[14px] border border-[#e4ebf2] bg-white p-3" style={{ boxShadow: "var(--shadow-sm)" }}>
      <div className="flex items-baseline gap-2 flex-wrap mb-2">
        <span className="text-sm font-semibold text-[#1f3559]">💎 Average client worth</span>
        <span className="text-[11px] text-[#8595a8]">{w ? `${n} clients · only you see this` : "loading…"}</span>
      </div>
      <div className="flex items-baseline gap-2 flex-wrap mb-2"
        title="All service fees + deposits (minus refunds), divided by all the months clients stayed with us (first to last month we got money from them).">
        <span className="text-2xl font-bold text-[#0f1b2d]">{w ? formatCurrency(perMonth) : "…"}</span>
        <span className="text-sm text-[#34568a]">per client, per month</span>
        {w && <span className="text-xs text-[#8595a8]">· they stay about {stay.toFixed(1)} months</span>}
      </div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8] mb-1">Whole time with us</div>
      <div className="grid grid-cols-3 gap-2 max-w-xl">
        <div className={tile} style={{ background: "#e6f7f5" }}>
          <p className="text-[10px] font-bold uppercase tracking-wide text-[#1e2a3a]/70">Service fees</p>
          <p className="text-sm font-bold text-[#0e8f88]">{w ? formatCurrency(fee) : "…"}</p>
        </div>
        <div className={tile} style={{ background: "#f5f3ff" }} title={w ? `Deposits ${formatCurrency(w.deposits)} − refunds ${formatCurrency(w.refunds)}, spread over all ${n} clients (${w.withDeposits} had deposits)` : undefined}>
          <p className="text-[10px] font-bold uppercase tracking-wide text-[#1e2a3a]/70">+ Deposits</p>
          <p className="text-sm font-bold text-[#6d28d9]">{w ? formatCurrency(dep) : "…"}</p>
        </div>
        <div className={tile} style={{ background: "#ffe2ad" }}>
          <p className="text-[10px] font-bold uppercase tracking-wide text-[#1e2a3a]/70">= Total per client</p>
          <p className="text-sm font-bold text-[#0f1b2d]">{w ? formatCurrency(fee + dep) : "…"}</p>
        </div>
      </div>
    </div>
  );
}
