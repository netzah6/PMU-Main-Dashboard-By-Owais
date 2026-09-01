"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2, ChevronRight, RefreshCw, ExternalLink, Search, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PixelCheckRow, PageAudit, Check } from "@/lib/pixel-check";

// Pixel Checking — every live client's funnel, page by page: which Meta
// pixel/dataset is installed and which conversion actually FIRES on each step,
// checked against the desired structure:
//   1. PageView on the survey page   2. Lead on the booking page
//   3. Schedule on the deposit page  4. Purchase on the thank-you page
// Rows come from the 2026-08-31 full-roster audit; ↻ re-crawls a client live.

type RowChecks = { pv1?: Check; lead2?: Check; sched3?: Check; purchase4?: Check };

const ROLE_LABEL: Record<string, string> = { survey: "Survey", booking: "Booking", deposit: "Deposit", thankyou: "Thank-you" };

function ghlFunnelUrl(r: PixelCheckRow): string {
  return r.funnel_id
    ? `https://app.gohighlevel.com/v2/location/${r.location_id}/funnels-websites/funnels/${r.funnel_id}`
    : `https://app.gohighlevel.com/v2/location/${r.location_id}/funnels-websites/funnels`;
}

function CheckCell({ c }: { c?: Check }) {
  if (!c) return <span className="text-[#8595a8]">—</span>;
  return (
    <div className="min-w-[120px]">
      <span
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold",
          c.ok ? "bg-[#e7f6ec] text-[#15803d]" : "bg-[#fde8ee] text-[#e11d48]"
        )}
      >
        {c.ok ? "✓" : "✕"}
      </span>
      <div className="text-[11px] leading-tight text-[#697a91] mt-0.5 max-w-[190px]">{c.detail}</div>
    </div>
  );
}

function PixelChips({ ids, shared }: { ids: string[]; shared: Map<string, number> }) {
  if (!ids.length) return <span className="px-2 py-0.5 rounded bg-[#fde8ee] text-[#e11d48] text-[11px] font-bold">NO PIXEL</span>;
  return (
    <div className="flex flex-col gap-1">
      {ids.map((id) => {
        const n = shared.get(id) ?? 1;
        return (
          <span key={id} className="font-mono text-[11px] text-[#34568a] whitespace-nowrap">
            {id}
            {n > 1 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-[#fff7ec] text-[#d97706] text-[10px] font-bold" title={`This pixel is installed on ${n} live clients' funnels`}>
                shared ×{n}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function PageDetail({ p }: { p: PageAudit }) {
  const evs = Object.entries(p.events);
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5 border-b border-[#eef2f7] last:border-0", p.extra && "opacity-60")}>
      <span className="w-[88px] text-[11px] font-bold text-[#34568a]">
        {p.position ? `${p.position}. ` : ""}
        {ROLE_LABEL[p.role] ?? p.role}
        {p.extra ? " (extra)" : ""}
      </span>
      <a href={p.url} target="_blank" rel="noreferrer" className="text-[12px] text-[#0e8f88] hover:underline break-all">
        /{p.path} <ExternalLink size={10} className="inline -mt-0.5" />
      </a>
      <span className="text-[12px]">
        {evs.length ? (
          evs.map(([ev, n]) => (
            <span key={ev} className="mr-2 font-semibold text-[#15803d]">
              {ev}
              {n > 1 ? ` ×${n}` : ""}
              {p.sources[ev]?.includes("lead-pixel.js") && <span className="text-[#697a91] font-normal"> (lead-pixel.js)</span>}
            </span>
          ))
        ) : (
          <span className="text-[#e11d48] font-semibold">nothing fires</span>
        )}
        {Object.keys(p.dead).length > 0 && (
          <span className="text-[#d97706]">dead code: {Object.keys(p.dead).join(", ")}</span>
        )}
      </span>
    </div>
  );
}

type Filter = "all" | "lead" | "sched" | "pixel" | "old" | "correct3";

export default function PixelCheckingPage() {
  const [rows, setRows] = useState<PixelCheckRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [discovering, setDiscovering] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch("/api/pixel-check")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => setRows(j.rows))
      .catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  const shared = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) for (const id of r.pixel_ids) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [rows]);

  const stats = useMemo(() => {
    const rs = rows ?? [];
    const pass = (k: keyof RowChecks) => rs.filter((r) => (r.checks as RowChecks)[k]?.ok).length;
    return {
      total: rs.length,
      pv1: pass("pv1"),
      lead2: pass("lead2"),
      sched3: pass("sched3"),
      purchase4: pass("purchase4"),
      correct3: rs.filter((r) => {
        const c = r.checks as RowChecks;
        return c.pv1?.ok && c.lead2?.ok && c.sched3?.ok;
      }).length,
      sharedPixel: rs.filter((r) => r.pixel_ids.some((id) => (shared.get(id) ?? 1) > 1)).length,
    };
  }, [rows, shared]);

  const filtered = useMemo(() => {
    let rs = rows ?? [];
    if (filter === "lead") rs = rs.filter((r) => !(r.checks as RowChecks).lead2?.ok);
    if (filter === "sched") rs = rs.filter((r) => !(r.checks as RowChecks).sched3?.ok);
    if (filter === "pixel") rs = rs.filter((r) => !r.pixel_ids.length || r.status === "blocked" || !(r.checks as RowChecks).pv1?.ok);
    if (filter === "old") rs = rs.filter((r) => !r.pages.some((p) => p.role === "deposit" && !p.extra));
    if (filter === "correct3")
      rs = rs.filter((r) => {
        const c = r.checks as RowChecks;
        return c.pv1?.ok && c.lead2?.ok && c.sched3?.ok;
      });
    const needle = q.trim().toLowerCase();
    if (needle)
      rs = rs.filter(
        (r) =>
          r.business_name.toLowerCase().includes(needle) ||
          (r.owner_name ?? "").toLowerCase().includes(needle) ||
          r.pixel_ids.some((id) => id.includes(needle))
      );
    return rs;
  }, [rows, filter, q]);

  const recheck = async (locationId: string) => {
    setChecking((s) => new Set(s).add(locationId));
    try {
      const r = await fetch("/api/pixel-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setRows((rs) => (rs ?? []).map((x) => (x.location_id === locationId ? j.row : x)));
    } catch (e) {
      alert(`Re-check failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setChecking((s) => {
        const n = new Set(s);
        n.delete(locationId);
        return n;
      });
    }
  };

  const discover = async () => {
    setDiscovering(true);
    try {
      const r = await fetch("/api/pixel-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discover: true }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      if (j.added?.length) setRows((rs) => [...(rs ?? []), ...j.added].sort((a, b) => a.business_name.localeCompare(b.business_name)));
      alert(j.added?.length ? `Added ${j.added.length} new client(s).${j.remaining ? ` ${j.remaining} more to go — click again.` : ""}` : "No new live clients without a row.");
    } catch (e) {
      alert(`Discover failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setDiscovering(false);
    }
  };

  if (err)
    return <div className="p-8 text-sm text-[#e11d48]">Failed to load: {err}</div>;
  if (!rows)
    return (
      <div className="flex items-center justify-center p-16 text-[#697a91]">
        <Loader2 className="animate-spin mr-2" size={18} /> Loading pixel checks…
      </div>
    );

  const chip = (f: Filter, label: string) => (
    <button
      key={f}
      onClick={() => setFilter(f)}
      className={cn(
        "px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors",
        filter === f ? "bg-[#15B7AE] border-[#15B7AE] text-white" : "bg-white border-[#e4ebf2] text-[#34568a] hover:border-[#15B7AE]"
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="p-5 max-w-[1400px] mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-bold text-[#1e3a5f]">📡 Pixel Checking</h1>
          <p className="text-[12.5px] text-[#697a91] max-w-[80ch]">
            Every live client&apos;s funnel, page by page: the pixel/dataset installed and which conversion actually fires.
            Target structure: <b>1&nbsp;PageView → 2&nbsp;Lead → 3&nbsp;Schedule → 4&nbsp;Purchase</b>. ↻ re-crawls the live pages.
          </p>
        </div>
        <button
          onClick={discover}
          disabled={discovering}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white border border-[#e4ebf2] text-[#34568a] hover:border-[#15B7AE] disabled:opacity-50"
        >
          {discovering ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />} Check for new clients
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
        {[
          { v: stats.total, l: "clients" },
          { v: stats.pv1, l: "1 · PageView ok" },
          { v: stats.lead2, l: "2 · Lead ok" },
          { v: stats.sched3, l: "3 · Schedule ok" },
          { v: stats.purchase4, l: "4 · Purchase ok" },
          { v: stats.sharedPixel, l: "on a shared pixel" },
        ].map((t) => (
          <div key={t.l} className="bg-white border border-[#e4ebf2] rounded-lg px-3 py-2">
            <div className="text-lg font-extrabold text-[#1e3a5f]">{t.v}</div>
            <div className="text-[11px] text-[#697a91]">{t.l}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {chip("all", `All ${rows.length}`)}
        {chip("correct3", `Steps 1–3 correct (${stats.correct3})`)}
        {chip("lead", `Lead problems (${rows.length - stats.lead2})`)}
        {chip("sched", `Schedule missing (${rows.length - stats.sched3})`)}
        {chip("pixel", "Pixel problems")}
        {chip("old", "Old funnels (no deposit page)")}
        <div className="relative ml-auto">
          <Search size={13} className="absolute left-2.5 top-2 text-[#8595a8]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search client / owner / pixel id"
            className="pl-7 pr-3 py-1.5 rounded-lg border border-[#e4ebf2] text-xs w-[230px] focus:outline-none focus:border-[#15B7AE]"
          />
        </div>
      </div>

      <div className="overflow-x-auto bg-white border border-[#e4ebf2] rounded-xl">
        <table className="w-full text-[13px]" style={{ minWidth: 1100 }}>
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-[#8595a8] border-b border-[#e4ebf2]">
              <th className="px-3 py-2.5 w-6"></th>
              <th className="px-3 py-2.5">Sub-account</th>
              <th className="px-3 py-2.5">Funnel</th>
              <th className="px-3 py-2.5">Pixel / dataset</th>
              <th className="px-3 py-2.5">1 · PageView</th>
              <th className="px-3 py-2.5">2 · Lead</th>
              <th className="px-3 py-2.5">3 · Schedule</th>
              <th className="px-3 py-2.5">4 · Purchase</th>
              <th className="px-3 py-2.5 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const c = r.checks as RowChecks;
              const isOpen = open.has(r.location_id);
              const busy = checking.has(r.location_id);
              return (
                <Fragment key={r.location_id}>
                  <tr
                    className="border-b border-[#eef2f7] hover:bg-[#f8fbfa] cursor-pointer align-top"
                    onClick={() =>
                      setOpen((s) => {
                        const n = new Set(s);
                        if (n.has(r.location_id)) n.delete(r.location_id);
                        else n.add(r.location_id);
                        return n;
                      })
                    }
                  >
                    <td className="px-3 py-2.5">
                      <ChevronRight size={14} className={cn("text-[#8595a8] transition-transform mt-0.5", isOpen && "rotate-90")} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-[#1e3a5f]">{r.business_name}</div>
                      <div className="text-[11px] text-[#8595a8]">{r.owner_name}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <a
                        href={ghlFunnelUrl(r)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-[12px] text-[#0e8f88] hover:underline"
                        title="Open this funnel in GoHighLevel"
                      >
                        {r.funnel_name ?? "(unknown funnel)"} <ExternalLink size={10} className="inline -mt-0.5" />
                      </a>
                      {r.status === "blocked" && (
                        <div className="text-[10px] font-bold text-[#e11d48] mt-0.5">
                          {r.pages.length ? "NO PIXEL" : "NOT PUBLISHED"}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <PixelChips ids={r.pixel_ids} shared={shared} />
                    </td>
                    <td className="px-3 py-2.5"><CheckCell c={c.pv1} /></td>
                    <td className="px-3 py-2.5"><CheckCell c={c.lead2} /></td>
                    <td className="px-3 py-2.5"><CheckCell c={c.sched3} /></td>
                    <td className="px-3 py-2.5"><CheckCell c={c.purchase4} /></td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!busy) recheck(r.location_id);
                        }}
                        title="Re-crawl this funnel's pages now"
                        className="p-1.5 rounded-lg border border-[#e4ebf2] text-[#34568a] hover:border-[#15B7AE] hover:text-[#0e8f88]"
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-[#eef2f7] bg-[#fbfdfc]">
                      <td></td>
                      <td colSpan={8} className="px-3 py-3">
                        {r.pages.length ? (
                          <div className="max-w-[900px]">{r.pages.map((p) => <PageDetail key={p.path} p={p} />)}</div>
                        ) : (
                          <div className="text-[12px] text-[#697a91]">No pages crawled.</div>
                        )}
                        {r.notes && <div className="text-[11.5px] text-[#697a91] mt-2 max-w-[900px]">{r.notes}</div>}
                        <div className="text-[10.5px] text-[#8595a8] mt-1.5">
                          Last checked {new Date(r.audited_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!filtered.length && <div className="p-8 text-center text-[13px] text-[#697a91]">No clients match this filter.</div>}
      </div>
      <p className="text-[11px] text-[#8595a8] mt-3 max-w-[100ch]">
        How events are verified: each page&apos;s embedded GHL config is decoded to see where every snippet lives — funnel Settings
        head/body code and page header code execute; inline scripts pasted in custom-code elements never run (proven live in a
        browser), while external scripts (lead-pixel.js) and image beacons do load. &quot;shared ×N&quot; means N live clients&apos; funnels
        send events into that same pixel/dataset.
      </p>
    </div>
  );
}
