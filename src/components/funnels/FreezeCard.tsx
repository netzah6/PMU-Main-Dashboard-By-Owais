"use client";
import { cn } from "@/lib/utils";
import { versionStyle } from "@/lib/version-style";
import { laMonth, pct, monthLabel, peakLabel, type BoardRow } from "@/lib/funnel-freeze";
import { changeText, goBackWhy } from "@/lib/funnel-timeline-view";
import { ChevronDown, ExternalLink, Loader2 } from "lucide-react";

/* One funnel on the Freeze screen (src/app/(dashboard)/funnels/freeze/page.tsx).
   Freeze and the page preview sit next to the client name, so a card with nothing
   else to say has no button row (owner, 11/05/2026: "save some scrolling space"). */

const BASE = "https://book.pmu-care.com";
/* Under this many leads a month's % says nothing, so it isn't printed. */
export const THIN_MONTH = 20;
export type Action = "freeze" | "unfreeze" | "decline" | "undecline" | "accept" | "restore";
/* A saved page from the past: the one before a change, or the one from the best months. */
export type SavedPreview = "old" | "peak";
export type Preview = "now" | SavedPreview;

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "America/Los_Angeles" }) : "";
export const isSuggested = (r: BoardRow) => !!r.goBack && !r.frozen;

function Stat({ label, d, l, extra, strong }: { label: string; d: number | null | undefined; l: number | null | undefined; extra?: React.ReactNode; strong?: boolean }) {
  const known = d != null && l != null;
  const p = known ? pct(d, l) : null;
  const count = !known ? "no count" : l ? `${d} of ${l} leads` : d ? `${d} deposit${d === 1 ? "" : "s"}, no leads` : "no leads";
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[#697a91] leading-tight">{label}</div>
      <div className={cn("text-lg font-semibold leading-snug tabular-nums", strong ? "text-[#1c2b3a]" : "text-[#34568a]")}>{p == null ? "—" : `${p}%`}</div>
      <div className="text-[11px] text-[#697a91] leading-tight tabular-nums">{count}{extra ? <> · {extra}</> : null}</div>
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
           zeros aren't a measured 0%. */
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
  /* A saved page from an earlier date, instead of today's. */
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

export type FreezeCardProps = {
  r: BoardRow;
  /* The page version other funnels run today. */
  engine: number;
  top: number;
  busy: Action | undefined;
  note: string;
  /* Today's pages and one saved page can be open together, to compare them. */
  openNow: boolean;
  openSaved: SavedPreview | null;
  confirmBack: boolean;
  stamp: number;
  rev: number;
  onAct: (action: Action) => void;
  onGoBack: () => void;
  onToggle: (which: Preview) => void;
  onConfirmBack: (on: boolean) => void;
};

const SMALL_BUTTON = "inline-flex items-center gap-1 text-xs font-semibold rounded-lg border px-2.5 py-1 disabled:opacity-60";

export function FreezeCard({ r, engine, top, busy, note, openNow, openSaved, confirmBack, stamp, rev, onAct, onGoBack, onToggle, onConfirmBack }: FreezeCardProps) {
  const suggested = isSuggested(r);
  const v1Label = r.version.replace(/[()]/g, "").trim().toUpperCase() === "V1";
  const freezing = busy === "freeze" || busy === "unfreeze";
  const vs = r.version ? versionStyle(r.version) : null;
  const fewThroughPage = r.now.l >= 20 && r.now.pageLeads < r.now.l * 0.7;
  const showPutBack = !!r.restorable && !r.frozen;
  const showSuggestAgain = !!r.declined && !r.frozen && !suggested;
  const previewLabel = r.frozen ? "See frozen pages" : "See how it would stay";
  const bestRate = r.peak ? pct(r.peak.d, r.peak.l) ?? 0 : 0;
  const nowRate = pct(r.now.d, r.now.l) ?? 0;
  return (
    <div className={cn("rounded-xl border bg-white p-3", r.frozen ? "border-[#bfdbfe]" : suggested ? "border-[#0e9c9c]" : r.fell ? "border-[#f0c48a]" : "border-[#e4ebf2]")}>
      {/* Line 1: the name, with the two buttons at its right. Line 2: owner and chips across
          the full width, so a long name or owner never squeezes them on a phone. */}
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <div className="min-w-0 flex-1 break-words text-sm font-semibold text-[#1c2b3a]">{r.business}</div>
        <div className="flex shrink-0 items-center gap-1.5">
          {r.frozen ? (
            <button type="button" disabled={!!busy} onClick={() => onAct("unfreeze")} className={cn(SMALL_BUTTON, "border-[#cbd5e1] bg-white text-[#34568a] hover:bg-[#f1f5f9]")}>
              {freezing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{freezing ? "Unfreezing…" : "Unfreeze"}
            </button>
          ) : (
            <button type="button" disabled={!!busy || v1Label} onClick={() => onAct("freeze")} className={cn(SMALL_BUTTON, "border-[#0e9c9c] bg-white text-[#0b7a7a] hover:bg-[#e8f7f6]")}>
              {freezing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "🧊"} {freezing ? "Freezing…" : "Freeze"}
            </button>
          )}
          <button type="button" onClick={() => onToggle("now")} title={previewLabel} aria-label={previewLabel} aria-expanded={openNow} className={cn(SMALL_BUTTON, "border-[#e4ebf2] bg-white font-normal text-[#34568a] hover:bg-[#f6f9fc]")}>
            👁 <span className="sm:hidden">View</span><span className="hidden sm:inline">{previewLabel}</span>
            <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", openNow && "rotate-180")} />
          </button>
        </div>
        <div className="flex basis-full flex-wrap items-center gap-x-1.5 gap-y-1">
          {r.owner && <span className="text-[11px] text-[#697a91]">{r.owner}</span>}
          {vs && <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold" style={{ background: vs.bg, color: vs.text, borderColor: vs.border }}>{r.version.replace(/[()]/g, "")}</span>}
          {r.matched && r.clientStatus !== "live" && <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold bg-[#f1f5f9] text-[#64748b] border-[#d7e0ea] capitalize">{r.clientStatus || "no status"}</span>}
          {r.frozen && <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold bg-[#eef6ff] text-[#1d4ed8] border-[#bfdbfe]">🧊 Frozen since {fmtDate(r.frozen.at)}</span>}
          {suggested && <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold bg-[#e8f7f6] text-[#0b7a7a] border-[#a7dcd9]">⭐ I suggest going back</span>}
          {r.fell && <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold bg-[#fff7ed] text-[#b45309] border-[#f0c48a]">📉 Fell</span>}
        </div>
      </div>

      {r.matched ? (
        <>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
            {/* Only when it really was better: the last weeks never count toward it, so "now" can be higher. */}
            {r.peak && bestRate > nowRate && <Stat label={`Best months: ${peakLabel(r.peak)}`} d={r.peak.d} l={r.peak.l} />}
            {r.goBack && r.suggested && <Stat label={`When suggested ${fmtDate(r.suggested.at)}`} d={r.suggested.d} l={r.suggested.l} />}
            {r.frozen && <Stat label={`When frozen ${fmtDate(r.frozen.at)}`} d={r.frozen.d} l={r.frozen.l} />}
            <Stat label="Now, last 30 days" d={r.now.d} l={r.now.l} extra={<>{r.now.picks} picked<span className="hidden sm:inline"> a time</span></>} strong />
          </div>
          <div className="mt-2"><MonthBars row={r} top={top} /></div>
        </>
      ) : (
        <p className="mt-2 text-xs text-[#697a91]">This name doesn&apos;t match the Clients sheet, so there are no numbers.</p>
      )}

      {r.fell && r.peak && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#b45309]">
          <span>📉 Fell from {bestRate}% in {peakLabel(r.peak)} to {nowRate}% now.{r.frozen ? "" : " A freeze won't bring this back."}</span>
          {r.peakPage && !r.peakPage.sameAsNow && (
            <button type="button" onClick={() => onToggle("peak")} aria-expanded={openSaved === "peak"} className={cn(SMALL_BUTTON, "border-[#f0c48a] bg-white text-[#b45309] hover:bg-[#fff7ed]")}>
              👁 See the page from {peakLabel(r.peak)} <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", openSaved === "peak" && "rotate-180")} />
            </button>
          )}
          {r.peakPage?.sameAsNow && <span className="text-[#697a91]">The page is still the same as back then.</span>}
          {!r.peakPage && <span className="text-[#697a91]">{r.peak.to < "2026-11" ? "That page wasn't saved. Saving started 11/04/2026." : "No saved page was found for those months."}</span>}
          <a href={`/funnels/timeline?q=${encodeURIComponent(r.business)}`} target="_blank" rel="noopener" className="font-semibold text-[#0e9c9c] hover:underline">🕒 Timeline</a>
        </div>
      )}
      {r.fell && r.fellHints.map((h) => <p key={h} className="mt-1 text-xs text-[#b45309]">⚠ {h}</p>)}
      {r.fell && v1Label && <p className="mt-1 text-xs text-[#b45309]">⚠ The label is (V1), so this page has no calendar or deposit step. If that&apos;s a mistake, fix the label.</p>}
      {r.peakPage && !r.peakPage.sameAsNow && openSaved === "peak" && <PagePreviews row={r} stamp={stamp} rev={0} saved={r.peakPage} />}

      {suggested && r.goBack && (
        <p className="mt-2 text-xs text-[#34568a]">Why: {goBackWhy(r.goBack)} after we changed this on {fmtDate(r.goBack.changeAt)}: {r.goBack.changes.slice(0, 3).map(changeText).join("; ")}{r.goBack.changes.length > 3 ? `; and ${r.goBack.changes.length - 3} more` : ""}. It could still be chance.</p>
      )}
      {showSuggestAgain && <p className="mt-2 text-xs text-[#697a91]">You chose not to go back. I&apos;ll only suggest it again after a new change{r.declined?.note ? `. Note: ${r.declined.note}` : "."}</p>}
      {fewThroughPage && <p className="mt-2 text-xs text-[#b45309]">⚠ Only {r.now.pageLeads} of {r.now.l} leads came through this page, so these numbers are mostly about another page.</p>}
      {r.payLinkElsewhere && <p className="mt-2 text-xs text-[#b45309]">⚠ The AI&apos;s deposit link goes to an old GHL page, which a freeze doesn&apos;t cover.</p>}
      {v1Label && r.frozen && <p className="mt-2 text-xs text-[#b45309]">⚠ The label says (V1), but the freeze keeps the calendar and deposit pages. Unfreeze if the label is right.</p>}
      {v1Label && !r.frozen && !r.fell && <p className="mt-2 text-xs text-[#b45309]">⚠ On (V1): survey only, so it can&apos;t be frozen. If the label is wrong, fix it first; that also changes the live page.</p>}
      {r.frozen && r.frozen.engine !== engine && <p className="mt-2 text-xs text-[#697a91]">Staying on page version {r.frozen.engine}. Other clients are on {engine}.</p>}
      {r.frozen && r.drift.length > 0 && (
        <div className="mt-2 text-xs text-[#b45309]">
          <p>⚠ Changed in GHL since the freeze, so the page and the AI can disagree: {r.drift.map((x) => x.to !== undefined ? `${x.label} (page: ${x.from || "empty"}, GHL: ${x.to || "empty"})` : x.label).join("; ")}.</p>
          <button type="button" disabled={!!busy} onClick={() => onAct("accept")}
            className="mt-1 inline-flex items-center gap-1.5 font-semibold rounded-lg border border-[#f0c48a] bg-white text-[#b45309] px-2.5 py-1 hover:bg-[#fff7ed] disabled:opacity-60">
            {busy === "accept" && <Loader2 className="w-3 h-3 animate-spin" />}{busy === "accept" ? "Updating…" : "Use the new values on the page"}
          </button>
        </div>
      )}
      {note && <p className={cn("mt-2 text-xs", note.startsWith("Done") ? "text-[#15803d]" : "text-[#b91c1c]")}>{note}</p>}

      {suggested && r.goBack && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {confirmBack ? (
            <>
              <span className="text-xs text-[#b45309]">Change the live page to the one saved {fmtDate(r.goBack.savedAt)}? This undoes: {r.goBack.undoes.join(", ")}. The funnel stays frozen on that page until you unfreeze it. Deposit, phone, address, calendar and checkout stay as they are now.</span>
              <button type="button" disabled={!!busy} onClick={onGoBack} className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg bg-[#0e9c9c] text-white px-3 py-1.5 hover:bg-[#0b8383] disabled:opacity-60">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}Yes, go back
              </button>
              <button type="button" disabled={!!busy} onClick={() => onConfirmBack(false)} className="text-xs text-[#697a91] hover:underline">No</button>
            </>
          ) : (
            <button type="button" disabled={!!busy} onClick={() => onConfirmBack(true)} className="text-sm font-semibold rounded-lg bg-[#0e9c9c] text-white px-3 py-1.5 hover:bg-[#0b8383] disabled:opacity-60">↩ Go back to the page saved {fmtDate(r.goBack.savedAt)}</button>
          )}
          <button type="button" onClick={() => onToggle("old")} aria-expanded={openSaved === "old"} className="inline-flex items-center gap-1 text-sm rounded-lg border border-[#e4ebf2] px-3 py-1.5 text-[#34568a] hover:bg-[#f6f9fc]">
            👁 See the old page <ChevronDown className={cn("w-4 h-4 transition-transform", openSaved === "old" && "rotate-180")} />
          </button>
          <button type="button" disabled={!!busy} onClick={() => onAct("decline")} className="inline-flex items-center gap-1 text-xs text-[#697a91] hover:underline disabled:opacity-60">
            {busy === "decline" && <Loader2 className="w-3 h-3 animate-spin" />}Don&apos;t suggest
          </button>
        </div>
      )}
      {suggested && r.goBack && openSaved === "old" && <PagePreviews row={r} stamp={stamp} rev={0} saved={{ id: r.goBack.versionId, sig: r.goBack.previewSig }} />}

      {(showPutBack || showSuggestAgain) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {showPutBack && (
            <button type="button" disabled={!!busy} onClick={() => onAct("restore")} className={cn(SMALL_BUTTON, "border-[#bfdbfe] bg-[#eef6ff] font-normal text-[#1d4ed8] hover:bg-[#e0efff]")}>
              {busy === "restore" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}↩ Put back the page frozen {fmtDate(r.restorable?.at)}
            </button>
          )}
          {showSuggestAgain && (
            <button type="button" disabled={!!busy} onClick={() => onAct("undecline")} className="inline-flex items-center gap-1 text-xs text-[#697a91] hover:underline disabled:opacity-60">
              {busy === "undecline" && <Loader2 className="w-3 h-3 animate-spin" />}Suggest again
            </button>
          )}
        </div>
      )}

      {openNow && <PagePreviews row={r} stamp={stamp} rev={rev} />}
    </div>
  );
}
