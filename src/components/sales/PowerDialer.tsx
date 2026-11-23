"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DialerActivity from "./DialerActivity";

// Sales tab → Dialer (owner 11/14/2026). Lists come live from the GHL sales
// pipeline; "Start dialer" sends the ticked leads to the caller's GHL Power
// Dialer workflow, and the calls are made one at a time in GHL → Manual Actions.

type Row = {
  contactId: string; name: string; phone: string; email?: string; zone?: string; tz?: string;
  stageAt?: string; demoAt?: string; assignedTo?: string; lastCallAt?: string; lastTalkAt?: string;
  calls45?: number; tags: string[];
};
type List = { key: string; label: string; side: "setter" | "closer"; rows: Row[] };
type Api = {
  builtAt: string; lists: List[]; windows: Array<{ label: string; start: string; end: string }>;
  localOk: [number, number]; me: { id: string; name: string } | null; isAdmin: boolean;
  dialers: Array<{ id: string; name: string }>; autopilotKey?: string | null; error?: string;
};

const LOC = "SfpNMJ5YU9lBkxss47lK";
const ZONE_LABEL: Record<string, string> = { E: "ET", C: "CT", M: "MT", A: "AZ", P: "PT", K: "AK", H: "HI" };
const DAY = 86_400_000;

function ptMinutes(d = new Date()): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function fmtMin(m: number): string {
  const h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? "PM" : "AM", h12 = ((h + 11) % 12) + 1;
  return `${h12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${ap}`;
}
function localHour(tz?: string): number | null {
  if (!tz) return null;
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
}
function localTime(tz?: string): string {
  if (!tz) return "?";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date());
}
function ago(iso?: string): string {
  if (!iso) return "—";
  const d = Math.floor((Date.now() - Date.parse(iso)) / DAY);
  return d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
}
function usDate(s?: string): string {
  if (!s) return "—";
  // Demo times are Pacific wall-clock strings; stage dates are UTC ISO.
  if (!/Z$/.test(s)) return `${s.slice(5, 7)}/${s.slice(8, 10)}`;
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "2-digit", day: "2-digit" }).format(new Date(s));
}

export default function PowerDialer() {
  const [data, setData] = useState<Api | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listKey, setListKey] = useState<string>("");
  const [since, setSince] = useState(30);          // moved into this stage within N days (0 = all)
  const [quiet, setQuiet] = useState(1);           // not called in the last N days (0 = any)
  const [goodNow, setGoodNow] = useState(true);    // their local time is 9 AM – 8 PM right now
  const [zone, setZone] = useState("");
  const [owner, setOwner] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sendTo, setSendTo] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [, tick] = useState(0);
  const [mode, setMode] = useState<"list" | "activity">("list"); // owner 11/15: call list, or what the caller did

  async function load(fresh = false) {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/dialer${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const j = (await r.json()) as Api;
      if (!r.ok) throw new Error(j.error || "Could not load lists");
      setData(j);
      setListKey((k) => k || j.lists[0]?.key || "");
      setSendTo((s) => s || j.me?.id || j.dialers[0]?.id || "");
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    setLoading(false);
  }
  useEffect(() => { load(); const t = setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(t); }, []);

  const list = data?.lists.find((l) => l.key === listKey);
  const [okFrom, okTo] = data?.localOk ?? [9, 20];

  const rows = useMemo(() => {
    if (!list) return [];
    const now = Date.now(), needle = q.trim().toLowerCase();
    return list.rows.filter((r) => {
      if (since && (!r.stageAt || now - Date.parse(r.stageAt) > since * DAY)) return false;
      if (quiet && r.lastCallAt && now - Date.parse(r.lastCallAt) < quiet * DAY) return false;
      if (zone && r.zone !== zone) return false;
      if (owner && (r.assignedTo ?? "") !== owner) return false;
      if (goodNow) { const h = localHour(r.tz); if (h === null || h < okFrom || h >= okTo) return false; }
      if (needle && !`${r.name} ${r.phone} ${r.email ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    }).sort((a, b) => (a.calls45 ?? 0) - (b.calls45 ?? 0) || String(b.stageAt ?? "").localeCompare(String(a.stageAt ?? "")));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, since, quiet, zone, owner, goodNow, q, okFrom, okTo, data]);

  const owners = useMemo(() => [...new Set((list?.rows ?? []).map((r) => r.assignedTo ?? "").filter(Boolean))].sort(), [list]);

  // Window banner.
  const nowM = ptMinutes();
  const wins = (data?.windows ?? []).map((w) => ({ ...w, s: toMin(w.start), e: toMin(w.end) }));
  const open = wins.find((w) => nowM >= w.s && nowM < w.e);
  const next = wins.find((w) => nowM < w.s);

  // Autopilot bookmark: a javascript: link the rep drags to the bookmarks bar.
  // React refuses javascript: hrefs, so it is set on the element directly.
  const apRef = useRef<HTMLAnchorElement>(null);
  const apKey = data?.autopilotKey ?? null;
  useEffect(() => {
    if (!apRef.current || !apKey) return;
    const o = window.location.origin;
    apRef.current.setAttribute("href", `javascript:(function(){if(!/\\/v2\\/location\\//.test(location.pathname)){alert('Open GHL first (Conversations > Manual Actions), then click Autopilot.');return;}window.__pmuAutopilotCfg={api:${JSON.stringify(o)},key:${JSON.stringify(apKey)},autostart:true};var s=document.createElement('script');s.src=${JSON.stringify(o + "/dialer-autopilot.js")}+'?v='+Date.now();document.body.appendChild(s);})();`);
  }, [apKey]);

  async function start() {
    const ids = rows.filter((r) => picked.has(r.contactId)).map((r) => r.contactId);
    if (!ids.length) return;
    const who = data?.isAdmin ? data.dialers.find((d) => d.id === sendTo)?.name : data?.me?.name;
    if (!confirm(`Send ${ids.length} leads to ${who ?? "your"} dialer in GHL?`)) return;
    setSending(true); setMsg(null);
    try {
      const r = await fetch("/api/dialer/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contactIds: ids, userId: sendTo, list: listKey }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "failed");
      setMsg(`✅ ${j.sent} sent to ${who ?? "your"} dialer${j.failed?.length ? ` · ${j.failed.length} failed` : ""}. Open GHL → Manual Actions and click your 📞 Autopilot bookmark. It calls one by one, calls again, then sends the text.`);
      setPicked(new Set());
    } catch (e) { setMsg(`❌ ${e instanceof Error ? e.message : "failed"}`); }
    setSending(false);
  }

  const chip = (on: boolean) => `px-2.5 py-1 rounded-full text-xs font-semibold border whitespace-nowrap ${on ? "bg-[#0e8f88] text-white border-[#0e8f88]" : "bg-white text-[#34568a] border-[#e4ebf2]"}`;
  const sel = "px-2 py-1 rounded-lg border border-[#e4ebf2] bg-white text-xs text-[#34568a]";
  const allShownPicked = rows.length > 0 && rows.every((r) => picked.has(r.contactId));

  return (
    <div className="mt-4">
      {/* Call list, or the caller's activity (owner 11/15/2026) */}
      <div className="mb-3 flex gap-2">
        <button onClick={() => setMode("list")} className={chip(mode === "list")}>📞 Call list</button>
        <button onClick={() => setMode("activity")} className={chip(mode === "activity")}>📋 Activity</button>
      </div>
      {mode === "activity" ? (
        <DialerActivity />
      ) : (<>
      {/* When to call */}
      <div className={`rounded-xl border px-4 py-3 ${open ? "bg-[#e9f8f1] border-[#bfe8d4]" : "bg-[#f6f8fb] border-[#e4ebf2]"}`}>
        <div className="text-sm font-bold text-[#1f3559]">
          {open ? `🟢 Call now · ${open.label} until ${fmtMin(open.e)} PT`
            : next ? `⏰ Next call time: ${fmtMin(next.s)} PT` : "⏰ Next call time: tomorrow 10 AM PT"}
        </div>
        <div className="text-xs text-[#697a91] mt-0.5">
          Every day: {wins.map((w) => `${fmtMin(w.s)}–${fmtMin(w.e)}`).join(" and ")} PT · we only show people whose own time is {okFrom} AM–{okTo - 12} PM
        </div>
      </div>

      {apKey && (
        <div className="mt-2 rounded-xl border border-[#e4ebf2] bg-white px-4 py-2 text-xs text-[#697a91] flex items-center gap-2 flex-wrap">
          <a ref={apRef} onClick={(e) => { e.preventDefault(); alert("Drag this button to your bookmarks bar. Then open GHL → Manual Actions and click it there."); }}
            className="px-2.5 py-1 rounded-full bg-[#111827] text-white font-semibold cursor-grab whitespace-nowrap" draggable>📞 Autopilot</a>
          <span>One-time setup: drag this button to your bookmarks bar. In GHL → Manual Actions, click it once. It calls each lead, waits 3 sec if no answer, calls again, then sends the text.</span>
        </div>
      )}

      {err && <div className="mt-3 text-sm text-red-600">{err}</div>}
      {!data && !err && <div className="mt-4 text-sm text-[#697a91]">Loading lists from GHL… (about 30 seconds)</div>}

      {data && (<>
        {/* Lists */}
        <div className="mt-4 flex gap-2 flex-wrap items-center">
          {data.lists.map((l) => (
            <button key={l.key} onClick={() => { setListKey(l.key); setPicked(new Set()); setOwner(""); }} className={chip(l.key === listKey)}>
              {l.label} <span className="opacity-75">{l.rows.length}</span>
            </button>
          ))}
          <button onClick={() => load(true)} disabled={loading} className="ml-auto text-xs text-[#34568a] underline disabled:opacity-50">
            {loading ? "Refreshing…" : "↻ Refresh"}
          </button>
        </div>

        {/* Filters */}
        <div className="mt-3 flex gap-2 flex-wrap items-center text-xs text-[#697a91]">
          <label className="flex items-center gap-1">Moved here
            <select value={since} onChange={(e) => setSince(Number(e.target.value))} className={sel}>
              <option value={7}>last 7 days</option><option value={30}>last 30 days</option><option value={90}>last 90 days</option><option value={365}>last year</option><option value={0}>any time</option>
            </select>
          </label>
          <label className="flex items-center gap-1">Not called
            <select value={quiet} onChange={(e) => setQuiet(Number(e.target.value))} className={sel}>
              <option value={0}>any</option><option value={1}>today</option><option value={2}>2 days</option><option value={3}>3 days</option><option value={7}>7 days</option>
            </select>
          </label>
          <select value={zone} onChange={(e) => setZone(e.target.value)} className={sel}>
            <option value="">All time zones</option>
            {Object.entries(ZONE_LABEL).map(([z, l]) => <option key={z} value={z}>{l}</option>)}
          </select>
          {owners.length > 1 && (
            <select value={owner} onChange={(e) => setOwner(e.target.value)} className={sel}>
              <option value="">Everyone&apos;s leads</option>
              {owners.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={goodNow} onChange={(e) => setGoodNow(e.target.checked)} /> Good time for them now
          </label>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className={`${sel} w-32`} />
        </div>

        {/* Table */}
        <div className="mt-3 rounded-xl border border-[#e4ebf2] bg-white overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-[#f6f8fb] text-[#697a91]">
              <tr>
                <th className="p-2 w-8"><input type="checkbox" checked={allShownPicked}
                  onChange={() => setPicked(allShownPicked ? new Set() : new Set(rows.map((r) => r.contactId)))} /></th>
                <th className="p-2 text-left">Name</th>
                <th className="p-2 text-left">Their time</th>
                <th className="p-2 text-left">{list?.side === "closer" ? "Demo" : "Moved here"}</th>
                <th className="p-2 text-left">Last call</th>
                <th className="p-2 text-left hidden sm:table-cell">Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((r) => {
                const h = localHour(r.tz); const ok = h !== null && h >= okFrom && h < okTo;
                return (
                  <tr key={r.contactId} className="border-t border-[#f0f3f7] hover:bg-[#fafcfe]">
                    <td className="p-2 text-center"><input type="checkbox" checked={picked.has(r.contactId)}
                      onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(r.contactId)) n.delete(r.contactId); else n.add(r.contactId); return n; })} /></td>
                    <td className="p-2">
                      <a href={`https://app.gohighlevel.com/v2/location/${LOC}/contacts/detail/${r.contactId}`} target="_blank" rel="noreferrer" className="font-semibold text-[#1f3559] hover:underline">{r.name}</a>
                    </td>
                    <td className={`p-2 whitespace-nowrap ${ok ? "text-[#0e8f88] font-semibold" : "text-[#9aa7b8]"}`}>{localTime(r.tz)} {r.zone ? ZONE_LABEL[r.zone] : ""}</td>
                    <td className="p-2 whitespace-nowrap text-[#34568a]">{list?.side === "closer" && r.demoAt ? usDate(r.demoAt) : usDate(r.stageAt)}</td>
                    <td className="p-2 whitespace-nowrap text-[#34568a]" title={r.lastTalkAt ? `Last real talk (1 min+): ${ago(r.lastTalkAt)}` : "No real talk in 45 days"}>
                      {ago(r.lastCallAt)}{r.calls45 ? ` · ${r.calls45}×` : ""}
                    </td>
                    <td className="p-2 whitespace-nowrap text-[#697a91] hidden sm:table-cell">{r.assignedTo?.split(" ")[0] ?? "—"}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={6} className="p-6 text-center text-[#697a91]">No one to call with these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        {rows.length > 500 && <div className="mt-1 text-xs text-[#697a91]">Showing first 500 of {rows.length}. Use the filters to narrow it.</div>}

        {/* Start */}
        <div className="sticky bottom-0 mt-3 py-3 bg-white/95 backdrop-blur flex gap-2 flex-wrap items-center border-t border-[#e4ebf2]">
          <span className="text-sm font-semibold text-[#1f3559]">{picked.size} picked</span>
          {data.isAdmin && (
            <select value={sendTo} onChange={(e) => setSendTo(e.target.value)} className={sel}>
              {!data.dialers.length && <option value="">No dialer set up yet</option>}
              {data.dialers.map((d) => <option key={d.id} value={d.id}>Send to {d.name}</option>)}
            </select>
          )}
          <button onClick={start} disabled={!picked.size || sending || (data.isAdmin ? !sendTo : !data.me)}
            className="px-4 py-2 rounded-lg bg-[#0e8f88] text-white text-sm font-bold disabled:opacity-40">
            {sending ? "Sending…" : "📞 Start dialer"}
          </button>
          <a href={`https://app.gohighlevel.com/v2/location/${LOC}/conversations/manual_actions`} target="_blank" rel="noreferrer" className="text-xs text-[#34568a] underline">Open GHL dialer</a>
          {msg && <span className="text-xs text-[#1f3559] w-full">{msg}</span>}
        </div>
      </>)}
      </>)}
    </div>
  );
}
