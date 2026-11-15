"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { DialerActivity as Act, DialerRange, CallStep, LeadRun } from "@/lib/dialer-activity";

// Sales → Dialer → Activity (owner 11/15/2026: "keep track of everything
// she's doing — what time she calls, and if the system works properly").
// Numbers first; the lead table under it. All times Pacific.

const LOC = "SfpNMJ5YU9lBkxss47lK";
const WINDOW_HOURS = new Set([10, 11, 14, 15, 16]); // 10–12 and 2:30–4:30 PT (the 2 PM / 4 PM cells are half in)
const HOURS = Array.from({ length: 15 }, (_, i) => i + 6); // 6 AM – 8 PM PT

const time = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const dayLabel = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "2-digit", day: "2-digit", timeZone: "UTC" });
const ptYmd = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "a" : "p"}`;
const LIST_LABEL: Record<string, string> = { discovery_noshow: "Discovery no-show", demo_noshow: "Demo no-show", showed_no_close: "Showed, didn't close", followup: "Follow-up", demo_no_update: "Demo, no update" };

function outcome(s: CallStep): string {
  if ((s.seconds ?? 0) > 0) return `${Math.floor((s.seconds ?? 0) / 60)}:${String((s.seconds ?? 0) % 60).padStart(2, "0")}`;
  if (/no-?answer/i.test(s.status)) return "No answer";
  if (/busy/i.test(s.status)) return "Busy";
  if (/fail|error/i.test(s.status)) return "Failed";
  if (/voicemail/i.test(s.status)) return "Voicemail";
  return s.status || "—";
}
function Step({ s }: { s: CallStep | null }) {
  if (!s) return <span className="text-[#b6c0cc]">—</span>;
  const bad = /fail|error/i.test(s.status);
  return (
    <span className="whitespace-nowrap">
      {time(s.at)} <span className={bad ? "text-red-600 font-semibold" : (s.seconds ?? 0) >= 60 ? "text-[#15803d] font-semibold" : "text-[#8595a8]"}>· {outcome(s)}</span>
      {s.byOther && <span className="block text-[10px] text-[#b45309]">by {s.byOther}</span>}
    </span>
  );
}
const RESULT: Record<LeadRun["result"], [string, string]> = {
  talked: ["Talked", "bg-[#dcfce7] text-[#15803d] border-[#bbf7d0]"],
  done: ["Call, call, text ✓", "bg-[#eefaf9] text-[#0f8f88] border-[#bfe6e3]"],
  in_progress: ["Started", "bg-[#fff7ec] text-[#b45309] border-[#fcd9a8]"],
  waiting: ["Not called yet", "bg-[#f8fafc] text-[#8595a8] border-[#e4ebf2]"],
};

type Resp = Act & { people: Array<{ id: string; name: string }>; isAdmin: boolean };

export default function DialerActivity() {
  // "" = let the server pick (the setter for an admin, yourself for a sales seat).
  const [user, setUser] = useState("");
  const [range, setRange] = useState<DialerRange>("today");
  const [act, setAct] = useState<Resp | null>(null);
  const people = act?.people ?? [];
  const isAdmin = !!act?.isAdmin;
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(fresh = false) {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/dialer/activity?user=${encodeURIComponent(user)}&range=${range}${fresh ? "&fresh=1" : ""}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "failed");
      setAct(j as Resp);
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    setLoading(false);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setAct(null); void load(); }, [user, range]);

  const chip = (on: boolean) => `px-2.5 py-1 rounded-full text-xs font-semibold border whitespace-nowrap ${on ? "bg-[#0e8f88] text-white border-[#0e8f88]" : "bg-white text-[#34568a] border-[#e4ebf2]"}`;
  const sel = "px-2 py-1 rounded-lg border border-[#e4ebf2] bg-white text-xs text-[#34568a]";
  const h = act?.health;
  const problems = (act?.leads ?? []).filter((l) => l.problems.length);

  return (
    <div className="mt-4 space-y-3">
      <div className="flex gap-2 flex-wrap items-center">
        {isAdmin && (
          <select value={user || act?.caller.id || ""} onChange={(e) => setUser(e.target.value)} className={sel}>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {([["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7 days"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setRange(k)} className={chip(range === k)}>{l}</button>
        ))}
        <button onClick={() => void load(true)} disabled={loading} className="ml-auto flex items-center gap-1 text-xs text-[#34568a] underline disabled:opacity-50">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
        </button>
      </div>

      {err && <div className="text-sm text-red-600">{err}</div>}
      {!act && !err && <div className="text-sm text-[#697a91] flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Reading calls from GHL…</div>}

      {act && h && (<>
        {/* Is the system working? */}
        <div className="rounded-xl border border-[#e4ebf2] bg-white px-4 py-3">
          <div className="text-sm font-bold text-[#1f3559]">Leads sent to the dialer: {h.sent}</div>
          {h.sent === 0 ? (
            <div className="text-xs text-[#697a91] mt-0.5">None in this time. Leads appear here after &ldquo;Start dialer&rdquo;.</div>
          ) : (
            <div className="mt-1 flex gap-1.5 flex-wrap text-xs">
              <span className="px-2 py-0.5 rounded-full bg-[#f6f8fb] text-[#34568a]">{h.called} called</span>
              <span className="px-2 py-0.5 rounded-full bg-[#eefaf9] text-[#0f8f88]">{h.done} finished</span>
              <span className="px-2 py-0.5 rounded-full bg-[#dcfce7] text-[#15803d]">{h.talked} talked</span>
              <span className="px-2 py-0.5 rounded-full bg-[#f6f8fb] text-[#34568a]">{h.textsSent} texts sent</span>
              <span className="px-2 py-0.5 rounded-full bg-[#f6f8fb] text-[#34568a]">{h.replied} wrote or called back</span>
              {h.textsFailed > 0 && <span className="px-2 py-0.5 rounded-full bg-[#fee2e2] text-[#b91c1c] font-semibold">{h.textsFailed} texts failed</span>}
              {h.callsFailed > 0 && <span className="px-2 py-0.5 rounded-full bg-[#fee2e2] text-[#b91c1c] font-semibold">{h.callsFailed} calls failed</span>}
            </div>
          )}
          {problems.length > 0 && (
            <ul className="mt-2 text-xs text-[#b91c1c] space-y-0.5">
              {problems.slice(0, 8).map((l) => <li key={l.contactId}>⚠ {l.name}: {l.problems.join(", ")}</li>)}
              {problems.length > 8 && <li>…and {problems.length - 8} more below</li>}
            </ul>
          )}
        </div>

        {/* When she calls */}
        {act.days.length === 0 ? (
          <div className="rounded-xl border border-[#e4ebf2] bg-white px-4 py-3 text-sm text-[#697a91]">No calls by {act.caller.name.split(" ")[0]} in this time.</div>
        ) : act.days.map((d) => (
          <div key={d.ymd} className="rounded-xl border border-[#e4ebf2] bg-white px-4 py-3">
            <div className="text-sm font-bold text-[#1f3559]">
              {dayLabel(d.ymd)} · {d.calls} calls · {d.first ? time(d.first) : ""}–{d.last ? time(d.last) : ""} PT
            </div>
            <div className="text-xs text-[#697a91] mt-0.5">
              {d.talked} talked 1 min+ · {d.noAnswer} no answer
              {d.failed > 0 && <span className="text-red-600 font-semibold"> · {d.failed} failed</span>}
              {d.outsideWindow > 0 && <span className="text-[#b45309]"> · {d.outsideWindow} outside call times</span>}
              {d.outsideLocal > 0 && <span className="text-[#b45309]"> · {d.outsideLocal} when it was before 9 AM or after 8 PM for the lead</span>}
            </div>
            <div className="mt-2 flex gap-0.5 overflow-x-auto">
              {HOURS.map((hr) => {
                const n = d.hours[hr] ?? 0;
                return (
                  <div key={hr} className={`min-w-[30px] text-center rounded px-0.5 py-1 ${WINDOW_HOURS.has(hr) ? "bg-[#eefaf9]" : "bg-[#f8fafc]"}`} title={`${n} calls at ${hourLabel(hr)} PT`}>
                    <div className={`text-xs tabular-nums ${n ? "font-bold text-[#1f3559]" : "text-[#c3cdd9]"}`}>{n || "·"}</div>
                    <div className="text-[9px] text-[#8595a8]">{hourLabel(hr)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {/* Each lead sent to the dialer */}
        {act.leads.length > 0 && (
          <div className="rounded-xl border border-[#e4ebf2] bg-white overflow-x-auto">
            <table className="w-full text-xs min-w-[620px]">
              <thead className="bg-[#f6f8fb] text-[#697a91]">
                <tr>
                  <th className="p-2 text-left">Lead</th>
                  <th className="p-2 text-left">Sent</th>
                  <th className="p-2 text-left">Call 1</th>
                  <th className="p-2 text-left">Call 2</th>
                  <th className="p-2 text-left">Text</th>
                  <th className="p-2 text-left">Result</th>
                </tr>
              </thead>
              <tbody>
                {act.leads.map((l) => (
                  <tr key={l.contactId} className="border-t border-[#f0f3f7] align-top">
                    <td className="p-2">
                      <a href={`https://app.gohighlevel.com/v2/location/${LOC}/contacts/detail/${l.contactId}`} target="_blank" rel="noreferrer" className="font-semibold text-[#1f3559] hover:underline">{l.name}</a>
                      <span className="block text-[10px] text-[#8595a8]">{l.list ? LIST_LABEL[l.list] ?? l.list : ""}{l.replied ? " · wrote or called back" : ""}</span>
                    </td>
                    <td className="p-2 whitespace-nowrap text-[#697a91]">{time(l.sentAt)}{act.range === "7d" && <span className="block text-[10px]">{dayLabel(ptYmd(l.sentAt))}</span>}</td>
                    <td className="p-2"><Step s={l.call1} /></td>
                    <td className="p-2"><Step s={l.call2} /></td>
                    <td className="p-2 whitespace-nowrap">{l.text ? <>{time(l.text.at)} <span className={/fail|undeliver/i.test(l.text.status) ? "text-red-600 font-semibold" : "text-[#8595a8]"}>· {/fail|undeliver/i.test(l.text.status) ? "Failed" : "Sent"}</span></> : <span className="text-[#b6c0cc]">—</span>}</td>
                    <td className="p-2"><span className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold whitespace-nowrap ${RESULT[l.result][1]}`}>{RESULT[l.result][0]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>)}
    </div>
  );
}
