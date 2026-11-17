"use client";
import { VersionChip } from "@/components/ui/VersionChip";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { findClientProgram, isV1Label, type ProgramRow } from "@/lib/client-program";
import { ExternalLink, Loader2, Search } from "lucide-react";

/* Every client's booking page at a glance (owner, 10/28/2026: "I have to fill
   the survey to see the booking page — a lot of manual work, and my clients
   get a new-lead notification"). Each tile is the live funnel opened with
   ?preview=booking: the real page with the client's real open times, but
   strictly read-only (engine v123+) — no lead, no visit, no Meta pixel, no
   booking, no checkout session. 12 tiles at a time; tiles load as they
   scroll into view.

   Thank-you pages too (owner, 11/17/2026: "check the thank-you page in one
   click, without filling the survey or the booking — V1, V2.3 and V3"): the
   switch at the top turns every tile into ?preview=thankyou (same read-only
   rules; /funnels/previews?view=thankyou opens it that way). A V1 funnel is
   survey → thank-you only, so its tile always shows the thank-you page. */

const BASE = "https://book.pmu-care.com";
const PAGE = 12;
/* v1Flow = the Clients Master program is "(V1)" exactly. The page itself is
   survey → thank-you only when that holds AND the funnel is not frozen (a
   frozen funnel keeps the full flow it was frozen on) — the same test the
   funnel page makes. */
type Row = { slug: string; owner: string; business: string; version: "V3" | "V2.3" | "V1" | "other"; status: string; v1Flow: boolean };

export default function BookingPreviewsPage() {
  const [supabase] = useState(() => createClient());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState("");
  const [ver, setVer] = useState<"all" | "V3" | "V2.3" | "V1" | "reels">("all");
  const [view, setView] = useState<"booking" | "thankyou">("booking");
  const [reelSlugs, setReelSlugs] = useState<Set<string>>(new Set());
  const [frozenSlugs, setFrozenSlugs] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [stamp] = useState(() => Date.now()); // fresh page per visit, past the CDN copy

  // A direct link can open the thank-you view: /funnels/previews?view=thankyou
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("view") === "thankyou") setView("thankyou");
  }, []);

  useEffect(() => {
    fetch("/api/onebox/reel-funnels").then((r) => r.json()).then((j: { slugs?: string[]; frozen?: string[] }) => {
      setReelSlugs(new Set(j.slugs ?? []));
      setFrozenSlugs(new Set(j.frozen ?? []));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    void (async () => {
      /* The program comes from the Clients Master rows, matched like the funnel
         page matches it (V1 clients are not in the deposits overview at all). */
      const [{ data: act }, { data: ov }, { data: progs }] = await Promise.all([
        supabase.from("onebox_active_clients").select("owner_name, business_name, slug, onebox_status"),
        supabase.from("deposit_overview").select("owner_name, version, client_status"),
        supabase.from("client_program_rows").select("sheet_row, business_name, version, owner_name"),
      ]);
      const byOwner = new Map((ov ?? []).map((r) => [String(r.owner_name ?? "").toLowerCase().trim(), r as { version: string | null; client_status: string | null }]));
      const out: Row[] = (act ?? [])
        .filter((a) => String(a.onebox_status ?? "").toLowerCase() === "live")
        .map((a) => {
          const o = byOwner.get(String(a.owner_name ?? "").toLowerCase().trim());
          const prog = findClientProgram((progs ?? []) as ProgramRow[], String(a.business_name ?? ""));
          const v = String(prog?.version || o?.version || "").toUpperCase();
          return {
            slug: String(a.slug), owner: String(a.owner_name ?? ""), business: String(a.business_name ?? a.slug),
            version: v.includes("V3") ? "V3" : v.includes("V2") ? "V2.3" : isV1Label(v) ? "V1" : "other",
            status: String(o?.client_status ?? ""),
            v1Flow: prog?.version === "(V1)",
          } as Row;
        })
        .filter((r) => r.status.toLowerCase() !== "paused")
        .sort((a, b) => a.business.localeCompare(b.business));
      setRows(out);
    })();
  }, [supabase]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => (ver === "all" || (ver === "reels" ? reelSlugs.has(r.slug) : r.version === ver)) && (!s || `${r.business} ${r.owner} ${r.slug}`.toLowerCase().includes(s)));
  }, [rows, q, ver, reelSlugs]);
  useEffect(() => setShown(PAGE), [q, ver]);

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Link href="/funnels" className="text-sm text-[#0e9c9c] hover:underline">← Funnels</Link>
        <h1 className="text-base sm:text-lg font-semibold text-[#1c2b3a]">{view === "thankyou" ? "🎉 Thank-you pages" : "👁 Booking pages"} — every client</h1>
        <div className="inline-flex rounded-lg border border-[#cbd5e1] overflow-hidden text-xs font-semibold">
          {(["booking", "thankyou"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setView(m)}
              className={cn("px-3 py-1", view === m ? "bg-[#0e9c9c] text-white" : "bg-white text-[#34568a] hover:bg-[#f1f5f9]")}>
              {m === "booking" ? "👁 Booking" : "🎉 Thank-you"}
            </button>
          ))}
        </div>
        <span className="text-xs text-[#697a91]">Preview only: no lead, no notification, nothing booked or charged.</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a client…"
            className="w-full pl-9 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm focus:outline-none focus:border-[#15B7AE]" />
        </div>
        {(["all", "V3", "V2.3", "V1", ...(reelSlugs.size ? ["reels" as const] : [])] as const).map((v) => (
          <button key={v} type="button" onClick={() => setVer(v)}
            className={cn("text-xs font-semibold rounded-full border px-3 py-1", ver === v ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "bg-white text-[#34568a] border-[#cbd5e1] hover:bg-[#f1f5f9]")}>
            {v === "all" ? "All" : v === "reels" ? `🎬 With reels (${reelSlugs.size})` : v}
          </button>
        ))}
        <span className="text-xs text-[#697a91]">{rows ? `${list.length} live funnels` : ""}</span>
      </div>

      {!rows ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-8"><Loader2 className="w-4 h-4 animate-spin" />Loading clients…</div>
      ) : (
        <>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(262px,1fr))]">
            {list.slice(0, shown).map((r) => {
              // V1 = survey → thank-you only: no booking page to show.
              const v1 = r.v1Flow && !frozenSlugs.has(r.slug);
              const mode = v1 ? "thankyou" : view;
              return (
              <div key={r.slug} className="rounded-xl border border-[#e4ebf2] bg-white p-2.5 flex flex-col gap-2 min-w-0">
                <div className="flex items-start gap-2 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-[#1c2b3a] truncate" title={r.business}>{r.business}</div>
                    <div className="text-[11px] text-[#697a91] truncate">{r.owner}</div>
                  </div>
                  <VersionChip version={r.version === "other" ? "" : r.version} className="shrink-0" />
                </div>
                {/* A 390 × 780 phone, drawn at 62% so a row fits several clients. */}
                <div className="mx-auto overflow-hidden rounded-[18px] border-4 border-[#1f2937] bg-white" style={{ width: 250, height: 490 }}>
                  <iframe
                    key={mode}
                    title={`${r.business} ${mode === "thankyou" ? "thank-you" : "booking"} page`}
                    src={`${BASE}/f/${r.slug}?preview=${mode}&pv=${stamp}`}
                    loading="lazy"
                    style={{ width: 390, height: 780, border: 0, transform: "scale(0.625)", transformOrigin: "0 0" }}
                  />
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                  {v1
                    ? <span className="text-[#8595a8]" title="A V1 funnel is survey → thank-you only">No booking page (V1)</span>
                    : <a href={`${BASE}/f/${r.slug}?preview=booking`} target="_blank" rel="noopener" className={cn("inline-flex items-center gap-1 hover:underline", mode === "booking" ? "text-[#0e9c9c] font-semibold" : "text-[#34568a]")}>Booking page <ExternalLink className="w-3 h-3" /></a>}
                  <a href={`${BASE}/f/${r.slug}?preview=thankyou`} target="_blank" rel="noopener" className={cn("inline-flex items-center gap-1 hover:underline", mode === "thankyou" ? "text-[#0e9c9c] font-semibold" : "text-[#34568a]")}>Thank-you page <ExternalLink className="w-3 h-3" /></a>
                </div>
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
        </>
      )}
    </div>
  );
}
