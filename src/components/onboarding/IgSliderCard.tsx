"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/* Funnels tab: "Do visitors tap a post and keep swiping?" (owner,
   10/29/2026: should the Instagram slider show more than 12 posts?).
   Collapsed: the headline numbers + where the decision stands. Open: how
   far people swipe, which tile they tap first, who goes on to book, per day.
   Data: /api/onebox/ig-slider (engine v125+ beacons). */

type Group = { people: number; linked: number; picked: number; pickedPct: number | null; paid: number; paidPct: number | null };
type Data = {
  since: string;
  viewers: number; users: number; openPct: number | null;
  avgSeen: number | null; avgAvail: number | null; avgOpens: number | null; avgSwipes: number | null;
  past6: number; past6Pct: number | null; ended: number; endPct: number | null; reelUsers: number;
  buckets: { label: string; n: number }[];
  firstTile: { tile: number; n: number }[];
  daily: { day: string; viewers: number; users: number }[];
  outcome: { none: Group; in6: Group; past6: Group };
  decide: { openers: number; endShare: number };
  verdict: { state: "collecting" | "more" | "enough"; text: string };
};

const us = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" });
const n = (x: number) => x.toLocaleString("en-US");
const VERDICT = {
  collecting: "bg-[#f1f5f9] text-[#475569] border-[#cbd5e1]",
  more: "bg-[#fff7e6] text-[#b45309] border-[#fcd34d]",
  enough: "bg-[#e7f6ec] text-[#15803d] border-[#86efac]",
};

function Bars({ rows }: { rows: { label: string; n: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  const total = rows.reduce((a, r) => a + r.n, 0);
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-right text-[#4a5a6e]">{r.label}</span>
          <div className="flex-1 h-3 rounded bg-[#f1f5f9] overflow-hidden"><div className="h-full bg-[#15B7AE]" style={{ width: `${(r.n / max) * 100}%` }} /></div>
          <span className="w-20 shrink-0 text-[#1c2b3a]">{n(r.n)}{total ? <span className="text-[#8595a8]"> · {Math.round((r.n / total) * 100)}%</span> : null}</span>
        </div>
      ))}
    </div>
  );
}

export function IgSliderCard() {
  const [d, setD] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch("/api/onebox/ig-slider").then(async (r) => { const j = await r.json(); if (r.ok) setD(j); else setErr(j.error || "Couldn't load"); }).catch(() => setErr("Couldn't load"));
  }, []);
  if (err) return <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white px-4 py-2.5 text-xs text-[#b91c1c]">📱 Instagram slider: {err}</div>;
  if (!d) return <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white px-4 py-2.5 text-xs text-[#697a91]">📱 Instagram slider — loading…</div>;

  const o = d.outcome;
  const row = (label: string, g: Group) => (
    <tr className="border-t border-[#eef2f6]">
      <td className="py-1 pr-3 text-[#4a5a6e]">{label}</td>
      <td className="py-1 pr-3 text-right">{n(g.people)}</td>
      <td className="py-1 pr-3 text-right">{g.pickedPct == null ? "—" : `${g.pickedPct}%`} <span className="text-[#8595a8]">({g.picked}/{g.linked})</span></td>
      <td className="py-1 text-right">{g.paidPct == null ? "—" : `${g.paidPct}%`} <span className="text-[#8595a8]">({g.paid}/{g.linked})</span></td>
    </tr>
  );

  return (
    <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white">
      <button onClick={() => setOpen((x) => !x)} className="w-full flex flex-wrap items-center gap-2 px-4 py-2.5 text-left">
        <span className="text-sm font-medium text-[#1c2b3a]">📱 Instagram slider — do visitors keep swiping?</span>
        <span className="ml-auto text-xs text-[#4a5a6e]">
          {d.openPct ?? 0}% open it · {d.past6Pct ?? 0}% of them go past the 6 · {d.endPct ?? 0}% view all
        </span>
        <span className={cn("rounded-full border px-1.5 py-px text-[10px] font-semibold", VERDICT[d.verdict.state])}>
          {d.verdict.state === "collecting" ? `Collecting ${d.users}/${d.decide.openers}` : d.verdict.state === "more" ? "Test more posts" : "12 is enough"}
        </span>
        <span className="text-[#697a91] text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-4 text-xs text-[#4a5a6e]">
          <p className="text-[#1c2b3a]">{d.verdict.text}</p>

          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
            {[
              ["Saw the 6-tile grid", n(d.viewers)],
              ["Tapped a post", `${n(d.users)} (${d.openPct ?? 0}%)`],
              ["Posts viewed (avg)", `${d.avgSeen ?? "—"} of ${d.avgAvail ?? "—"}`],
              ["Went past the 6", `${n(d.past6)} (${d.past6Pct ?? 0}%)`],
              ["Viewed every post", `${n(d.ended)} (${d.endPct ?? 0}%)`],
              ["Watched a reel", n(d.reelUsers)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-[#eef2f6] bg-[#fafcfd] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-[#8595a8]">{k}</div>
                <div className="text-sm font-semibold text-[#1c2b3a]">{v}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 font-semibold text-[#1c2b3a]">How many posts they viewed</div>
              <Bars rows={d.buckets} />
            </div>
            <div className="min-w-0">
              <div className="mb-1 font-semibold text-[#1c2b3a]">Which tile they tapped first</div>
              <Bars rows={d.firstTile.map((t) => ({ label: `Tile ${t.tile}`, n: t.n }))} />
            </div>
          </div>

          <div className="min-w-0">
            <div className="mb-1 font-semibold text-[#1c2b3a]">Who went on to book</div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px]">
                <thead><tr className="text-[10px] uppercase tracking-wide text-[#8595a8]">
                  <th className="text-left font-normal pb-1">Grid viewers who…</th><th className="text-right font-normal pb-1 pr-3">People</th>
                  <th className="text-right font-normal pb-1 pr-3">Picked a time</th><th className="text-right font-normal pb-1">Paid deposit</th>
                </tr></thead>
                <tbody>
                  {row("Didn't tap a post", o.none)}
                  {row("Tapped, stayed in the 6", o.in6)}
                  {row("Swiped past the 6", o.past6)}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[10px] text-[#8595a8]">People who swipe are often keener to begin with, so this shows who books, not what the slider causes. Deposits keep coming in for about a week after each visit.</p>
          </div>

          <div className="min-w-0">
            <div className="mb-1 font-semibold text-[#1c2b3a]">Per day</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {d.daily.slice(0, 14).map((x) => (
                <span key={x.day}>{us(x.day)}: <b className="text-[#1c2b3a]">{n(x.users)}</b> of {n(x.viewers)} tapped</span>
              ))}
            </div>
          </div>

          <p className="text-[10px] text-[#8595a8]">
            Counting since {new Date(d.since).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })}. The slider holds the best 12 posts (6 grid tiles + 6 more).
            Decision point: {d.decide.openers} people who tapped a post. If {d.decide.endShare}%+ of them view every post, test a longer slider; otherwise keep 12.
          </p>
        </div>
      )}
    </div>
  );
}
