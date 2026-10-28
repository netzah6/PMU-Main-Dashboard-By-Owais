"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Loader2, RefreshCw } from "lucide-react";

/* The one-screen brief at the top of a Cost per Deposit dropdown (owner,
   10/27/2026): status, one headline, up to three lines on what's going on,
   up to three ranked actions with the expected gain and who does it.
   Written daily by src/lib/cpd-brief.ts; "Refresh" recomputes it now. */

type Action = { title: string; why: string; gain: string; who: "us" | "client" | "owner"; code: string };
export type BriefData = {
  slug: string; status: "fix" | "watch" | "good"; headline: string; situation: string[]; actions: Action[]; watch: string | null;
  model: string | null; computed_at: string;
};

const TONE: Record<BriefData["status"], { label: string; bg: string; fg: string; ring: string }> = {
  fix: { label: "Needs work", bg: "#fde3e3", fg: "#b91c1c", ring: "#fca5a5" },
  watch: { label: "Check", bg: "#fff3e0", fg: "#c2410c", ring: "#fdba74" },
  good: { label: "Healthy", bg: "#e7f6ec", fg: "#15803d", ring: "#86efac" },
};
const WHO: Record<Action["who"], { label: string; cls: string }> = {
  us: { label: "we do it", cls: "bg-[#e8f1ff] text-[#1d4ed8] border-[#bfdbfe]" },
  client: { label: "ask the artist", cls: "bg-[#fdf2f8] text-[#be185d] border-[#fbcfe8]" },
  owner: { label: "your call", cls: "bg-[#f3e8ff] text-[#6d28d9] border-[#ddd6fe]" },
};

const when = (iso: string) => {
  const d = new Date(iso);
  const h = (Date.now() - d.getTime()) / 3600_000;
  if (h < 1) return "just now";
  if (h < 24) return `${Math.round(h)}h ago`;
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" });
};

export function CpdBrief({ ownerKey, onBrief }: { ownerKey: string; onBrief?: (b: BriefData | null) => void }) {
  const [brief, setBrief] = useState<BriefData | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [noOnebox, setNoOnebox] = useState(false);
  const [slug, setSlug] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBrief(undefined); setErr(null); setNoOnebox(false);
    fetch(`/api/onebox/cpd-brief?ownerKey=${encodeURIComponent(ownerKey)}`)
      .then((r) => r.json())
      .then((j: { brief: BriefData | null; slug: string | null }) => { if (!alive) return; setBrief(j.brief); setSlug(j.slug); setNoOnebox(!j.slug); onBrief?.(j.brief); })
      .catch(() => { if (alive) { setBrief(null); setErr("Couldn't load the brief."); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey]);

  const refresh = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/onebox/cpd-brief", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerKey }) });
      const j = (await r.json()) as { brief?: BriefData | null; error?: string };
      if (!r.ok) throw new Error(j.error || "Refresh failed");
      setBrief(j.brief ?? null); onBrief?.(j.brief ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setBusy(false);
    }
  };

  if (noOnebox) return null;
  if (brief === undefined) return <div className="flex items-center gap-2 text-xs text-[#697a91] py-2"><Loader2 size={13} className="animate-spin" />Loading the brief…</div>;

  const tone = brief ? TONE[brief.status] : null;
  return (
    <div className="rounded-lg border bg-white p-3" style={{ borderColor: tone?.ring ?? "#e4ebf2" }}>
      <div className="flex flex-wrap items-center gap-2 mb-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wide text-[#34568a]">🧭 In short</span>
        {brief && <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide" style={{ background: tone!.bg, color: tone!.fg }}>{tone!.label}</span>}
        {brief && <span className="text-[10px] text-[#8595a8]" title={brief.model ? `Written by ${brief.model}` : "Rule-based (model unavailable)"}>updated {when(brief.computed_at)}</span>}
        {slug && (
          <a href={`https://book.pmu-care.com/f/${slug}?preview=booking`} target="_blank" rel="noopener" title="Open this client's booking page — preview only, no lead is created"
            className="ml-auto inline-flex items-center gap-1 rounded-full border border-[#cbd5e1] bg-white px-2 py-0.5 text-[10px] font-semibold text-[#34568a] hover:bg-[#f1f5f9]">
            👁 Booking page
          </a>
        )}
        <button type="button" onClick={() => void refresh()} disabled={busy}
          className={cn(slug ? "" : "ml-auto", "inline-flex items-center gap-1 rounded-full border border-[#cbd5e1] bg-white px-2 py-0.5 text-[10px] font-semibold text-[#34568a] hover:bg-[#f1f5f9] disabled:opacity-50")}>
          {busy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}{busy ? "Thinking…" : "Refresh"}
        </button>
      </div>
      {err && <div className="text-[11px] text-[#b91c1c] mb-1">{err}</div>}
      {!brief ? (
        <div className="text-xs text-[#697a91]">No brief yet — press Refresh (takes ~10 seconds).</div>
      ) : (
        <>
          <div className="text-[13px] font-bold text-[#1f3559] leading-snug">{brief.headline}</div>
          {brief.situation.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {brief.situation.map((s, i) => <li key={i} className="text-[12px] text-[#34568a] leading-snug">• {s}</li>)}
            </ul>
          )}
          {brief.actions.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-[#0e8f88] mb-1">Do next</div>
              <ol className="space-y-1.5">
                {brief.actions.map((a, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#0e8f88] text-[10px] font-bold text-white">{i + 1}</span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[12px] font-semibold text-[#1f3559]">{a.title}</span>
                        <span className={cn("rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide", WHO[a.who].cls)}>{WHO[a.who].label}</span>
                        {a.gain && a.gain !== "unclear" && <span className="text-[10px] font-semibold text-[#15803d]">{a.gain}</span>}
                      </div>
                      <div className="text-[11px] text-[#56678a] leading-snug">{a.why}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {brief.watch && <div className="mt-2 text-[11px] text-[#697a91]">👀 {brief.watch}</div>}
        </>
      )}
    </div>
  );
}
