"use client";
import { Loader2 } from "lucide-react";

import { useCallback, useEffect, useState } from "react";
import type { DemoResult, DemoStatus } from "@/lib/demo-check";
import { SalesBoardView } from "@/components/sales/SalesBoard";
import { useUser } from "@/lib/hooks/useUser";

const SECTIONS: Array<{ key: DemoStatus; label: string; emoji: string; tint: string; border: string }> = [
  { key: "showed",        label: "Showed",           emoji: "✅", tint: "#f0fbfa", border: "#15B7AE" },
  { key: "not_yet",       label: "Not happened yet", emoji: "📅", tint: "#f5f8fc", border: "#7f9cc4" },
  { key: "no_show",       label: "No-show",          emoji: "❌", tint: "#fdf3f3", border: "#d97070" },
  { key: "cancelled",     label: "Cancelled",        emoji: "⛔", tint: "#fbf7f1", border: "#d0a05e" },
  { key: "not_in_system", label: "Not in the system",emoji: "❓", tint: "#f7f7f9", border: "#a3adbb" },
];

// Calendar strings are account-local ("2026-09-25 14:00:00", Pacific) — show
// them as they are, just friendlier; converting would shift the time.
function fmtLocal(s?: string, withTime = true): string {
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return s;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0));
  const day = d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  if (!withTime || !m[4]) return day;
  return `${day}, ${d.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" })}`;
}
// "booked Sep 18 · demo Thu Sep 25, 2:00 PM PT" — the two dates the owner
// wants on every demo that hasn't happened yet.
function whenLine(r: DemoResult): string {
  if (!r.appointmentAt) return "";
  return `booked ${fmtLocal(r.bookedAt, false)} · demo ${fmtLocal(r.appointmentAt)} PT`;
}

type CoachRow = {
  coach: string;
  live: number; paused: number; offboarded: number;
  prevLive: number; prevPaused: number; prevOffboarded: number;
  churned: { name: string; to: string }[];
  newLive: string[];
  history: { date: string; live: number }[];
};

/* Coach pay (Netzah, 2026-09-21): a flat base plus a per-client amount,
   counted from the live clients at the month's 20th snapshot. */
const SALARY_BASE = 400;
const SALARY_PER_CLIENT = 30;
const salary = (n: number) => SALARY_BASE + SALARY_PER_CLIENT * n;

function delta(now: number, prev: number, hasPrev: boolean) {
  if (!hasPrev) return null;
  const d = now - prev;
  if (d === 0) return <span className="text-[#8595a8]"> (=)</span>;
  return <span className={d > 0 ? "text-[#0e8f88]" : "text-[#b4485c]"}> ({d > 0 ? "+" : ""}{d})</span>;
}

function CoachTracker() {
  const [rows, setRows] = useState<CoachRow[] | null>(null);
  const [prevDate, setPrevDate] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch("/api/sales/coaches").then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRows(j.coaches); setPrevDate(j.prevDate); setHidden(j.hidden ?? []);
    }).catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);
  type Detail = { coach: string; date: string; prevDate: string | null; dates: string[]; clients: { owner: string; biz: string; status: string; prevStatus: string | null }[]; gone: { owner: string; biz: string; was: string }[] };
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const openDetail = (coach: string, date: string) => {
    setDetailBusy(true);
    fetch(`/api/sales/coaches?coach=${encodeURIComponent(coach)}&date=${encodeURIComponent(date)}`)
      .then(async (r) => { const j = await r.json(); if (r.ok) setDetail(j); })
      .finally(() => setDetailBusy(false));
  };
  const setCoachHidden = (coach: string, hide: boolean) => {
    void fetch("/api/sales/coaches", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: hide ? "hide" : "unhide", coach }),
    }).then(load);
  };

  if (err) return <div className="mt-6 rounded-lg border border-[#d97070] bg-[#fdf3f3] p-3 text-sm text-[#8a3a3a]">{err}</div>;
  if (!rows) return <div className="mt-8 text-sm text-[#697a91]">Loading coach numbers…</div>;
  const hasPrev = !!prevDate;
  const visible = rows.filter((c) => !hidden.includes(c.coach));
  const hiddenRows = rows.filter((c) => hidden.includes(c.coach));
  return (
    <div className="mt-5">
      <p className="text-sm text-[#697a91]">
        Live client counts per Client Success Coach, compared to the last snapshot
        {prevDate ? <> (taken <strong>{prevDate}</strong>)</> : " — no previous snapshot yet"}.
        A new snapshot is saved automatically on the <strong>20th of every month</strong>.
        Churned = was Live at the snapshot, isn&apos;t Live today.
        Salary = <strong>${SALARY_BASE} base + ${SALARY_PER_CLIENT} per live client</strong>, counted at that month&apos;s 20th — click a
        salary to see every month&apos;s calculation.
      </p>
      <div className="mt-3 rounded-xl border border-[#e4ebf2] overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#f5f8fc] text-left text-xs uppercase tracking-wide text-[#697a91]">
              <th className="px-4 py-2.5">Coach</th>
              <th className="px-4 py-2.5">Salary</th>
              <th className="px-4 py-2.5">Live</th>
              <th className="px-4 py-2.5">Paused</th>
              <th className="px-4 py-2.5">Offboarded</th>
              <th className="px-4 py-2.5">Churned</th>
              <th className="px-4 py-2.5">New live</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#eef3f8]">
            {visible.map((c) => (
              <tr key={c.coach}>
                <td className="px-4 py-2.5 font-semibold text-[#1f3559]">
                  <button onClick={() => (detail?.coach === c.coach ? setDetail(null) : openDetail(c.coach, "current"))}
                    title="Click for the client-by-client breakdown"
                    className="hover:underline text-left">{c.coach}</button>
                  {c.coach !== "(unassigned)" && (
                    <button onClick={() => setCoachHidden(c.coach, true)}
                      title="Hide from the tracker (former coach / not a coach) — reversible below"
                      className="ml-2 text-[10px] font-normal text-[#97a5b8] hover:text-[#b4485c] hover:underline">hide</button>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {c.history.length === 0 ? (
                    <span className="text-xs text-[#8595a8]" title="No snapshot yet — first one lands on the 20th">
                      ${salary(c.live)} <span className="font-normal">(today, no snapshot yet)</span>
                    </span>
                  ) : (
                    <details>
                      <summary className="cursor-pointer font-bold text-[#0e8f88] whitespace-nowrap">
                        ${salary(c.history[0].live)} <span className="font-normal text-xs text-[#8595a8]">as of {c.history[0].date}</span>
                      </summary>
                      <ul className="mt-1.5 grid gap-1 text-xs text-[#697a91] whitespace-nowrap">
                        {c.history.map((h) => (
                          <li key={h.date} className="border border-[#e4ebf2] rounded-md px-2 py-1 bg-[#f9fbfd]">
                            <strong className="text-[#1f3559]">{h.date}</strong> &middot; {h.live} client{h.live === 1 ? "" : "s"} &rarr; ${SALARY_BASE} + {h.live} &times; ${SALARY_PER_CLIENT} = <strong className="text-[#0e8f88]">${salary(h.live)}</strong>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
                <td className="px-4 py-2.5"><strong>{c.live}</strong>{delta(c.live, c.prevLive, hasPrev)}{hasPrev && <span className="text-xs text-[#8595a8]"> · was {c.prevLive}</span>}</td>
                <td className="px-4 py-2.5">{c.paused}{delta(c.paused, c.prevPaused, hasPrev)}</td>
                <td className="px-4 py-2.5">{c.offboarded}{delta(c.offboarded, c.prevOffboarded, hasPrev)}</td>
                <td className="px-4 py-2.5">
                  {c.churned.length === 0 ? <span className="text-[#8595a8]">0</span> : (
                    <details><summary className="cursor-pointer font-semibold text-[#b4485c]">{c.churned.length}</summary>
                      <ul className="mt-1 ml-4 list-disc text-xs text-[#697a91]">{c.churned.map((x, i) => <li key={i}>{x.name} → {x.to}</li>)}</ul>
                    </details>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {c.newLive.length === 0 ? <span className="text-[#8595a8]">0</span> : (
                    <details><summary className="cursor-pointer font-semibold text-[#0e8f88]">{c.newLive.length}</summary>
                      <ul className="mt-1 ml-4 list-disc text-xs text-[#697a91]">{c.newLive.map((x, i) => <li key={i}>{x}</li>)}</ul>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(detail || detailBusy) && (
        <div className="mt-3 rounded-xl border border-[#cfe0f0] bg-[#f8fbff] p-4">
          {detailBusy && <div className="text-sm text-[#697a91]"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading breakdown…</div>}
          {detail && !detailBusy && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-[#1f3559]">{detail.coach} — client breakdown</span>
                <div className="flex flex-wrap gap-1 ml-2">
                  {["current", ...detail.dates].map((d) => (
                    <button key={d} onClick={() => openDetail(detail.coach, d)}
                      className={`text-[11px] rounded-md border px-2 py-0.5 ${detail.date === d ? "bg-[#1f3559] text-white border-[#1f3559]" : "border-[#cfe0f0] bg-white hover:bg-[#eef5fc]"}`}>
                      {d === "current" ? "Today" : d}
                    </button>
                  ))}
                </div>
                <button onClick={() => setDetail(null)} className="ml-auto text-xs text-[#697a91] hover:underline">close</button>
              </div>
              <p className="mt-1 text-xs text-[#697a91]">
                {detail.clients.filter((x) => x.status === "live").length} live &middot; {detail.clients.filter((x) => x.status === "paused").length} paused &middot; {detail.clients.filter((x) => x.status === "offboarded").length} offboarded
                {detail.prevDate && <> &middot; changes shown vs {detail.prevDate}</>}
              </p>
              <div className="mt-2 grid md:grid-cols-2 gap-1">
                {detail.clients.map((cl, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1.5 bg-white">
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold border ${
                      cl.status === "live" ? "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]"
                      : cl.status === "paused" ? "bg-[#fff3e6] text-[#c2410c] border-[#fdba74]"
                      : "bg-[#f6f6f8] text-[#697a91] border-[#e4ebf2]"}`}>{cl.status}</span>
                    <span className="font-medium text-[#1f3559] truncate">{cl.owner}</span>
                    <span className="text-[#8595a8] truncate">{cl.biz}</span>
                    {cl.prevStatus !== null && cl.prevStatus !== cl.status && (
                      <span className="ml-auto shrink-0 text-[10px] font-semibold text-[#7c3aed]">{cl.prevStatus || "new"} &rarr; {cl.status}</span>
                    )}
                    {cl.prevStatus === null && detail.prevDate && (
                      <span className="ml-auto shrink-0 text-[10px] font-semibold text-[#0e8f88]">new to {detail.coach}</span>
                    )}
                  </div>
                ))}
              </div>
              {detail.gone.length > 0 && (
                <details className="mt-2 text-xs text-[#697a91]">
                  <summary className="cursor-pointer">No longer with {detail.coach} ({detail.gone.length}) — reassigned or removed since {detail.prevDate}</summary>
                  <ul className="mt-1 ml-4 list-disc">{detail.gone.map((g, i) => <li key={i}>{g.owner} ({g.biz}) — was {g.was}</li>)}</ul>
                </details>
              )}
            </>
          )}
        </div>
      )}
      {hiddenRows.length > 0 && (
        <details className="mt-3 text-sm text-[#697a91]">
          <summary className="cursor-pointer text-xs">
            Hidden ({hiddenRows.length}) — former coaches &amp; non-coaches, history kept
          </summary>
          <ul className="mt-2 grid gap-1">
            {hiddenRows.map((c) => (
              <li key={c.coach} className="flex items-center gap-2 border border-[#e4ebf2] rounded-lg px-3 py-1.5 bg-[#f9fbfd] text-xs">
                <span className="font-semibold text-[#1f3559]">{c.coach}</span>
                <span>{c.live} live client{c.live === 1 ? "" : "s"} still assigned</span>
                {c.live > 0 && <span className="text-[#b4485c] font-medium">&#9888; reassign them</span>}
                <button onClick={() => setCoachHidden(c.coach, false)}
                  className="ml-auto text-[#0b7f7f] hover:underline">unhide</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function SalesPage() {
  const [view, setView] = useState<"board" | "demos" | "coaches">("board");
  // Sales seats (setter / closer / both) get the board only — the Demo
  // Checker and Coach Tracker are salary tools for admins.
  const { role } = useUser();
  const isAdmin = role === "admin";
  const [raw, setRaw] = useState("");
  const [results, setResults] = useState<DemoResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Names pasted more than once — checked once, but the owner wants to know.
  const [duplicates, setDuplicates] = useState<string[]>([]);
  // Every run is saved server-side; this is the list to bring one back.
  type PastCheck = { id: string; user_email: string | null; names: string[]; results: DemoResult[]; showed: number; total: number; created_at: string };
  const [history, setHistory] = useState<PastCheck[]>([]);
  const [viewingPast, setViewingPast] = useState<PastCheck | null>(null);
  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/sales/demo-check");
      if (r.ok) setHistory(((await r.json()).checks as PastCheck[]) ?? []);
    } catch { /* history is a convenience */ }
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);
  const showPast = (c: PastCheck) => {
    setViewingPast(c);
    setRaw(c.names.join("\n"));
    setResults(c.results);
    setDuplicates([]);
    setErr(null);
  };
  // One entry per day — the last check of that day. Re-running the same list
  // several times an afternoon used to fill the picker with near-identical rows.
  const historyByDay = history.filter((c, i, all) => {
    const day = new Date(c.created_at).toDateString();
    return all.findIndex((o) => new Date(o.created_at).toDateString() === day) === i; // newest-first, so first hit = last check
  });

  const names = raw.split(/[\n,]/).map((n) => n.trim()).filter(Boolean);

  async function run() {
    setBusy(true);
    setErr(null);
    setResults(null);
    try {
      const r = await fetch("/api/sales/demo-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setResults(j.results as DemoResult[]);
      setDuplicates((j.duplicates as string[]) ?? []);
      setViewingPast(null);
      loadHistory();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const shown = results?.filter((r) => r.status === "showed").length ?? 0;
  const resolved = results?.filter((r) => r.status !== "not_yet" && r.status !== "not_in_system").length ?? 0;

  // The exact message the team posts in Slack after a check — same sections,
  // same emojis, "Showed" counted against everything checked.
  function copyForSlack() {
    if (!results) return;
    const blocks: string[] = [];
    for (const sec of SECTIONS) {
      const rows = results.filter((r) => r.status === sec.key);
      if (!rows.length) continue;
      const count = sec.key === "showed" ? `(${rows.length}/${results.length})` : `${rows.length}`;
      const lines = rows.map((r) => {
        const extra = [sec.key === "not_yet" ? whenLine(r) : "", r.note].filter(Boolean).join(" — ");
        return extra ? `${r.query} — ${extra}` : r.query;
      });
      blocks.push(`${sec.emoji} ${sec.label} — ${count}\n${lines.join("\n")}`);
    }
    if (duplicates.length) blocks.push(`🔁 Pasted twice, counted once: ${duplicates.join(", ")}`);
    navigator.clipboard.writeText(blocks.join("\n\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-[#1f3559] tracking-tight">💼 Sales</h1>
      {isAdmin && <div className="mt-3 flex gap-1 rounded-lg bg-[#eef2f7] p-1 w-fit flex-wrap">
        {([["board", "Sales board"], ["demos", "Demo Checker"], ["coaches", "Coach Tracker"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setView(k)}
            className={`px-4 py-1.5 rounded-md text-sm font-semibold ${view === k ? "bg-white text-[#0e8f88] shadow-sm" : "text-[#697a91]"}`}>
            {label}
          </button>
        ))}
      </div>}
      {view === "board" || !isAdmin ? <SalesBoardView /> : view === "coaches" ? <CoachTracker /> : (<>
      <p className="mt-4 text-sm text-[#697a91]">
        Paste contact names (one per line). Each is checked against its sales-pipeline stage — the stage is what proves
        whether the demo actually happened, since a past demo stays &ldquo;confirmed&rdquo; on the calendar either way.
      </p>

      {history.length > 0 && (
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <label className="text-xs font-semibold text-[#697a91]">Previous checks</label>
          <select
            value={viewingPast?.id ?? ""}
            onChange={(e) => { const c = history.find((h) => h.id === e.target.value); if (c) showPast(c); }}
            className="px-2 py-1.5 rounded-lg border border-[#e4ebf2] bg-white text-xs text-[#34568a] max-w-[420px]"
          >
            <option value="">Bring back an earlier list…</option>
            {historyByDay.map((c) => (
              <option key={c.id} value={c.id}>
                {new Date(c.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                {" — "}{c.total} name{c.total === 1 ? "" : "s"}, {c.showed} showed
                {c.user_email ? ` · ${c.user_email.split("@")[0]}` : ""}
              </option>
            ))}
          </select>
          {viewingPast && (
            <span className="text-[11px] text-[#8595a8]">
              Showing the list from {new Date(viewingPast.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} as it was then — press <b>Check</b> to re-run it for today&apos;s statuses.
            </span>
          )}
        </div>
      )}

      <div className="mt-5 rounded-xl border border-[#e4ebf2] bg-white p-4">
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={8}
          placeholder={"Cynthia Lowry\nGina Alsaddi\nLiza Martinez"}
          className="w-full rounded-lg border border-[#e4ebf2] p-3 text-sm text-[#1f3559] outline-none focus:border-[#15B7AE] font-mono"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={run}
            disabled={busy || !names.length}
            className="rounded-lg bg-[#15B7AE] px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy && <Loader2 size={13} className="animate-spin inline mr-1.5 -mt-0.5" />}{busy ? `Checking ${names.length}…` : `Check ${names.length || ""} contact${names.length === 1 ? "" : "s"}`}
          </button>
          <span className="text-xs text-[#8595a8]">
            {names.length > 25 ? "Large lists take a while — roughly a second per name." : " "}
          </span>
        </div>
      </div>

      {err && (
        <div className="mt-4 rounded-lg border border-[#d97070] bg-[#fdf3f3] p-3 text-sm text-[#8a3a3a]">{err}</div>
      )}

      {results && (
        <>
          {duplicates.length > 0 && (
            <div className="mt-4 rounded-lg border border-[#d0a05e] bg-[#fbf7f1] px-4 py-2.5 text-sm text-[#7a5a1e]">
              🔁 <b>{duplicates.length === 1 ? "1 name was" : `${duplicates.length} names were`} pasted more than once</b> — checked and counted once: {duplicates.join(", ")}
            </div>
          )}
          <div className="mt-6 rounded-xl border border-[#e4ebf2] bg-white px-4 py-3 text-sm text-[#1f3559] flex items-center gap-3 flex-wrap">
            <span>
              <strong>{shown}</strong> showed out of <strong>{resolved}</strong> resolved
              {resolved > 0 && <> — <strong>{Math.round((shown / resolved) * 100)}%</strong> show rate</>}
              <span className="text-[#8595a8]"> · {results.length} checked</span>
            </span>
            <button
              onClick={copyForSlack}
              className="ml-auto rounded-lg border border-[#15B7AE] bg-[#f0fbfa] px-4 py-1.5 text-xs font-bold text-[#0e8f88] hover:bg-[#e0f6f4]"
            >
              {copied ? "Copied ✓ — paste it in Slack" : "📋 Copy for Slack"}
            </button>
          </div>

          {SECTIONS.map((s) => {
            const rows = results.filter((r) => r.status === s.key);
            if (!rows.length) return null;
            return (
              <div key={s.key} className="mt-5">
                <h2 className="text-sm font-bold text-[#1f3559] tracking-tight">
                  {s.emoji} {s.label} <span className="text-[#8595a8] font-semibold">— {rows.length}</span>
                </h2>
                <div className="mt-2 rounded-xl border border-[#e4ebf2] overflow-hidden">
                  {rows.map((r, i) => (
                    <div
                      key={`${r.query}-${i}`}
                      className="flex items-start gap-3 px-4 py-2.5 border-l-4"
                      style={{
                        background: i % 2 ? "#ffffff" : s.tint,
                        borderLeftColor: s.border,
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-[#1f3559]">{r.query}</div>
                        {(r.contactName || r.email) && (
                          <div className="text-xs text-[#8595a8] truncate">
                            {r.contactName}
                            {r.email ? ` · ${r.email}` : ""}
                          </div>
                        )}
                        {s.key === "not_yet" && r.appointmentAt && (
                          <div className="text-xs text-[#34568a] mt-0.5">
                            📅 Booked <b>{fmtLocal(r.bookedAt)}</b> · demo <b>{fmtLocal(r.appointmentAt)}</b> <span className="text-[#8595a8]">(Pacific)</span>
                          </div>
                        )}
                        {r.note && <div className="text-xs text-[#a3616b] mt-0.5">{r.note}</div>}
                        {r.alternates && r.alternates.length > 0 && (
                          <details className="mt-1">
                            <summary className="text-xs text-[#697a91] cursor-pointer">
                              {r.alternates.length} other contact{r.alternates.length === 1 ? "" : "s"} with this name
                            </summary>
                            <ul className="mt-1 ml-3 list-disc text-xs text-[#8595a8]">
                              {r.alternates.map((a, k) => <li key={k}>{a}</li>)}
                            </ul>
                          </details>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        {r.stage && <div className="text-xs font-medium text-[#34568a]">{r.stage}</div>}
                        {r.demoDate && <div className="text-[11px] text-[#a3adbb]">{r.demoDate}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}
      </>)}
    </div>
  );
}
