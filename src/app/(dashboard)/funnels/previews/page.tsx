"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { ExternalLink, Loader2, Search } from "lucide-react";

/* Every client's booking page at a glance (owner, 10/28/2026: "I have to fill
   the survey to see the booking page — a lot of manual work, and my clients
   get a new-lead notification"). Each tile is the live funnel opened with
   ?preview=booking: the real page with the client's real open times, but
   strictly read-only (engine v123+) — no lead, no visit, no Meta pixel, no
   booking, no checkout session. 12 tiles at a time; tiles load as they
   scroll into view. */

const BASE = "https://book.pmu-care.com";
const PAGE = 12;
type Row = { slug: string; owner: string; business: string; version: "V3" | "V2.3" | "other"; status: string };

export default function BookingPreviewsPage() {
  const [supabase] = useState(() => createClient());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState("");
  const [ver, setVer] = useState<"all" | "V3" | "V2.3" | "reels">("all");
  const [reelSlugs, setReelSlugs] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [stamp] = useState(() => Date.now()); // fresh page per visit, past the CDN copy

  useEffect(() => {
    fetch("/api/onebox/reel-funnels").then((r) => r.json()).then((j: { slugs?: string[] }) => setReelSlugs(new Set(j.slugs ?? []))).catch(() => {});
  }, []);

  useEffect(() => {
    void (async () => {
      const [{ data: act }, { data: ov }] = await Promise.all([
        supabase.from("onebox_active_clients").select("owner_name, business_name, slug, onebox_status"),
        supabase.from("deposit_overview").select("owner_name, version, client_status"),
      ]);
      const byOwner = new Map((ov ?? []).map((r) => [String(r.owner_name ?? "").toLowerCase().trim(), r as { version: string | null; client_status: string | null }]));
      const out: Row[] = (act ?? [])
        .filter((a) => String(a.onebox_status ?? "").toLowerCase() === "live")
        .map((a) => {
          const o = byOwner.get(String(a.owner_name ?? "").toLowerCase().trim());
          const v = String(o?.version ?? "").toUpperCase();
          return {
            slug: String(a.slug), owner: String(a.owner_name ?? ""), business: String(a.business_name ?? a.slug),
            version: v.includes("V3") ? "V3" : v.includes("V2") ? "V2.3" : "other",
            status: String(o?.client_status ?? ""),
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
        <h1 className="text-base sm:text-lg font-semibold text-[#1c2b3a]">👁 Booking pages — every client</h1>
        <span className="text-xs text-[#697a91]">Preview only: no lead, no notification, nothing booked or charged.</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a client…"
            className="w-full pl-9 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm focus:outline-none focus:border-[#15B7AE]" />
        </div>
        {(["all", "V3", "V2.3", ...(reelSlugs.size ? ["reels" as const] : [])] as const).map((v) => (
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
            {list.slice(0, shown).map((r) => (
              <div key={r.slug} className="rounded-xl border border-[#e4ebf2] bg-white p-2.5 flex flex-col gap-2 min-w-0">
                <div className="flex items-start gap-2 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-[#1c2b3a] truncate" title={r.business}>{r.business}</div>
                    <div className="text-[11px] text-[#697a91] truncate">{r.owner}</div>
                  </div>
                  <span className={cn("shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold", r.version === "V3" ? "bg-[#eef6ff] text-[#1d4ed8] border-[#bfdbfe]" : "bg-[#f5f3ff] text-[#6d28d9] border-[#ddd6fe]")}>{r.version}</span>
                </div>
                {/* A 390 × 780 phone, drawn at 62% so a row fits several clients. */}
                <div className="mx-auto overflow-hidden rounded-[18px] border-4 border-[#1f2937] bg-white" style={{ width: 250, height: 490 }}>
                  <iframe
                    title={`${r.business} booking page`}
                    src={`${BASE}/f/${r.slug}?preview=booking&pv=${stamp}`}
                    loading="lazy"
                    style={{ width: 390, height: 780, border: 0, transform: "scale(0.625)", transformOrigin: "0 0" }}
                  />
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                  <a href={`${BASE}/f/${r.slug}?preview=booking`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-[#0e9c9c] font-semibold hover:underline">Booking page <ExternalLink className="w-3 h-3" /></a>
                  <a href={`${BASE}/f/${r.slug}?preview=thankyou`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-[#34568a] hover:underline">Thank-you page <ExternalLink className="w-3 h-3" /></a>
                </div>
              </div>
            ))}
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
