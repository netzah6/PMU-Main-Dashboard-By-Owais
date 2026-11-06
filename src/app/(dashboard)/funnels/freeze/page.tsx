"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useUser } from "@/lib/hooks/useUser";
import { cn } from "@/lib/utils";
import { FELL, pct, type Board, type BoardRow } from "@/lib/funnel-freeze";
import { HIGH_BOOKING, HIGH_DEPOSIT } from "@/lib/funnel-timeline-view";
import { FreezeCard, THIN_MONTH, isSuggested, type Action, type SavedPreview } from "@/components/funnels/FreezeCard";
import { Loader2, Search } from "lucide-react";

/* Every funnel's deposit rate, my suggestion to go back after a change, how the pages look,
   and one click to freeze or unfreeze (owner, 11/04/2026). A freeze locks what
   visitors see on the survey, booking and deposit pages; see
   src/lib/funnel-freeze.ts. */

const PAGE = 30;
type Filter = "all" | "suggested" | "fell" | "frozen" | "V3" | "V2.3";

const rank = (r: BoardRow) => (isSuggested(r) ? 0 : r.frozen ? 1 : 2);
/* How far the last 30 days are below the best months, in points. */
const drop = (r: BoardRow) => (r.peak ? (pct(r.peak.d, r.peak.l) ?? 0) - (pct(r.now.d, r.now.l) ?? 0) : 0);

export default function FreezePage() {
  const { role, loading: userLoading } = useUser();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  /* Today's pages and one saved page (before a change, or from the best months) can be
     open together, to compare them. */
  const [openNow, setOpenNow] = useState<string | null>(null);
  const [openSaved, setOpenSaved] = useState<{ slug: string; which: SavedPreview } | null>(null);
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
        : filter === "fell" ? r.fell
        : filter === "frozen" ? !!r.frozen || touched.has(r.slug)
        : r.version.toUpperCase().includes(filter))
      /* On the Fell list: clients whose ads look fine first, then the biggest fall. Everywhere
         else the order from the load. */
      .sort((a, b) => (filter === "fell" ? a.fellHints.length - b.fellHints.length || drop(b) - drop(a) : 0) || (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0));
  }, [rows, q, filter, order, touched]);
  const counts = useMemo(() => ({
    suggested: (rows ?? []).filter(isSuggested).length,
    fell: (rows ?? []).filter((r) => r.fell).length,
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
          ...(action === "decline" ? { declined: j.declined ?? null, goBack: null } : action === "undecline" ? { declined: null }
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
      setOpenSaved(null);
      setPreviewRev((v) => ({ ...v, [r.slug]: (v[r.slug] ?? 0) + 1 }));
      setRowNote((n) => ({ ...n, [r.slug]: `Done. Visitors see the old page within about 3 minutes.${j.drift?.length ? ` GHL still has newer values, so the AI may say something different: ${j.drift.join(", ")}.` : ""}${j.warning ? ` ${j.warning}` : ""}` }));
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
          <p className="mt-1">Only when all of this is true: we changed something on this funnel (not Instagram or reviews). Its booking was {HIGH_BOOKING}%+ or its deposit {HIGH_DEPOSIT}%+ before the change. The rate clearly fell after it and is still low today. Leads did not move much. Nothing else that stays live changed around that time, such as a price, the deposit, the ad budget, the label or the phone. The page from before the change is saved. A page update for all funnels counts only if funnels fell together. Each funnel has few deposits, so this mostly catches booking falls. It could still be chance, so look at the old page first.</p>
        </details>
      )}
      {board && (
        <details className="text-xs text-[#697a91] mb-3">
          <summary className="cursor-pointer text-[#34568a] font-semibold">Who shows under Fell</summary>
          <p className="mt-1">A live client whose best 2 months in a row, in the last 6 months, had {FELL.minPeakRate}%+ deposits ({FELL.minPeakLeads}+ leads, the first month not counted), and whose last 30 days ({FELL.minNowLeads}+ leads) are at {Math.round(FELL.keptAtMost * 100)}% of that or less. It is a list to look at, not proof: more than half of the falls this size are chance, and ads or the AI can be the cause. A freeze keeps today&apos;s page, so it won&apos;t bring an old rate back.</p>
          <p className="mt-1">Each card lists everything that could cause the fall, in 4 groups. <b>Found</b>: a problem in the numbers now that stops deposits, or a change with a date after the best months. <b>Possible</b>: true today, but nobody saved when it began. <b>Can&apos;t check</b>: not in our data, with who to ask. <b>Looks fine</b>: checked with a number. Nothing is written as found, or as fine, unless the data shows it.</p>
        </details>
      )}
      {board?.suggestionsFailed && <p className="text-xs text-[#b91c1c] mb-3">Couldn&apos;t check for suggestions just now. Reload in a minute.</p>}
      {board && !board.suggestionsFailed && counts.suggested === 0 && (
        <p className="text-xs text-[#34568a] mb-3">⭐ No suggestions right now.{Date.now() < Date.parse("2026-11-12T08:00:00Z") ? " Saving changes started 11/04/2026, and a suggestion needs at least 7 days after a change." : " No funnel fell after a change we can reverse."}</p>
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
          ["fell", `📉 Fell${board ? ` (${counts.fell})` : ""}`],
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
          {filter !== "V2.3" && <> · all live V3 clients not frozen, last 30 days: <span className="font-semibold text-[#1c2b3a] tabular-nums">{pct(board.others.d, board.others.l) ?? "—"}%</span></>}
        </div>
      )}

      {error && <div className="text-sm text-[#b91c1c] py-4">{error}</div>}
      {!board && !error && (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-8"><Loader2 className="w-4 h-4 animate-spin" />Counting every funnel&apos;s leads and deposits…</div>
      )}

      <div className="flex flex-col gap-3">
        {list.slice(0, shown).map((r) => (
          <FreezeCard key={r.slug} r={r} engine={board?.engine ?? 0} top={top}
            busy={busy[r.slug]} note={rowNote[r.slug] ?? ""}
            openNow={openNow === r.slug} openSaved={openSaved?.slug === r.slug ? openSaved.which : null} confirmBack={confirmBack === r.slug}
            stamp={stamp} rev={previewRev[r.slug] ?? 0}
            onAct={(action) => void act(r.slug, action)} onGoBack={() => void goBack(r)}
            onToggle={(which) => which === "now"
              ? setOpenNow(openNow === r.slug ? null : r.slug)
              : setOpenSaved(openSaved?.slug === r.slug && openSaved.which === which ? null : { slug: r.slug, which })}
            onConfirmBack={(on) => setConfirmBack(on ? r.slug : null)} />
        ))}
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
