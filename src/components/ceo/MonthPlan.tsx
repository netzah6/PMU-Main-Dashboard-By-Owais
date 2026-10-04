"use client";
import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/* This month's plan (owner, 2026-10-04: "a plan every month so I know exactly
   what I need to do"). Built from live data on every open — the profit goal
   for the month on the way to $100k, then four short to-do lists with names.
   Ticks are saved per month; next month starts fresh. */

type Item = { key: string; text: string; detail?: string; done: { by: string | null; at: string } | null };
type Section = { key: string; title: string; why: string; target: string; last: string; ok: boolean | null; items: Item[] };
type Plan = { ym: string; label: string; goalMonth: string; profitGoal: number | null; lastLabel: string; lastProfit: number | null; sections: Section[] };

const k = (n: number | null | undefined) => (n == null ? "—" : `$${(n / 1000).toFixed(1)}k`);
const goalMonthName = (ym: string) => new Date(`${ym}-15T12:00:00`).toLocaleString(undefined, { month: "long", year: "numeric" });

export function MonthPlan() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/ceo/plan").then((r) => r.json()).then((j) => {
      if (j.error) setErr(j.error); else setPlan(j);
    }).catch((e) => setErr(String(e)));
  }, []);

  const toggle = async (it: Item) => {
    if (!plan || saving) return;
    setSaving(it.key);
    try {
      const r = await fetch("/api/ceo/plan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ym: plan.ym, key: it.key, done: !it.done }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Couldn't save");
      setPlan((p) => p && ({ ...p, sections: p.sections.map((s) => ({ ...s, items: s.items.map((x) => (x.key === it.key ? { ...x, done: j.done } : x)) })) }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    } finally { setSaving(null); }
  };

  if (err) return <div className="rounded-lg border border-[#fcd9a8] bg-[#fff7ec] px-3 py-2 text-xs text-[#b45309]">This month&apos;s plan unavailable: {err}</div>;
  if (!plan) return <div className="rounded-xl border border-[#e4ebf2] bg-white p-3 text-xs text-[#8595a8] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Building this month&apos;s plan…</div>;

  const all = plan.sections.flatMap((s) => s.items);
  const doneCount = all.filter((i) => i.done).length;

  return (
    <div className="rounded-xl border border-[#a7e3df] bg-white p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-[#1f3559]">📋 {plan.label} plan</h2>
        <span className="text-xs text-[#697a91]">{doneCount} of {all.length} done</span>
      </div>
      <p className="text-[12px] text-[#34568a]">
        Profit goal this month: <b className="text-[#0e8f88]">{k(plan.profitGoal)}</b>
        <span className="text-[#8595a8]"> ({plan.lastLabel} was {k(plan.lastProfit)} · on the way to $100k by {goalMonthName(plan.goalMonth)})</span>
      </p>
      <div className="space-y-1.5">
        {plan.sections.map((s) => {
          const left = s.items.filter((i) => !i.done).length;
          const isOpen = open[s.key] ?? false;
          return (
            <div key={s.key} className="rounded-lg border border-[#e4ebf2]">
              <button onClick={() => setOpen((o) => ({ ...o, [s.key]: !isOpen }))} aria-expanded={isOpen}
                className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[#f7fdfc]">
                {isOpen ? <ChevronDown size={14} className="mt-0.5 text-[#8595a8]" /> : <ChevronRight size={14} className="mt-0.5 text-[#8595a8]" />}
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-[#1f3559]">{s.title} <span className="font-normal text-[#8595a8]">· {left} to do</span></p>
                  <p className="text-[11px] text-[#697a91]">
                    Goal: <b>{s.target}</b> · <span className={cn(s.ok === true && "text-[#15803d] font-semibold", s.ok === false && "text-[#b91c1c] font-semibold")}>{s.last}</span>
                  </p>
                </div>
              </button>
              {isOpen && (
                <div className="border-t border-[#f1f5f9] px-3 py-2">
                  <p className="text-[11px] text-[#8595a8] mb-1">{s.why}</p>
                  {s.items.length === 0 ? (
                    <p className="text-[12px] text-[#15803d]">Nothing to do here this month ✓</p>
                  ) : (
                    <ul className="space-y-1">
                      {s.items.map((it) => (
                        <li key={it.key}>
                          <button onClick={() => void toggle(it)} disabled={saving === it.key}
                            className="w-full flex items-start gap-2 text-left rounded px-1 py-0.5 hover:bg-[#f7fdfc] disabled:opacity-60">
                            <span className={cn("mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center",
                              it.done ? "bg-[#15803d] border-[#15803d] text-white" : "border-[#c3cdd9] bg-white")}>
                              {saving === it.key ? <Loader2 size={10} className="animate-spin text-[#8595a8]" /> : it.done ? <Check size={11} /> : null}
                            </span>
                            <span className="min-w-0">
                              <span className={cn("block text-[12px] text-[#1f3559]", it.done && "line-through text-[#8595a8]")}>{it.text}</span>
                              {it.detail && <span className="block text-[11px] text-[#8595a8]">{it.detail}{it.done ? ` · done by ${(it.done.by ?? "").split("@")[0]} ${new Date(it.done.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}</span>}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-[#8595a8]">Rebuilt from the live numbers every time you open it. Ticks are saved for this month only — next month gets a fresh plan.</p>
    </div>
  );
}
