"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, ExternalLink, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

// Everything billing-related done from the dashboard, newest first: every
// dashboard-subscription charge that went through or failed, and every pause /
// resume sent to Square — each with who did it. The failed ones are what this
// is really for: Square's dunning does not cover dashboard charges, so this is
// where a declined card shows up.

type Row = {
  at: string; kind: string; who: string; amountCents: number | null;
  detail: string; actor: string; link: string | null;
};

const money = (c: number) => `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const LABEL: Record<string, { text: string; cls: string }> = {
  charge_paid:         { text: "paid",          cls: "bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]" },
  charge_failed:       { text: "charge failed", cls: "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]" },
  square_pause:        { text: "Square pause",  cls: "bg-[#fff7ec] text-[#b45309] border-[#fcd9a8]" },
  square_resume:       { text: "Square resume", cls: "bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]" },
  square_cancel_pause: { text: "pause cancelled", cls: "bg-[#eef4ff] text-[#3b6fd4] border-[#c9dbfb]" },
  square_failed:       { text: "Square refused", cls: "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]" },
};

// `inline`: a compact pill that sits in the Dashboard subscriptions header row;
// the list drops down over the page instead of pushing it (owner, 11/02).
export function BillingActivity({ inline = false }: { inline?: boolean } = {}) {
  const [feed, setFeed] = useState<Row[] | null>(null);
  // Sits at the very top of the Subs tab as a dropdown — closed until asked
  // (user, 2026-09-14), so the subscriptions themselves stay in view.
  const [open, setOpen] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  // Clicking the red chip opens the list showing only clients whose LATEST
  // charge failed and nothing paid since — the ones still to charge (owner, 11/02).
  const [onlyUnpaid, setOnlyUnpaid] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/subscriptions/activity");
      if (r.ok) setFeed(((await r.json()).feed as Row[]) ?? []);
      else setFeed([]);
    } catch { setFeed([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const failed = (feed ?? []).filter((r) => r.kind === "charge_failed" || r.kind === "square_failed").length;
  const unpaid = (() => {
    const seen = new Set<string>(); const out: Row[] = [];
    for (const r of feed ?? []) { // newest first
      if ((r.kind !== "charge_paid" && r.kind !== "charge_failed") || seen.has(r.who)) continue;
      seen.add(r.who);
      if (r.kind === "charge_failed") out.push(r);
    }
    return out;
  })();
  const shown = onlyUnpaid ? unpaid
    : (feed ?? []).filter((r) => !onlyProblems || r.kind === "charge_failed" || r.kind === "square_failed");

  return (
    <div className={inline ? "relative" : "rounded-xl border border-[#e4ebf2] bg-white"}>
      <button onClick={() => setOpen((o) => !o)}
        className={inline
          ? "flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-full border border-[#e4ebf2] bg-white text-left hover:border-[#cfe3f7]"
          : "w-full flex items-center gap-2 px-3 py-2 text-left"}>
        <Activity size={inline ? 12 : 14} className="text-[#34568a] shrink-0" />
        {/* Inline on phones: icon only, so the header row fits on one line. */}
        <h2 className={inline ? "hidden sm:block text-[11px] font-bold text-[#1f3559]" : "text-sm font-bold text-[#1f3559]"}>Recent activity</h2>
        <span className={cn("text-[11px] text-[#697a91]", inline && "hidden sm:inline")}>
          {feed === null ? "loading…" : feed.length ? `${feed.length} charge${feed.length === 1 ? "" : "s"} / Square action${feed.length === 1 ? "" : "s"}` : "every charge and Square pause/resume from here"}
        </span>
        {unpaid.length > 0 && (
          <span role="button" tabIndex={0}
            title={`${failed} failed in total — click to see the ${unpaid.length} still unpaid`}
            onClick={(e) => { e.stopPropagation(); const on = !(open && onlyUnpaid); setOnlyUnpaid(on); setOpen(on || open); }}
            className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold border cursor-pointer hover:brightness-95",
              onlyUnpaid && open ? "bg-[#be123c] text-white border-[#be123c]" : "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]")}>
            {unpaid.length} to charge
          </span>
        )}
        {failed > 0 && unpaid.length === 0 && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#fde8ee] text-[#be123c] border border-[#f5c2cf]">
            {failed} failed
          </span>
        )}
        <span className={cn("text-[#8595a8]", inline ? "text-[9px]" : "ml-auto text-xs")}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className={inline
          ? "absolute left-0 top-full mt-1 z-30 w-[min(860px,calc(100vw-2rem))] rounded-xl border border-[#e4ebf2] bg-white shadow-lg p-3 space-y-1.5"
          : "px-3 pb-3 space-y-1.5"}>
          {onlyUnpaid ? (
            <button onClick={() => setOnlyUnpaid(false)} className="text-[11px] font-semibold text-[#be123c] hover:underline">
              Showing {unpaid.length} still to charge (latest charge failed) · show everything
            </button>
          ) : failed > 0 && (
            <label className="flex items-center gap-1.5 text-[11px] text-[#34568a]">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
              Only show failures
            </label>
          )}
          {feed === null ? (
            <div className="flex items-center gap-2 text-xs text-[#697a91] py-2"><Loader2 size={13} className="animate-spin" /> Loading…</div>
          ) : shown.length === 0 ? (
            <p className="text-xs text-[#8595a8] py-1">Nothing yet — charges and Square actions will appear here as they happen.</p>
          ) : (
            <ul className="space-y-1 max-h-[50vh] overflow-y-auto">
              {shown.map((r, i) => {
                const l = LABEL[r.kind] ?? { text: r.kind, cls: "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]" };
                return (
                  <li key={i} className="flex items-center gap-2 flex-wrap text-[11px] rounded-lg border border-[#eef3f8] px-2 py-1">
                    <span className="text-[#8595a8] whitespace-nowrap w-[92px]">{when(r.at)}</span>
                    <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold border whitespace-nowrap", l.cls)}>{l.text}</span>
                    <span className="font-semibold text-[#1f3559]">{r.who}</span>
                    {r.amountCents != null && <span className="font-bold text-[#0e8f88] tabular-nums">{money(r.amountCents)}</span>}
                    <span className={cn("text-[#697a91]", (r.kind === "charge_failed" || r.kind === "square_failed") && "text-[#be123c]")}>{r.detail}</span>
                    <span className="text-[#8595a8]">· by {r.actor}</span>
                    {r.link && (
                      <a href={r.link} target="_blank" rel="noopener noreferrer"
                        className="ml-auto flex items-center gap-1 font-semibold text-[#0e8f88] hover:underline">
                        Receipt <ExternalLink size={10} />
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
