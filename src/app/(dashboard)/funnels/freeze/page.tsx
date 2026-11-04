"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useUser } from "@/lib/hooks/useUser";
import { cn } from "@/lib/utils";
import { versionStyle } from "@/lib/version-style";
import { pct, monthLabel, RULE, type Board, type BoardRow } from "@/lib/funnel-freeze";
import { ChevronDown, ExternalLink, Loader2, Search } from "lucide-react";

/* Every funnel's deposit rate, my suggestion to freeze it, how the pages look,
   and one click to freeze or unfreeze (owner, 11/04/2026). A freeze keeps the
   survey, booking and deposit pages exactly as they are that day; see
   src/lib/funnel-freeze.ts. */

const BASE = "https://book.pmu-care.com";
const PAGE = 30;
const PAGES = [
  { key: "survey", label: "Survey" },
  { key: "booking", label: "Calendar" },
  { key: "deposit", label: "Deposit" },
];
type Filter = "all" | "suggested" | "frozen" | "V3" | "V2.3";

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "America/Los_Angeles" }) : "";
const fmtPct = (d: number | null | undefined, l: number | null | undefined) => {
  const p = d != null && l != null ? pct(d, l) : null;
  return p == null ? "—" : `${p}%`;
};
const isSuggested = (r: BoardRow) => r.rule.ok && !r.frozen && !r.declined;
const rank = (r: BoardRow) => (isSuggested(r) ? 0 : r.frozen ? 1 : 2);

function Stat({ label, d, l, extra, strong }: { label: string; d: number | null | undefined; l: number | null | undefined; extra?: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[#697a91] leading-tight">{label}</div>
      <div className={cn("text-lg font-semibold leading-snug tabular-nums", strong ? "text-[#1c2b3a]" : "text-[#34568a]")}>{fmtPct(d, l)}</div>
      <div className="text-[11px] text-[#697a91] leading-tight tabular-nums">
        {d != null && l != null ? `${d} of ${l} leads` : "no count"}{extra ? ` · ${extra}` : ""}
      </div>
    </div>
  );
}

/* One small bar per month, same scale across every client so a tall bar always
   means the same rate. The current month is still filling up, so it is paler. */
function MonthBars({ row, top }: { row: BoardRow; top: number }) {
  const frozenMonth = row.frozen?.at ? new Date(row.frozen.at).toISOString().slice(0, 7) : "";
  return (
    <div className="flex items-end gap-1.5 overflow-x-auto" role="img" aria-label={`Deposits per 100 leads by month for ${row.business}`}>
      {row.months.map((m, i) => {
        const p = pct(m.d, m.l);
        const current = i === row.months.length - 1;
        return (
          <div key={m.m} className="flex flex-col items-center w-9 shrink-0" title={`${monthLabel(m.m)}: ${m.d} deposits of ${m.l} leads${current ? " (month not over)" : ""}`}>
            <div className="text-[10px] text-[#34568a] tabular-nums h-3.5">{p == null ? "" : `${Math.round(p)}%`}</div>
            <div className="h-10 w-full flex items-end border-b border-[#e4ebf2]">
              {p != null && <div className={cn("w-full rounded-t", current ? "bg-[#a7dcd9]" : "bg-[#0e9c9c]")} style={{ height: `${Math.max(2, Math.min(100, (p / top) * 100))}%` }} />}
            </div>
            <div className="text-[10px] text-[#697a91] mt-0.5">{monthLabel(m.m)}{frozenMonth === m.m ? " 🧊" : ""}</div>
          </div>
        );
      })}
    </div>
  );
}

function PagePreviews({ slug, stamp }: { slug: string; stamp: number }) {
  return (
    <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
      {PAGES.map((p) => (
        <div key={p.key} className="shrink-0">
          <a href={`${BASE}/f/${slug}?preview=${p.key}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-xs font-semibold text-[#0e9c9c] hover:underline mb-1">
            {p.label} <ExternalLink className="w-3 h-3" />
          </a>
          <div className="overflow-hidden rounded-[18px] border-4 border-[#1f2937] bg-white" style={{ width: 218, height: 430 }}>
            <iframe title={`${slug} ${p.label} page`} src={`${BASE}/f/${slug}?preview=${p.key}&pv=${stamp}`} loading="lazy"
              style={{ width: 390, height: 770, border: 0, transform: "scale(0.5385)", transformOrigin: "0 0" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function FreezePage() {
  const { role, loading: userLoading } = useUser();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [stamp] = useState(() => Date.now());

  useEffect(() => {
    if (role !== "admin") return;
    fetch("/api/onebox/freeze")
      .then(async (r) => { const j = await r.json(); if (r.ok) setBoard(j as Board); else setError(j.error ?? "Couldn't load"); })
      .catch(() => setError("Couldn't load"));
  }, [role]);
  useEffect(() => setShown(PAGE), [q, filter]);

  const rows = board?.rows;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? [])
      .filter((r) => !s || `${r.business} ${r.owner} ${r.slug}`.toLowerCase().includes(s))
      .filter((r) => filter === "all" ? true
        : filter === "suggested" ? isSuggested(r)
        : filter === "frozen" ? !!r.frozen
        : r.version.toUpperCase().includes(filter))
      .sort((a, b) => rank(a) - rank(b) || (pct(b.now.d, b.now.l) ?? -1) - (pct(a.now.d, a.now.l) ?? -1) || a.business.localeCompare(b.business));
  }, [rows, q, filter]);
  const counts = useMemo(() => ({
    suggested: (rows ?? []).filter(isSuggested).length,
    frozen: (rows ?? []).filter((r) => r.frozen).length,
  }), [rows]);
  /* A shared height for every client's bars; one tiny funnel at 50% can't flatten the rest. */
  const top = useMemo(() => {
    const rates = (rows ?? []).flatMap((r) => r.months.filter((m) => m.l >= 20).map((m) => pct(m.d, m.l) ?? 0));
    return Math.max(10, ...rates);
  }, [rows]);

  const act = async (slug: string, action: "freeze" | "unfreeze" | "decline" | "undecline") => {
    setBusy(`${action}:${slug}`);
    setRowError((e) => ({ ...e, [slug]: "" }));
    try {
      const res = await fetch("/api/onebox/freeze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, action }) });
      const j = await res.json();
      if (!res.ok) { setRowError((e) => ({ ...e, [slug]: j.error ?? "That didn't work" })); return; }
      setBoard((b) => b && {
        ...b,
        rows: b.rows.map((r) => r.slug !== slug ? r : {
          ...r,
          ...(action === "freeze" || action === "unfreeze" ? { frozen: j.frozen ?? null } : { declined: j.declined ?? null }),
        }),
      });
    } catch {
      setRowError((e) => ({ ...e, [slug]: "That didn't work. Check your connection and try again." }));
    } finally {
      setBusy("");
    }
  };

  if (!userLoading && role !== "admin") return <div className="p-8 text-[#697a91]">Admins only.</div>;

  return (
    <div className="p-3 md:p-6 max-w-[1100px] mx-auto">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <Link href="/funnels" className="text-sm text-[#0e9c9c] hover:underline">← Funnels</Link>
        <h1 className="text-base sm:text-lg font-semibold text-[#1c2b3a]">🧊 Freeze a funnel</h1>
      </div>
      <p className="text-sm text-[#34568a] mb-1">Freeze keeps a client&apos;s survey, calendar and deposit pages exactly as they are today. New page changes and split tests skip them. Click again to undo.</p>
      <p className="text-xs text-[#697a91] mb-3">Can still change: offers and prices, Instagram pictures, Google reviews, the AI, checkout, ads. % = deposits per 100 leads.</p>

      {board && (
        <details className="text-xs text-[#697a91] mb-3">
          <summary className="cursor-pointer text-[#34568a] font-semibold">How I pick who to suggest</summary>
          <p className="mt-1">On V3 and live, a new lead in the last {RULE.leadWithinDays} days, {RULE.minHistoryLeads}+ leads before {board.ruleMonths[0]}, and {RULE.minMonthLeads}+ leads with {RULE.minRate}%+ in both {board.ruleMonths[0]} and {board.ruleMonths[1]}. It&apos;s a judgment call, not a test: a freeze protects a page, it doesn&apos;t add deposits.</p>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a client…"
            className="w-full pl-9 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm focus:outline-none focus:border-[#15B7AE]" />
        </div>
        {([
          ["all", "All"],
          ["suggested", `⭐ Suggested (${counts.suggested})`],
          ["frozen", `🧊 Frozen (${counts.frozen})`],
          ["V3", "V3"],
          ["V2.3", "V2.3"],
        ] as [Filter, string][]).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setFilter(k)}
            className={cn("text-xs font-semibold rounded-full border px-3 py-1", filter === k ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "bg-white text-[#34568a] border-[#cbd5e1] hover:bg-[#f1f5f9]")}>
            {label}
          </button>
        ))}
      </div>

      {board && (
        <div className="text-xs text-[#697a91] mb-3">
          {list.length} funnels · other V3 clients, last 30 days: <span className="font-semibold text-[#1c2b3a] tabular-nums">{fmtPct(board.others.d, board.others.l)}</span>
        </div>
      )}

      {error && <div className="text-sm text-[#b91c1c] py-4">{error}</div>}
      {!board && !error && (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-8"><Loader2 className="w-4 h-4 animate-spin" />Counting every funnel&apos;s leads and deposits…</div>
      )}

      <div className="flex flex-col gap-3">
        {list.slice(0, shown).map((r) => {
          const suggested = isSuggested(r);
          const v1Label = r.version === "(V1)";
          const freezing = busy === `freeze:${r.slug}` || busy === `unfreeze:${r.slug}`;
          return (
            <div key={r.slug} className={cn("rounded-xl border bg-white p-3", r.frozen ? "border-[#bfdbfe]" : suggested ? "border-[#0e9c9c]" : "border-[#e4ebf2]")}>
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-[#1c2b3a]">{r.business}</div>
                  <div className="text-[11px] text-[#697a91]">{r.owner}</div>
                </div>
                {r.version && (() => { const vs = versionStyle(r.version); return <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold" style={{ background: vs.bg, color: vs.text, borderColor: vs.border }}>{r.version.replace(/[()]/g, "")}</span>; })()}
                {r.frozen && <span className="shrink-0 rounded-full border px-2 py-px text-[11px] font-bold bg-[#eef6ff] text-[#1d4ed8] border-[#bfdbfe]">🧊 Frozen since {fmtDate(r.frozen.at)}</span>}
                {suggested && <span className="shrink-0 rounded-full border px-2 py-px text-[11px] font-bold bg-[#e8f7f6] text-[#0b7a7a] border-[#a7dcd9]">⭐ I suggest freezing</span>}
              </div>

              <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
                <Stat label="Before 08/24/2026" d={r.before.d} l={r.before.l} />
                {r.suggested && <Stat label={`When suggested ${fmtDate(r.suggested.at)}`} d={r.suggested.d} l={r.suggested.l} />}
                {r.frozen && <Stat label={`When frozen ${fmtDate(r.frozen.at)}`} d={r.frozen.d} l={r.frozen.l} />}
                <Stat label="Now, last 30 days" d={r.now.d} l={r.now.l} extra={`${r.now.picks} picked a time`} strong />
              </div>

              <div className="mt-2"><MonthBars row={r} top={top} /></div>

              {suggested && <p className="mt-2 text-xs text-[#34568a]">Why: {r.rule.why}.</p>}
              {r.declined && !r.frozen && <p className="mt-2 text-xs text-[#697a91]">Not suggesting this one{r.declined.note ? `: ${r.declined.note}` : "."}</p>}
              {r.suggested && !suggested && !r.frozen && !r.declined && <p className="mt-2 text-xs text-[#697a91]">No longer suggested: {r.rule.why}.</p>}
              {r.fell && !r.frozen && (
                <p className="mt-2 text-xs text-[#b45309]">⚠ This rate fell. Freezing keeps today&apos;s page, so it won&apos;t bring the old rate back.</p>
              )}
              {v1Label && <p className="mt-2 text-xs text-[#b45309]">⚠ On (V1){r.frozen ? ": the label says no calendar or deposit, but the freeze keeps the full page. Unfreeze if the label is right." : ", with no calendar or deposit page. Switch the label before freezing."}</p>}
              {r.frozen && r.frozen.engine !== board?.engine && <p className="mt-2 text-xs text-[#697a91]">Staying on page version {r.frozen.engine}. Other clients are on {board?.engine}.</p>}
              {rowError[r.slug] && <p className="mt-2 text-xs text-[#b91c1c]">{rowError[r.slug]}</p>}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {r.frozen ? (
                  <button type="button" disabled={freezing} onClick={() => void act(r.slug, "unfreeze")}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg border border-[#cbd5e1] bg-white text-[#34568a] px-3 py-1.5 hover:bg-[#f1f5f9] disabled:opacity-60">
                    {freezing && <Loader2 className="w-4 h-4 animate-spin" />}{freezing ? "Unfreezing…" : "Unfreeze"}
                  </button>
                ) : (
                  <button type="button" disabled={freezing || v1Label} onClick={() => void act(r.slug, "freeze")}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg bg-[#0e9c9c] text-white px-3 py-1.5 hover:bg-[#0b8383] disabled:opacity-50">
                    {freezing ? <Loader2 className="w-4 h-4 animate-spin" /> : "🧊"} {freezing ? "Freezing…" : "Freeze"}
                  </button>
                )}
                <button type="button" onClick={() => setOpen(open === r.slug ? null : r.slug)}
                  className="inline-flex items-center gap-1 text-sm rounded-lg border border-[#e4ebf2] px-3 py-1.5 text-[#34568a] hover:bg-[#f6f9fc]">
                  👁 {r.frozen ? "See frozen pages" : "See how it would stay"} <ChevronDown className={cn("w-4 h-4 transition-transform", open === r.slug && "rotate-180")} />
                </button>
                {suggested && (
                  <button type="button" disabled={busy === `decline:${r.slug}`} onClick={() => void act(r.slug, "decline")} className="inline-flex items-center gap-1 text-xs text-[#697a91] hover:underline disabled:opacity-60">
                    {busy === `decline:${r.slug}` && <Loader2 className="w-3 h-3 animate-spin" />}Don&apos;t suggest
                  </button>
                )}
                {r.declined && !r.frozen && (
                  <button type="button" disabled={busy === `undecline:${r.slug}`} onClick={() => void act(r.slug, "undecline")} className="inline-flex items-center gap-1 text-xs text-[#697a91] hover:underline disabled:opacity-60">
                    {busy === `undecline:${r.slug}` && <Loader2 className="w-3 h-3 animate-spin" />}Suggest again
                  </button>
                )}
              </div>

              {open === r.slug && <PagePreviews slug={r.slug} stamp={stamp} />}
            </div>
          );
        })}
      </div>

      {shown < list.length && (
        <div className="text-center my-6">
          <button type="button" onClick={() => setShown((n) => n + PAGE)} className="text-sm font-semibold rounded-lg border border-[#cbd5e1] bg-white px-4 py-2 hover:bg-[#f1f5f9]">
            Show {Math.min(PAGE, list.length - shown)} more ({list.length - shown} left)
          </button>
        </div>
      )}
    </div>
  );
}
