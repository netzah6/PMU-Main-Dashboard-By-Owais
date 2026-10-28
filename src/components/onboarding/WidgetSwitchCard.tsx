"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/* Funnels tab: "Is the Instagram grid + Google reviews switch working?"
   (owner, 10/28/2026). Two answers on one card:
   1. Health — the last funnel-health run (every 3 h): on how many funnels
      both pieces really show, problems open on the Alerts tab, and where
      they don't show because the client still has to do something.
   2. Before/after — picked-a-time and deposits per 100 leads, same funnels,
      the 3 weeks before vs since the switch, V3 and V2.3, with a verdict. */

type Rate = { n: number; k: number; pct: number | null };
type Metric = { before: Rate; after: Rate; liftPct: number | null; z: number | null; verdict: "too_early" | "worse" | "better" | "same"; needN: number };
type Group = { funnels: number; picked: Metric; deposits: Metric };
type Gap = { slug: string; name: string; what: "instagram" | "reviews"; why: string };
type Data = {
  windows: { beforeFrom: string; beforeTo: string; afterFrom: string };
  all: Group; v3: Group; v23: Group;
  depositVerdictEta: string | null;
  health: { ran_at: string; checked: number; grid_ok: number; reviews_ok: number; problems: number; details: { gaps?: Gap[]; problems?: { name: string }[] } } | null;
  openAlerts: number;
};

const us = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" });
const hhmm = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" });

const VERDICT: Record<Metric["verdict"], { label: string; cls: string }> = {
  worse: { label: "Worse — consider rolling back", cls: "bg-[#fde3e3] text-[#b91c1c] border-[#fca5a5]" },
  better: { label: "Better", cls: "bg-[#e7f6ec] text-[#15803d] border-[#86efac]" },
  same: { label: "No real change", cls: "bg-[#eef6ff] text-[#1d4ed8] border-[#bfdbfe]" },
  too_early: { label: "Too early", cls: "bg-[#f1f5f9] text-[#475569] border-[#cbd5e1]" },
};

function MetricRow({ label, m }: { label: string; m: Metric }) {
  const v = VERDICT[m.verdict];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      <span className="w-36 shrink-0 text-[#4a5a6e]">{label}</span>
      <span className="text-[#1c2b3a]">
        {m.before.pct ?? "—"}% → <b>{m.after.pct ?? "—"}%</b>
        {m.liftPct != null && m.after.n > 0 && <span className={cn("ml-1", m.liftPct < 0 ? "text-[#b91c1c]" : "text-[#15803d]")}>({m.liftPct > 0 ? "+" : ""}{m.liftPct}%)</span>}
      </span>
      <span className={cn("rounded-full border px-1.5 py-px text-[10px] font-semibold", v.cls)}>{v.label}</span>
      <span className="text-[10px] text-[#8595a8]">{m.after.n.toLocaleString("en-US")} leads after{m.verdict === "too_early" ? ` (need ${m.needN.toLocaleString("en-US")})` : ""} · {m.before.n.toLocaleString("en-US")} before</span>
    </div>
  );
}

export function WidgetSwitchCard() {
  const [d, setD] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    fetch("/api/onebox/widget-switch").then(async (r) => { const j = await r.json(); if (r.ok) setD(j); }).catch(() => {});
  }, []);
  if (!d) return null;

  const h = d.health;
  const worst = [d.all.picked, d.all.deposits].some((m) => m.verdict === "worse");
  const bad = worst || d.openAlerts > 0;
  const gaps = h?.details?.gaps ?? [];
  const byReason = new Map<string, Gap[]>();
  for (const g of gaps) byReason.set(`${g.what === "instagram" ? "📸" : "⭐"} ${g.why}`, [...(byReason.get(`${g.what === "instagram" ? "📸" : "⭐"} ${g.why}`) ?? []), g]);

  return (
    <div className={cn("mb-4 border rounded-xl bg-white", bad ? "border-[#fca5a5]" : "border-[#e4ebf2]")}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex flex-wrap items-center gap-2 px-4 py-2.5 text-left">
        <span className="text-sm font-medium text-[#1c2b3a]">🧩 Instagram grid + Google reviews — is it working?</span>
        <span className={cn("ml-auto text-xs font-semibold", bad ? "text-[#b91c1c]" : "text-[#15803d]")}>
          {h ? `Showing: grid ${h.grid_ok}/${h.checked} · reviews ${h.reviews_ok}/${h.checked}` : "Health check hasn't run yet"}
          {" · "}
          {d.openAlerts ? `${d.openAlerts} broken (Alerts tab)` : "nothing broken"}
          {" · deposits: "}
          {VERDICT[d.all.deposits.verdict].label.toLowerCase()}
        </span>
        <span className="text-[#697a91] text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-4 text-xs text-[#4a5a6e]">
          <div className="space-y-1">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[#34568a]">1 · Health check</div>
            {h ? (
              <p>Last run {hhmm(h.ran_at)} (every 3 hours): opened all {h.checked} live funnels and loaded every picture, plus what real visitors&apos; phones reported. Instagram grid showing on <b>{h.grid_ok}</b>, Google reviews on <b>{h.reviews_ok}</b>. {d.openAlerts ? <b className="text-[#b91c1c]">{d.openAlerts} funnel{d.openAlerts === 1 ? " has" : "s have"} something broken — see the Alerts tab (🧩).</b> : "Nothing broken."}</p>
            ) : <p>First run is scheduled within 3 hours.</p>}
            {byReason.size > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[#34568a] font-semibold">Not showing on {new Set(gaps.map((g) => g.slug)).size} funnels — the client has to do something (not a bug)</summary>
                <ul className="mt-1 space-y-0.5">
                  {[...byReason.entries()].sort((a, b) => b[1].length - a[1].length).map(([why, list]) => (
                    <li key={why}><b>{why}</b> ({list.length}): {list.map((g) => g.name).join(", ")}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <div className="space-y-1.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[#34568a]">2 · Before vs after the switch</div>
            <p className="text-[11px] text-[#697a91]">Same {d.all.funnels} funnels. Before = {us(d.windows.beforeFrom)}–{us(d.windows.beforeTo)} (old Elfsight widgets). After = since {us(d.windows.afterFrom)} (our grid + our reviews). Deposits count only leads 3+ days old. Not a controlled test — other changes of these weeks move the same numbers, so only a clear drop is called worse.</p>
            {([["All funnels", d.all], ["V3", d.v3], ["V2.3", d.v23]] as const).map(([label, g]) => (
              <div key={label} className="space-y-0.5">
                <div className="text-[11px] font-semibold text-[#1c2b3a]">{label} <span className="font-normal text-[#8595a8]">· {g.funnels} funnels</span></div>
                <MetricRow label="Picked a time" m={g.picked} />
                <MetricRow label="Paid a deposit" m={g.deposits} />
              </div>
            ))}
            {d.depositVerdictEta && <p className="text-[11px] text-[#697a91]">Deposit verdict expected around {us(d.depositVerdictEta)}.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
