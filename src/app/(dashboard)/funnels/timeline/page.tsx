"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useUser } from "@/lib/hooks/useUser";
import { cn } from "@/lib/utils";
import { versionStyle } from "@/lib/version-style";
import { MIN_LEADS, bookingRate, changeText, goBackWhy, rate, type DayCounts, type TimelineBoard, type TimelineDetail, type TimelineRow, type TimelineVersion } from "@/lib/funnel-timeline-view";
import { ChevronDown, ExternalLink, Loader2, Search } from "lucide-react";

/* Every funnel's saved pages next to its booking and deposit rates, with one click
   to go back to a saved page (owner, 11/04/2026). See src/lib/funnel-timeline.ts. */

const BASE = "https://book.pmu-care.com";
const PAGE = 30;
type Filter = "all" | "fell" | "locked" | "V3" | "V2.3";

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "America/Los_Angeles" }) : "";
const pct = (r: number | null) => (r == null ? "—" : `${r}%`);
function Rates({ label, c, noCalendar }: { label: string; c: DayCounts; noCalendar?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[#697a91] leading-tight">{label}</div>
      <div className="flex gap-3 mt-0.5">
        <div><div className="text-base font-semibold text-[#1c2b3a] tabular-nums leading-tight">{noCalendar ? "—" : pct(bookingRate(c))}</div><div className="text-[10px] text-[#697a91]">{noCalendar ? "no calendar" : "booking"}</div></div>
        <div><div className="text-base font-semibold text-[#1c2b3a] tabular-nums leading-tight">{pct(rate(c.d, c.l))}</div><div className="text-[10px] text-[#697a91]">deposit</div></div>
      </div>
      <div className="text-[11px] text-[#697a91] tabular-nums mt-0.5">{c.l} leads · {c.p} picked · {c.d} paid</div>
    </div>
  );
}

function SavedPages({ row, version, stamp }: { row: TimelineRow; version: TimelineVersion; stamp: number }) {
  const link = (key: string) => `${BASE}/f/${row.slug}?preview=${key}&fzv=${version.id}&fzs=${version.previewSig}`;
  const pages = [{ key: "survey", label: "Survey" }];
  if (row.version !== "(V1)") pages.push({ key: "booking", label: "Calendar" });
  if (row.version !== "(V1)" && !row.freeBooking) pages.push({ key: "deposit", label: "Deposit" });
  return (
    <div className="mt-2 flex gap-3 overflow-x-auto pb-1">
      {pages.map((p) => (
        <div key={p.key} className="shrink-0">
          <a href={link(p.key)} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-xs font-semibold text-[#0e9c9c] hover:underline mb-1">
            {p.label} <ExternalLink className="w-3 h-3" />
          </a>
          <div className="relative overflow-hidden rounded-[18px] border-4 border-[#1f2937] bg-white" style={{ width: 218, height: 430 }}>
            <div className="absolute inset-0 flex items-center justify-center text-[#697a91]"><Loader2 className="w-5 h-5 animate-spin" /></div>
            <iframe title={`${row.business} ${p.label} page saved ${fmtDate(version.savedAt)}`} src={`${link(p.key)}&pv=${stamp}`} loading="lazy"
              style={{ position: "relative", width: 390, height: 770, border: 0, transform: "scale(0.5385)", transformOrigin: "0 0" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const windowLine = (label: string, c: DayCounts, noCalendar: boolean) =>
  `${label}: ${c.l} leads · ${noCalendar ? "" : `booking ${pct(bookingRate(c))} (${c.p}) · `}deposit ${pct(rate(c.d, c.l))} (${c.d})`;

function History({ row, stamp, reload, onLocked, onLoaded }: { row: TimelineRow; stamp: number; reload: number; onLocked: (slug: string, at: string | null) => void; onLoaded: (slug: string, newest: TimelineVersion | undefined) => void }) {
  const [detail, setDetail] = useState<TimelineDetail | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");

  const load = () => fetch(`/api/onebox/timeline?slug=${encodeURIComponent(row.slug)}`)
    .then(async (r) => {
      const j = await r.json();
      if (r.ok) { setDetail(j as TimelineDetail); setError(""); onLoaded(row.slug, (j as TimelineDetail).versions[0]); } else setError(j.error ?? "Couldn't load");
    })
    .catch(() => setError("Couldn't load"));
  useEffect(() => { void load(); }, [row.slug, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const goBack = async (v: TimelineVersion) => {
    setBusy(`goback:${v.id}`);
    setMessage("");
    try {
      const res = await fetch("/api/onebox/timeline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "goback", slug: row.slug, versionId: v.id }) });
      const j = await res.json();
      if (!res.ok) { setMessage(j.error ?? "That didn't work"); return; }
      onLocked(row.slug, j.lockedAt);
      setMessage(`Done. This funnel now shows the page saved ${fmtDate(v.savedAt)}. Visitors see it within about 3 minutes.${j.drift?.length ? ` GHL still has newer values, so the AI may say something different: ${j.drift.join(", ")}.` : ""}`);
      setConfirm(null);
      await load();
    } catch {
      setMessage("That didn't work. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  };

  const unlock = async () => {
    setBusy("unlock");
    setMessage("");
    try {
      const res = await fetch("/api/onebox/freeze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unfreeze", slug: row.slug }) });
      const j = await res.json();
      if (!res.ok) { setMessage(j.error ?? "That didn't work"); return; }
      onLocked(row.slug, null);
      setMessage("Done. This funnel is back on the live page. Visitors see it within about 3 minutes.");
      await load();
    } catch {
      setMessage("That didn't work. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  };

  const addNote = async () => {
    if (!note.trim()) return;
    setBusy("note");
    setMessage("");
    try {
      const res = await fetch("/api/onebox/timeline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "note", slug: row.slug, note }) });
      const j = await res.json();
      if (!res.ok) { setMessage(j.error ?? "That didn't work"); return; }
      setDetail((d) => d && { ...d, notes: [j.note, ...d.notes] });
      setNote("");
    } catch {
      setMessage("That didn't work. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  };

  if (!detail) {
    return error
      ? <p className="mt-2 text-xs text-[#b91c1c]">{error}</p>
      : <div className="mt-2 flex items-center gap-2 text-xs text-[#697a91]"><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading the history…</div>;
  }
  const noCalendar = row.version === "(V1)";

  type Entry = { kind: "version"; at: string; v: TimelineVersion } | { kind: "note"; at: string; text: string; allFunnels: boolean; id: number };
  const entries: Entry[] = [
    ...detail.versions.map((v): Entry => ({ kind: "version", at: v.savedAt, v })),
    ...detail.notes.map((n): Entry => ({ kind: "note", at: n.at, text: n.note, allFunnels: n.allFunnels, id: n.id })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="mt-3 border-t border-[#e4ebf2] pt-3">
      {row.lockedAt && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[#1d4ed8]">
          <span>🧊 Locked since {fmtDate(row.lockedAt)}. New page changes skip this funnel.</span>
          <button type="button" disabled={!!busy} onClick={() => void unlock()} className="inline-flex items-center gap-1 font-semibold rounded-lg border border-[#bfdbfe] bg-white px-2 py-0.5 hover:bg-[#eef6ff] disabled:opacity-60">
            {busy === "unlock" && <Loader2 className="w-3 h-3 animate-spin" />}Back to the live page
          </button>
        </div>
      )}
      {message && <p className="mb-2 text-xs text-[#b45309]">{message}</p>}
      {error && <p className="mb-2 text-xs text-[#b91c1c]">{error}</p>}
      <div className="mb-3 flex gap-2">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note: AI change, ad change…" maxLength={500}
          className="flex-1 min-w-0 px-2.5 py-1.5 bg-white border border-[#e4ebf2] rounded-lg text-xs focus:outline-none focus:border-[#15B7AE]" />
        <button type="button" disabled={!!busy || !note.trim()} onClick={() => void addNote()} className="inline-flex items-center gap-1 text-xs font-semibold rounded-lg border border-[#cbd5e1] bg-white text-[#34568a] px-2.5 py-1.5 hover:bg-[#f1f5f9] disabled:opacity-50">
          {busy === "note" && <Loader2 className="w-3 h-3 animate-spin" />}Add
        </button>
      </div>
      {!entries.length && <p className="text-xs text-[#697a91]">Nothing saved yet. It saves on its own every 6 hours, or press Save now at the top.</p>}
      <ol className="flex flex-col gap-2.5">
        {entries.map((e) => e.kind === "note" ? (
          <li key={`n${e.id}`} className="text-xs text-[#34568a]">
            <span className="text-[#697a91] tabular-nums">{fmtDate(e.at)}</span> · 📝 {e.text}{e.allFunnels ? " (all funnels)" : ""}
          </li>
        ) : (
          <li key={`v${e.v.id}`} className={cn("rounded-lg border p-2.5", e.v.isNow ? "border-[#0e9c9c]" : "border-[#e4ebf2]")}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="font-semibold text-[#1c2b3a] tabular-nums">{fmtDate(e.v.savedAt)}</span>
              {e.v.isNow && <span className="rounded-full bg-[#e8f7f6] text-[#0b7a7a] px-1.5 text-[10px] font-bold">Now</span>}
              {row.goBack?.versionId === e.v.id && <span className="rounded-full bg-[#e8f7f6] text-[#0b7a7a] px-1.5 text-[10px] font-bold">⭐ I suggest this page</span>}
              <span className="text-[#697a91]">Page version {e.v.engine}</span>
            </div>
            <p className="mt-1 text-xs text-[#34568a]">{e.v.changes.length ? e.v.changes.map(changeText).join("; ") : "First save."}</p>
            {e.v.windows ? (
              <div className="mt-1 text-[11px] text-[#697a91] tabular-nums">
                {e.v.changes.length > 0 && <div>{windowLine("14 days before", e.v.windows.before, noCalendar)}</div>}
                <div>
                  {windowLine(e.v.windows.afterDays >= 14 ? "14 days after" : `After, ${e.v.windows.afterDays} ${e.v.windows.afterDays === 1 ? "day" : "days"} so far`, e.v.windows.after, noCalendar)}
                  {e.v.windows.after.l < MIN_LEADS ? " · too few leads to judge" : ""}
                </div>
              </div>
            ) : (
              <div className="mt-1 text-[11px] text-[#697a91]">Couldn&apos;t count the rates just now. Try again in a minute.</div>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setPreview(preview === e.v.id ? null : e.v.id)} className="inline-flex items-center gap-1 text-xs rounded-lg border border-[#e4ebf2] px-2 py-1 text-[#34568a] hover:bg-[#f6f9fc]">
                👁 See this page <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", preview === e.v.id && "rotate-180")} />
              </button>
              {e.v.samePageAsNow && !e.v.isNow && <span className="text-xs text-[#697a91]">Same page as now.</span>}
              {!e.v.samePageAsNow && !e.v.engineSaved && <span className="text-xs text-[#697a91]">This page version wasn&apos;t saved, so it can&apos;t come back.</span>}
              {!e.v.samePageAsNow && e.v.engineSaved && !noCalendar && (confirm === e.v.id ? (
                <>
                  <span className="text-xs text-[#b45309]">Change the live page to this one? Deposit, phone, address, calendar and checkout stay as they are now.</span>
                  <button type="button" disabled={!!busy} onClick={() => void goBack(e.v)} className="inline-flex items-center gap-1 text-xs font-semibold rounded-lg bg-[#0e9c9c] text-white px-2 py-1 hover:bg-[#0b8383] disabled:opacity-60">
                    {busy === `goback:${e.v.id}` && <Loader2 className="w-3 h-3 animate-spin" />}Yes, go back
                  </button>
                  <button type="button" disabled={!!busy} onClick={() => setConfirm(null)} className="text-xs text-[#697a91] hover:underline">No</button>
                </>
              ) : (
                <button type="button" disabled={!!busy} onClick={() => setConfirm(e.v.id)} className="text-xs font-semibold rounded-lg border border-[#0e9c9c] text-[#0b7a7a] px-2 py-1 hover:bg-[#e8f7f6] disabled:opacity-60">↩ Go back to this</button>
              ))}
            </div>
            {preview === e.v.id && <SavedPages row={row} version={e.v} stamp={stamp} />}
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function TimelinePage() {
  const { role, loading: userLoading } = useUser();
  const [board, setBoard] = useState<TimelineBoard | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [order, setOrder] = useState<Map<string, number>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState("");
  const [reload, setReload] = useState(0);
  const [fleetNote, setFleetNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [stamp] = useState(() => Date.now());

  const load = () => fetch("/api/onebox/timeline")
    .then(async (r) => {
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? "Couldn't load"); return; }
      setError("");
      const b = j as TimelineBoard;
      /* Suggested first, then who fell; the order stays until a reload, so cards don't jump. */
      const sorted = [...b.rows].sort((x, y) => (y.goBack ? 1 : 0) - (x.goBack ? 1 : 0) || (y.fall ? 1 : 0) - (x.fall ? 1 : 0) || (rate(y.last14.d, y.last14.l) ?? -1) - (rate(x.last14.d, x.last14.l) ?? -1) || x.business.localeCompare(y.business));
      setOrder(new Map(sorted.map((r2, i) => [r2.slug, i])));
      setBoard(b);
    })
    .catch(() => setError("Couldn't load"));
  useEffect(() => { if (role === "admin") void load(); }, [role]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setShown(PAGE), [q, filter]);

  const rows = board?.rows;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? [])
      .filter((r) => !s || `${r.business} ${r.owner} ${r.slug}`.toLowerCase().includes(s))
      .filter((r) => filter === "all" ? true : filter === "fell" ? !!r.fall : filter === "locked" ? !!r.lockedAt : r.version.toUpperCase().includes(filter))
      .sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0));
  }, [rows, q, filter, order]);
  const counts = useMemo(() => ({ fell: (rows ?? []).filter((r) => r.fall).length, locked: (rows ?? []).filter((r) => r.lockedAt).length }), [rows]);

  const setLocked = (slug: string, at: string | null) =>
    setBoard((b) => b && { ...b, rows: b.rows.map((r) => (r.slug === slug ? { ...r, lockedAt: at } : r)) });

  /* Keeps the card's "Last save" line true after a go back, without re-sorting. */
  const setNewest = (slug: string, newest: TimelineVersion | undefined) => {
    if (!newest) return;
    setBoard((b) => b && { ...b, rows: b.rows.map((r) => (r.slug === slug ? { ...r, lastChange: { at: newest.savedAt, changes: newest.changes } } : r)) });
  };

  const saveNow = async () => {
    setSaving(true);
    setSaveNote("");
    try {
      const res = await fetch("/api/onebox/timeline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save" }) });
      const j = await res.json();
      if (!res.ok) { setSaveNote(j.error ?? "That didn't work"); return; }
      setSaveNote(`Saved. ${j.changed ?? 0} funnels changed, ${j.saved ?? 0} new saves.${j.failed?.length ? ` ${j.failed.length} failed.` : ""}${j.engineCopyError ? ` The page version file wasn't saved: ${j.engineCopyError}` : ""}`);
      await load();
      setReload((n) => n + 1);
    } catch {
      setSaveNote("That didn't work. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const addFleetNote = async () => {
    if (!fleetNote.trim()) return;
    setNoting(true);
    setSaveNote("");
    try {
      const res = await fetch("/api/onebox/timeline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "note", note: fleetNote }) });
      const j = await res.json();
      if (!res.ok) { setSaveNote(j.error ?? "That didn't work"); return; }
      setFleetNote("");
      setSaveNote("Note added to all funnels.");
      setReload((n) => n + 1);
    } catch {
      setSaveNote("That didn't work. Check your connection and try again.");
    } finally {
      setNoting(false);
    }
  };

  if (userLoading) return <div className="flex items-center gap-2 text-sm text-[#697a91] p-8"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>;
  if (role !== "admin") return <div className="p-8 text-[#697a91]">Admins only.</div>;

  return (
    <div className="p-3 md:p-6 max-w-[1100px] mx-auto">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <Link href="/funnels" className="text-sm text-[#0e9c9c] hover:underline">← Funnels</Link>
        <h1 className="text-base sm:text-lg font-semibold text-[#1c2b3a]">🕒 Funnel timeline</h1>
        <button type="button" disabled={saving} onClick={() => void saveNow()} className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg border border-[#cbd5e1] bg-white text-[#34568a] px-2.5 py-1 hover:bg-[#f1f5f9] disabled:opacity-60">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{saving ? "Saving…" : "Save now"}
        </button>
      </div>
      <p className="text-sm text-[#34568a] mb-1">Each funnel&apos;s page is saved when it changes, next to its rates. If a rate falls after a change, you can go back to the old page.</p>
      <p className="text-xs text-[#697a91] mb-3">Booking = picked a time per 100 page leads. Deposit = paid per 100 leads. Not saved: the AI and ads, so add a note for those. Open times, calendar, checkout, deposit amount, phone and address always stay live.</p>
      <div className="mb-3 flex gap-2">
        <input value={fleetNote} onChange={(e) => setFleetNote(e.target.value)} placeholder="Note for all funnels: AI change, ad change…" maxLength={500}
          className="flex-1 min-w-0 px-2.5 py-1.5 bg-white border border-[#e4ebf2] rounded-lg text-xs focus:outline-none focus:border-[#15B7AE]" />
        <button type="button" disabled={noting || !fleetNote.trim()} onClick={() => void addFleetNote()} className="inline-flex items-center gap-1 text-xs font-semibold rounded-lg border border-[#cbd5e1] bg-white text-[#34568a] px-2.5 py-1.5 hover:bg-[#f1f5f9] disabled:opacity-50">
          {noting && <Loader2 className="w-3 h-3 animate-spin" />}Add
        </button>
      </div>
      {saveNote && <p className="text-xs text-[#b45309] mb-2">{saveNote}</p>}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a client…"
            className="w-full pl-9 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm focus:outline-none focus:border-[#15B7AE]" />
        </div>
        {([
          ["all", "All"],
          ["fell", `⚠ Fell${board ? ` (${counts.fell})` : ""}`],
          ["locked", `🧊 Locked${board ? ` (${counts.locked})` : ""}`],
          ["V3", "V3"],
          ["V2.3", "V2.3"],
        ] as [Filter, string][]).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setFilter(k)}
            className={cn("text-xs font-semibold rounded-full border px-3 py-1", filter === k ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "bg-white text-[#34568a] border-[#cbd5e1] hover:bg-[#f1f5f9]")}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="text-sm text-[#b91c1c] py-4">{error}</div>}
      {!board && !error && <div className="flex items-center gap-2 text-sm text-[#697a91] py-8"><Loader2 className="w-4 h-4 animate-spin" />Counting every funnel&apos;s leads and deposits…</div>}
      {board && <div className="text-xs text-[#697a91] mb-3">{list.length} funnels</div>}

      <div className="flex flex-col gap-3">
        {list.slice(0, shown).map((r) => {
          const vs = r.version ? versionStyle(r.version) : null;
          return (
            <div key={r.slug} className={cn("rounded-xl border bg-white p-3", r.fall ? "border-[#f0c48a]" : r.lockedAt ? "border-[#bfdbfe]" : "border-[#e4ebf2]")}>
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-[#1c2b3a]">{r.business}</div>
                  <div className="text-[11px] text-[#697a91]">{r.owner}</div>
                </div>
                {vs && <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold" style={{ background: vs.bg, color: vs.text, borderColor: vs.border }}>{r.version.replace(/[()]/g, "")}</span>}
                {r.clientStatus && r.clientStatus !== "live" && <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold bg-[#f1f5f9] text-[#64748b] border-[#d7e0ea] capitalize">{r.clientStatus}</span>}
                {r.lockedAt && <span className="shrink-0 rounded-full border px-2 py-px text-[11px] font-bold bg-[#eef6ff] text-[#1d4ed8] border-[#bfdbfe]">🧊 Locked since {fmtDate(r.lockedAt)}</span>}
                {r.fall && <span className="shrink-0 rounded-full border px-2 py-px text-[11px] font-bold bg-[#fff7ed] text-[#b45309] border-[#f0c48a]">⚠ {r.fall.what === "both" ? "Booking and deposit fell" : r.fall.what === "booking" ? "Booking fell" : "Deposit fell"}</span>}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:max-w-[520px]">
                <Rates label="Last 14 days" c={r.last14} noCalendar={r.version === "(V1)"} />
                <Rates label="14 days before" c={r.prev14} noCalendar={r.version === "(V1)"} />
              </div>
              {!r.fall && (r.last14.l < MIN_LEADS || r.prev14.l < MIN_LEADS) && <p className="mt-1 text-[11px] text-[#697a91]">Too few leads to judge a fall.</p>}
              {r.goBack && !r.lockedAt && (
                <p className="mt-2 text-xs font-semibold text-[#0b7a7a]">
                  ⭐ I suggest going back to the page saved {fmtDate(r.goBack.savedAt)}: {goBackWhy(r.goBack)} after we changed this on {fmtDate(r.goBack.changeAt)}: {r.goBack.changes.slice(0, 3).map(changeText).join("; ")}. It could still be chance. Open the history to see the old page.
                </p>
              )}
              {r.lastChange && (
                <p className="mt-2 text-xs text-[#34568a]">
                  Last save {fmtDate(r.lastChange.at)}{r.lastChange.changes.length ? `: ${r.lastChange.changes.slice(0, 3).map(changeText).join("; ")}${r.lastChange.changes.length > 3 ? `; and ${r.lastChange.changes.length - 3} more` : ""}` : ""}
                </p>
              )}
              <div className="mt-2">
                <button type="button" onClick={() => setOpen(open === r.slug ? null : r.slug)} className="inline-flex items-center gap-1 text-sm rounded-lg border border-[#e4ebf2] px-3 py-1.5 text-[#34568a] hover:bg-[#f6f9fc]">
                  🕒 See history <ChevronDown className={cn("w-4 h-4 transition-transform", open === r.slug && "rotate-180")} />
                </button>
              </div>
              {open === r.slug && <History row={r} stamp={stamp} reload={reload} onLocked={setLocked} onLoaded={setNewest} />}
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
