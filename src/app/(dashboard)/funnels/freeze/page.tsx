"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useUser } from "@/lib/hooks/useUser";
import { cn } from "@/lib/utils";
import { versionStyle } from "@/lib/version-style";
import { laMonth, pct, monthLabel, type Board, type BoardRow } from "@/lib/funnel-freeze";
import { changeText, goBackWhy } from "@/lib/funnel-timeline-view";
import { ChevronDown, ExternalLink, Loader2, Search } from "lucide-react";

/* Every funnel's deposit rate, my suggestion to freeze it, how the pages look,
   and one click to freeze or unfreeze (owner, 11/04/2026). A freeze locks what
   visitors see on the survey, booking and deposit pages; see
   src/lib/funnel-freeze.ts. */

const BASE = "https://book.pmu-care.com";
const PAGE = 30;
/* Under this many leads a month's % says nothing, so it isn't printed. */
const THIN_MONTH = 20;
type Filter = "all" | "suggested" | "frozen" | "V3" | "V2.3";
type Action = "freeze" | "unfreeze" | "decline" | "undecline" | "accept" | "restore";

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "America/Los_Angeles" }) : "";
const isSuggested = (r: BoardRow) => !!r.goBack && !r.frozen && !r.declined;
const rank = (r: BoardRow) => (isSuggested(r) ? 0 : r.frozen ? 1 : 2);

function Stat({ label, d, l, extra, strong, zeroNote }: { label: string; d: number | null | undefined; l: number | null | undefined; extra?: string; strong?: boolean; zeroNote?: string }) {
  const known = d != null && l != null;
  const p = known ? pct(d, l) : null;
  const showZeroNote = !!zeroNote && d === 0 && !!l;
  const count = !known ? "no count" : l ? `${d} of ${l} leads` : d ? `${d} deposit${d === 1 ? "" : "s"}, no leads` : "no leads";
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[#697a91] leading-tight">{label}</div>
      <div className={cn("text-lg font-semibold leading-snug tabular-nums", strong ? "text-[#1c2b3a]" : "text-[#34568a]")}>{p == null || showZeroNote ? "—" : `${p}%`}</div>
      <div className="text-[11px] text-[#697a91] leading-tight tabular-nums">{showZeroNote ? `${zeroNote} (${l} leads)` : count}{extra ? ` · ${extra}` : ""}</div>
    </div>
  );
}

/* One small bar per month, same scale across every client so a tall bar always
   means the same rate. The current month and any thin month are paler and carry
   no %, so "Nov 0%" on the 4th of the month can't read as a collapse. */
function MonthBars({ row, top }: { row: BoardRow; top: number }) {
  const frozenMonth = row.frozen?.at ? laMonth(new Date(row.frozen.at)) : "";
  return (
    <div className="flex items-end gap-1.5 overflow-x-auto" role="img" aria-label={`Deposits per 100 leads by month for ${row.business}`}>
      {row.months.map((m, i) => {
        const p = pct(m.d, m.l);
        const current = i === row.months.length - 1;
        /* Deposits weren't recorded yet for many clients back then, so those
           zeros aren't a measured 0%, same as the "no deposits recorded" stat. */
        const unrecorded = row.before.d === 0 && m.d === 0 && m.m <= "2026-08";
        const firm = !current && m.l >= THIN_MONTH && !unrecorded;
        return (
          <div key={m.m} className="flex flex-col items-center w-9 shrink-0" title={`${monthLabel(m.m)}: ${m.d} deposits of ${m.l} leads${current ? " (month not over)" : ""}`}>
            <div className="text-[10px] text-[#34568a] tabular-nums h-3.5">{p != null && firm ? `${Math.round(p)}%` : ""}</div>
            <div className="h-10 w-full flex items-end border-b border-[#e4ebf2]">
              {p != null && <div className={cn("w-full rounded-t", firm ? "bg-[#0e9c9c]" : "bg-[#a7dcd9]")} style={{ height: `${Math.max(2, Math.min(100, (p / top) * 100))}%` }} />}
            </div>
            <div className="text-[10px] text-[#697a91] mt-0.5 leading-tight text-center">
              {monthLabel(m.m)}{frozenMonth === m.m ? " 🧊" : ""}
              {current && <div className="text-[9px]">so far</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* Only the pages this funnel really has: on (V1) the engine shows the survey
   for every preview link, and a free-booking funnel has no deposit step. */
function pagesFor(r: BoardRow) {
  const out = [{ key: "survey", label: "Survey" }];
  if (r.version === "(V1)" && !r.frozen) return out;
  out.push({ key: "booking", label: "Calendar" });
  if (!r.freeBooking) out.push({ key: "deposit", label: "Deposit" });
  return out;
}

function PagePreviews({ row, stamp, rev, saved }: { row: BoardRow; stamp: number; rev: number; saved?: { id: number; sig: string } }) {
  /* A saved page from before a change, instead of today's. */
  const old = saved ? `&fzv=${saved.id}&fzs=${saved.sig}` : "";
  /* The version and edit count in the address, so a funnel just unfrozen or
     updated isn't served its old copy. */
  const fz = `${row.frozen?.engine ?? 0}.${rev}`;
  return (
    <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
      {pagesFor(row).map((p) => (
        <div key={`${p.key}:${fz}`} className="shrink-0">
          <a href={`${BASE}/f/${row.slug}?preview=${p.key}${old}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-xs font-semibold text-[#0e9c9c] hover:underline mb-1">
            {p.label} <ExternalLink className="w-3 h-3" />
          </a>
          <div className="relative overflow-hidden rounded-[18px] border-4 border-[#1f2937] bg-white" style={{ width: 218, height: 430 }}>
            <div className="absolute inset-0 flex items-center justify-center text-[#697a91]"><Loader2 className="w-5 h-5 animate-spin" /></div>
            <iframe title={`${row.business} ${p.label} page`} src={`${BASE}/f/${row.slug}?preview=${p.key}${old}&pv=${stamp}&fz=${fz}`} loading="lazy"
              style={{ position: "relative", width: 390, height: 770, border: 0, transform: "scale(0.5385)", transformOrigin: "0 0" }} />
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
  const [openOld, setOpenOld] = useState<string | null>(null);
  const [confirmBack, setConfirmBack] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, Action>>({});
  const [rowNote, setRowNote] = useState<Record<string, string>>({});
  /* The order and the rows you've acted on are fixed until a reload: a card that
     jumped away on Freeze would put the next client's button under your finger. */
  const [order, setOrder] = useState<Map<string, number>>(new Map());
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [previewRev, setPreviewRev] = useState<Record<string, number>>({});
  const [stamp] = useState(() => Date.now());

  useEffect(() => {
    if (role !== "admin") return;
    fetch("/api/onebox/freeze")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) { setError(j.error ?? "Couldn't load"); return; }
        const b = j as Board;
        const sorted = [...b.rows].sort((x, y) => rank(x) - rank(y) || (pct(y.now.d, y.now.l) ?? -1) - (pct(x.now.d, x.now.l) ?? -1) || x.business.localeCompare(y.business));
        setOrder(new Map(sorted.map((r2, i) => [r2.slug, i])));
        setBoard(b);
      })
      .catch(() => setError("Couldn't load"));
  }, [role]);
  useEffect(() => setShown(PAGE), [q, filter]);
  /* An acted-on card stays only on the filter it was acted on. */
  useEffect(() => setTouched(new Set()), [filter]);

  const rows = board?.rows;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? [])
      .filter((r) => !s || `${r.business} ${r.owner} ${r.slug}`.toLowerCase().includes(s))
      .filter((r) => filter === "all" ? true
        : filter === "suggested" ? isSuggested(r) || touched.has(r.slug)
        : filter === "frozen" ? !!r.frozen || touched.has(r.slug)
        : r.version.toUpperCase().includes(filter))
      .sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0));
  }, [rows, q, filter, order, touched]);
  const counts = useMemo(() => ({
    suggested: (rows ?? []).filter(isSuggested).length,
    frozen: (rows ?? []).filter((r) => r.frozen).length,
  }), [rows]);
  /* A shared height for every client's bars; one tiny funnel at 50% can't flatten the rest. */
  const top = useMemo(() => {
    const rates = (rows ?? []).flatMap((r) => r.months.filter((m) => m.l >= THIN_MONTH).map((m) => pct(m.d, m.l) ?? 0));
    return Math.max(10, ...rates);
  }, [rows]);

  const act = async (slug: string, action: Action) => {
    setBusy((b) => ({ ...b, [slug]: action }));
    setRowNote((n) => ({ ...n, [slug]: "" }));
    try {
      const res = await fetch("/api/onebox/freeze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, action }) });
      const j = await res.json();
      if (!res.ok) { setRowNote((n) => ({ ...n, [slug]: j.error ?? "That didn't work" })); return; }
      if (j.warning) setRowNote((n) => ({ ...n, [slug]: j.warning }));
      setPreviewRev((v) => ({ ...v, [slug]: (v[slug] ?? 0) + 1 }));
      setTouched((t) => new Set(t).add(slug));
      setBoard((b) => b && {
        ...b,
        rows: b.rows.map((r) => r.slug !== slug ? r : {
          ...r,
          ...(action === "decline" || action === "undecline" ? { declined: j.declined ?? null }
            : action === "accept" ? { drift: [] }
            : { frozen: j.frozen ?? null, drift: j.drift ?? [], restorable: j.restorable ?? null }),
        }),
      });
    } catch {
      setRowNote((n) => ({ ...n, [slug]: "That didn't work. Check your connection and try again." }));
    } finally {
      setBusy((b) => { const rest = { ...b }; delete rest[slug]; return rest; });
    }
  };

  /* Goes through the Timeline's lock: the funnel stays on that saved page until unfrozen. */
  const goBack = async (r: BoardRow) => {
    if (!r.goBack) return;
    setBusy((b) => ({ ...b, [r.slug]: "freeze" }));
    setRowNote((n) => ({ ...n, [r.slug]: "" }));
    try {
      const res = await fetch("/api/onebox/timeline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "goback", slug: r.slug, versionId: r.goBack.versionId }) });
      const j = await res.json();
      if (!res.ok) { setRowNote((n) => ({ ...n, [r.slug]: j.error ?? "That didn't work" })); return; }
      setTouched((t) => new Set(t).add(r.slug));
      setConfirmBack(null);
      setOpenOld(null);
      setPreviewRev((v) => ({ ...v, [r.slug]: (v[r.slug] ?? 0) + 1 }));
      setRowNote((n) => ({ ...n, [r.slug]: `Done. Visitors see the old page within about 3 minutes.${j.drift?.length ? ` GHL still has newer values, so the AI may say something different: ${j.drift.join(", ")}.` : ""}` }));
      setBoard((b) => b && {
        ...b,
        rows: b.rows.map((x) => x.slug !== r.slug ? x : { ...x, goBack: null, restorable: null, frozen: { engine: j.engine, at: j.lockedAt, by: null, l: null, d: null } }),
      });
    } catch {
      setRowNote((n) => ({ ...n, [r.slug]: "That didn't work. Check your connection and try again." }));
    } finally {
      setBusy((b) => { const rest = { ...b }; delete rest[r.slug]; return rest; });
    }
  };

  if (userLoading) return <div className="flex items-center gap-2 text-sm text-[#697a91] p-8"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>;
  if (role !== "admin") return <div className="p-8 text-[#697a91]">Admins only.</div>;

  return (
    <div className="p-3 md:p-6 max-w-[1100px] mx-auto">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <Link href="/funnels" className="text-sm text-[#0e9c9c] hover:underline">← Funnels</Link>
        <h1 className="text-base sm:text-lg font-semibold text-[#1c2b3a]">🧊 Freeze a funnel</h1>
      </div>
      <p className="text-sm text-[#34568a] mb-1">Freeze locks everything visitors see on a client&apos;s survey, calendar and deposit pages: design, wording, questions, FAQs, photos, logo, offer, Instagram, reviews. New page changes and split tests skip them. Click again to undo.</p>
      <p className="text-xs text-[#697a91] mb-3">Stays live so booking and payment keep working: open times, calendar, checkout, deposit amount, free booking, video mode, phone, address, Meta pixel. Can&apos;t be frozen: the AI, texts, ads. % = deposits per 100 leads.</p>

      {board && (
        <details className="text-xs text-[#697a91] mb-3">
          <summary className="cursor-pointer text-[#34568a] font-semibold">When I suggest going back</summary>
          <p className="mt-1">Only when all of this is true: we changed something on the funnel (not Instagram or reviews), the booking or deposit rate clearly fell after it, leads did not drop, the ads, label and deposit did not change around the same time, and the page from before the change is saved. It could still be chance, so look at the old page first.</p>
        </details>
      )}
      {board && counts.suggested === 0 && (
        <p className="text-xs text-[#34568a] mb-3">⭐ No suggestions right now. Counting changes started 11/04/2026, so a suggestion needs at least 7 days after a change.</p>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a client…"
            className="w-full pl-9 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm focus:outline-none focus:border-[#15B7AE]" />
        </div>
        {([
          ["all", "All"],
          ["suggested", `⭐ Suggested${board ? ` (${counts.suggested})` : ""}`],
          ["frozen", `🧊 Frozen${board ? ` (${counts.frozen})` : ""}`],
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
          {list.length} funnels
          {filter !== "V2.3" && <> · all V3 clients not frozen, last 30 days: <span className="font-semibold text-[#1c2b3a] tabular-nums">{pct(board.others.d, board.others.l) ?? "—"}%</span></>}
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
          const rowBusy = busy[r.slug];
          const freezing = rowBusy === "freeze" || rowBusy === "unfreeze";
          const vs = r.version ? versionStyle(r.version) : null;
          const fewThroughPage = r.now.l >= 20 && r.now.pageLeads < r.now.l * 0.7;
          return (
            <div key={r.slug} className={cn("rounded-xl border bg-white p-3", r.frozen ? "border-[#bfdbfe]" : suggested ? "border-[#0e9c9c]" : "border-[#e4ebf2]")}>
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-[#1c2b3a]">{r.business}</div>
                  <div className="text-[11px] text-[#697a91]">{r.owner}</div>
                </div>
                {vs && <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold" style={{ background: vs.bg, color: vs.text, borderColor: vs.border }}>{r.version.replace(/[()]/g, "")}</span>}
                {r.matched && r.clientStatus !== "live" && <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold bg-[#f1f5f9] text-[#64748b] border-[#d7e0ea] capitalize">{r.clientStatus || "no status"}</span>}
                {r.frozen && <span className="shrink-0 rounded-full border px-2 py-px text-[11px] font-bold bg-[#eef6ff] text-[#1d4ed8] border-[#bfdbfe]">🧊 Frozen since {fmtDate(r.frozen.at)}</span>}
                {suggested && <span className="shrink-0 rounded-full border px-2 py-px text-[11px] font-bold bg-[#e8f7f6] text-[#0b7a7a] border-[#a7dcd9]">⭐ I suggest going back</span>}
              </div>

              {r.matched ? (
                <>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
                    <Stat label="04/27–08/23/2026" d={r.before.d} l={r.before.l} zeroNote="no deposits recorded" />
                    {r.goBack && r.suggested && <Stat label={`When suggested ${fmtDate(r.suggested.at)}`} d={r.suggested.d} l={r.suggested.l} />}
                    {r.frozen && <Stat label={`When frozen ${fmtDate(r.frozen.at)}`} d={r.frozen.d} l={r.frozen.l} />}
                    <Stat label="Now, last 30 days" d={r.now.d} l={r.now.l} extra={`${r.now.picks} picked a time`} strong />
                  </div>
                  <div className="mt-2"><MonthBars row={r} top={top} /></div>
                </>
              ) : (
                <p className="mt-2 text-xs text-[#697a91]">This name doesn&apos;t match the Clients sheet, so there are no numbers.</p>
              )}

              {suggested && r.goBack && (
                <p className="mt-2 text-xs text-[#34568a]">Why: {goBackWhy(r.goBack)} after we changed this on {fmtDate(r.goBack.changeAt)}: {r.goBack.changes.slice(0, 3).map(changeText).join("; ")}. It could still be chance.</p>
              )}
              {r.declined && !r.frozen && <p className="mt-2 text-xs text-[#697a91]">Not suggesting this one{r.declined.note ? `: ${r.declined.note}` : "."}</p>}
              {r.fell && !r.frozen && (
                <p className="mt-2 text-xs text-[#b45309]">⚠ This rate fell. Freezing keeps today&apos;s page, so it won&apos;t bring the old rate back.</p>
              )}
              {fewThroughPage && <p className="mt-2 text-xs text-[#b45309]">⚠ Only {r.now.pageLeads} of {r.now.l} leads came through this page, so these numbers are mostly about another page.</p>}
              {r.payLinkElsewhere && <p className="mt-2 text-xs text-[#b45309]">⚠ The AI&apos;s deposit link goes to an old GHL page, which a freeze doesn&apos;t cover.</p>}
              {v1Label && <p className="mt-2 text-xs text-[#b45309]">⚠ {r.frozen ? "The label says (V1), but the freeze keeps the calendar and deposit pages. Unfreeze if the label is right." : "On (V1): survey only, so it can't be frozen. If the label is wrong, fix it first; that also changes the live page."}</p>}
              {r.frozen && r.frozen.engine !== board?.engine && <p className="mt-2 text-xs text-[#697a91]">Staying on page version {r.frozen.engine}. Other clients are on {board?.engine}.</p>}
              {r.frozen && r.drift.length > 0 && (
                <div className="mt-2 text-xs text-[#b45309]">
                  <p>⚠ Changed in GHL since the freeze, so the page and the AI can disagree: {r.drift.map((x) => x.to !== undefined ? `${x.label} (page: ${x.from || "empty"}, GHL: ${x.to || "empty"})` : x.label).join("; ")}.</p>
                  <button type="button" disabled={!!rowBusy} onClick={() => void act(r.slug, "accept")}
                    className="mt-1 inline-flex items-center gap-1.5 font-semibold rounded-lg border border-[#f0c48a] bg-white text-[#b45309] px-2.5 py-1 hover:bg-[#fff7ed] disabled:opacity-60">
                    {rowBusy === "accept" && <Loader2 className="w-3 h-3 animate-spin" />}{rowBusy === "accept" ? "Updating…" : "Use the new values on the page"}
                  </button>
                </div>
              )}
              {rowNote[r.slug] && <p className="mt-2 text-xs text-[#b91c1c]">{rowNote[r.slug]}</p>}

              {suggested && r.goBack && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {confirmBack === r.slug ? (
                    <>
                      <span className="text-xs text-[#b45309]">Change the live page to the one saved {fmtDate(r.goBack.savedAt)}? Deposit, phone, address, calendar and checkout stay as they are now.</span>
                      <button type="button" disabled={!!rowBusy} onClick={() => void goBack(r)} className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg bg-[#0e9c9c] text-white px-3 py-1.5 hover:bg-[#0b8383] disabled:opacity-60">
                        {rowBusy && <Loader2 className="w-4 h-4 animate-spin" />}Yes, go back
                      </button>
                      <button type="button" disabled={!!rowBusy} onClick={() => setConfirmBack(null)} className="text-xs text-[#697a91] hover:underline">No</button>
                    </>
                  ) : (
                    <button type="button" disabled={!!rowBusy} onClick={() => setConfirmBack(r.slug)} className="text-sm font-semibold rounded-lg bg-[#0e9c9c] text-white px-3 py-1.5 hover:bg-[#0b8383] disabled:opacity-60">↩ Go back to the page saved {fmtDate(r.goBack.savedAt)}</button>
                  )}
                  <button type="button" onClick={() => setOpenOld(openOld === r.slug ? null : r.slug)} className="inline-flex items-center gap-1 text-sm rounded-lg border border-[#e4ebf2] px-3 py-1.5 text-[#34568a] hover:bg-[#f6f9fc]">
                    👁 See the old page <ChevronDown className={cn("w-4 h-4 transition-transform", openOld === r.slug && "rotate-180")} />
                  </button>
                </div>
              )}
              {suggested && r.goBack && openOld === r.slug && <PagePreviews row={r} stamp={stamp} rev={0} saved={{ id: r.goBack.versionId, sig: r.goBack.previewSig }} />}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {r.frozen ? (
                  <button type="button" disabled={!!rowBusy} onClick={() => void act(r.slug, "unfreeze")}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg border border-[#cbd5e1] bg-white text-[#34568a] px-3 py-1.5 hover:bg-[#f1f5f9] disabled:opacity-60">
                    {freezing && <Loader2 className="w-4 h-4 animate-spin" />}{freezing ? "Unfreezing…" : "Unfreeze"}
                  </button>
                ) : (
                  <button type="button" disabled={!!rowBusy || v1Label} onClick={() => void act(r.slug, "freeze")}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg border border-[#0e9c9c] text-[#0b7a7a] bg-white px-3 py-1.5 hover:bg-[#e8f7f6] disabled:opacity-50">
                    {freezing ? <Loader2 className="w-4 h-4 animate-spin" /> : "🧊"} {freezing ? "Freezing…" : "Freeze"}
                  </button>
                )}
                <button type="button" onClick={() => setOpen(open === r.slug ? null : r.slug)}
                  className="inline-flex items-center gap-1 text-sm rounded-lg border border-[#e4ebf2] px-3 py-1.5 text-[#34568a] hover:bg-[#f6f9fc]">
                  👁 {r.frozen ? "See frozen pages" : "See how it would stay"} <ChevronDown className={cn("w-4 h-4 transition-transform", open === r.slug && "rotate-180")} />
                </button>
                {suggested && (
                  <button type="button" disabled={!!rowBusy} onClick={() => void act(r.slug, "decline")} className="inline-flex items-center gap-1 text-xs text-[#697a91] hover:underline disabled:opacity-60">
                    {rowBusy === "decline" && <Loader2 className="w-3 h-3 animate-spin" />}Don&apos;t suggest
                  </button>
                )}
                {r.restorable && !r.frozen && (
                  <button type="button" disabled={!!rowBusy} onClick={() => void act(r.slug, "restore")}
                    className="inline-flex items-center gap-1.5 text-sm rounded-lg border border-[#bfdbfe] bg-[#eef6ff] text-[#1d4ed8] px-3 py-1.5 hover:bg-[#e0efff] disabled:opacity-60">
                    {rowBusy === "restore" && <Loader2 className="w-4 h-4 animate-spin" />}↩ Put back the page frozen {fmtDate(r.restorable.at)}
                  </button>
                )}
                {r.declined && !r.frozen && (
                  <button type="button" disabled={!!rowBusy} onClick={() => void act(r.slug, "undecline")} className="inline-flex items-center gap-1 text-xs text-[#697a91] hover:underline disabled:opacity-60">
                    {rowBusy === "undecline" && <Loader2 className="w-3 h-3 animate-spin" />}Suggest again
                  </button>
                )}
              </div>

              {open === r.slug && <PagePreviews row={r} stamp={stamp} rev={previewRev[r.slug] ?? 0} />}
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
