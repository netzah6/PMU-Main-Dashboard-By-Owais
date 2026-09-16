"use client";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Copy, Check, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SalesBoard as Board, SetterStats, CloserStats, Todo, Win } from "@/lib/sales-board";
import { TARGETS, WINDOWS, FORMER } from "@/lib/sales-board";

/* The Sales tab: two seats — the appointment setter (discovery calls) and the
   closer (demo calls). For each: the KPIs the trackers print, graded against
   the same targets, and a to-do list of the people slipping through (no-shows,
   cancellations, didn't-book, missing status) with their follow-up count. */

const GHL_CONTACTS = "https://app.gohighlevel.com/v2/location/SfpNMJ5YU9lBkxss47lK/contacts/smart_list/All";

const KIND: Record<Todo["kind"], { label: string; icon: string; cls: string; hint: string }> = {
  booked:       { label: "Booked a demo",      icon: "📆", cls: "bg-sky-50 text-sky-700 border-sky-200", hint: "Discovery done and a demo booked — the demo's outcome is shown next to it." },
  no_show:      { label: "Discovery no-show", icon: "❌", cls: "bg-rose-50 text-rose-700 border-rose-200", hint: "Booked a discovery call and didn't show — call, text, rebook." },
  cancelled:    { label: "Cancelled",          icon: "⛔", cls: "bg-amber-50 text-amber-800 border-amber-200", hint: "Cancelled the discovery — find out why and rebook." },
  didnt_book:   { label: "Didn't book a demo", icon: "📵", cls: "bg-orange-50 text-orange-700 border-orange-200", hint: "Showed to the discovery, no demo booked — follow up." },
  no_status:    { label: "Missing status",     icon: "❓", cls: "bg-slate-100 text-slate-700 border-slate-300", hint: "The call time has passed and the sheet has no status — update it." },
  demo_no_show: { label: "Demo no-show",       icon: "❌", cls: "bg-rose-50 text-rose-700 border-rose-200", hint: "Booked a demo and didn't show — call, text, rebook." },
  didnt_close:  { label: "Didn't close",       icon: "💬", cls: "bg-orange-50 text-orange-700 border-orange-200", hint: "Had the demo, didn't buy — follow up." },
  upcoming:     { label: "Upcoming demo",      icon: "📅", cls: "bg-teal-50 text-teal-700 border-teal-200", hint: "Coming up — confirm and prepare." },
  closed:       { label: "Closed",             icon: "✅", cls: "bg-emerald-50 text-emerald-700 border-emerald-200", hint: "Won — upfront collected as logged in the sheet." },
};

const fmtWhen = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
const grade = (v: number | null, target: number) => v == null ? "gray" : v >= target ? "green" : v >= target * 0.8 ? "yellow" : "red";
const TONE: Record<string, string> = {
  green: "bg-[#e6f7ee] text-[#15803d] border-[#86efac]", yellow: "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]",
  red: "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]", gray: "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]",
};

function Kpi({ label, value, sub, tone = "gray", hint }: { label: string; value: string; sub?: string; tone?: string; hint?: string }) {
  return (
    <div className={cn("rounded-xl border px-3 py-2 min-w-[120px]", TONE[tone])} title={hint}>
      <div className="text-[10px] font-bold uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-xl font-extrabold leading-tight">{value}</div>
      {sub && <div className="text-[10px] opacity-80">{sub}</div>}
    </div>
  );
}

function CopyName({ name }: { name: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(name).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }); }}
      className="text-[#8595a8] hover:text-[#0e8f88]" title="Copy the name (then search it in GHL)">
      {ok ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function TodoList({ todos, who, kinds, win }: { todos: Todo[]; who: string; kinds: Todo["kind"][]; win: Win }) {
  const [kind, setKind] = useState<Todo["kind"] | "all">("all");
  const mine = todos.filter((t) => (who === "ALL" || t.who === who) && kinds.includes(t.kind) && (t.kind === "upcoming" || t.ageDays <= win));
  const shown = mine.filter((t) => kind === "all" || t.kind === kind);
  const counts = Object.fromEntries(kinds.map((k) => [k, mine.filter((t) => t.kind === k).length]));
  return (
    <div className="rounded-xl border border-[#e4ebf2] bg-white">
      <div className="px-3 py-2 border-b border-[#eef3f8] flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-[#1f3559]">Last {win} days</span>
        <span className="text-[11px] text-[#697a91]">{mine.filter((t) => t.urgent).length} need attention now</span>
        <div className="ml-auto flex gap-1 flex-wrap">
          <button onClick={() => setKind("all")} className={cn("px-2 py-0.5 rounded text-[11px] font-semibold border", kind === "all" ? "bg-[#1f3559] text-white border-[#1f3559]" : "bg-white text-[#34568a] border-[#d7e0ea]")}>All ({mine.length})</button>
          {kinds.map((k) => (
            <button key={k} onClick={() => setKind(k)} className={cn("px-2 py-0.5 rounded text-[11px] font-semibold border", kind === k ? "bg-[#1f3559] text-white border-[#1f3559]" : KIND[k].cls)}>
              {KIND[k].icon} {KIND[k].label} ({counts[k]})
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="px-3 py-4 text-sm text-[#8595a8]">Nothing here — everyone in this list has been handled. 🎉</p>
      ) : (
        <ul className="divide-y divide-[#eef3f8] max-h-[60vh] overflow-y-auto">
          {shown.map((t, i) => (
            <li key={i} className={cn("px-3 py-2 flex items-center gap-2 flex-wrap text-[12px]", t.urgent && "bg-[#fffaf5]")}>
              <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-bold border whitespace-nowrap", KIND[t.kind].cls)} title={KIND[t.kind].hint}>{KIND[t.kind].icon} {KIND[t.kind].label}</span>
              <a href={GHL_CONTACTS} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#1f3559] hover:underline" title="Open GHL contacts (name copied with the button)">{t.name}</a>
              <CopyName name={t.name} />
              {(who === "ALL" || t.who === FORMER) && <span className="text-[#697a91]">· {t.who === FORMER ? `sheet says ${t.sheetWho}` : t.who}</span>}
              <span className="text-[#697a91] whitespace-nowrap">· {fmtWhen(t.when)}{t.kind !== "upcoming" && t.ageDays > 0 ? ` · ${t.ageDays}d ago` : ""}</span>
              {t.kind === "booked" && t.demo && (() => {
                const o = t.demo.outcome;
                const M: Record<typeof o, { txt: string; cls: string }> = {
                  closed: { txt: "✅ Demo showed · closed", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
                  showed: { txt: "✅ Demo showed", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
                  didnt_close: { txt: "✅ Demo showed · didn't close", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
                  no_show: { txt: "❌ Demo NO-SHOW", cls: "bg-rose-50 text-rose-700 border-rose-200" },
                  cancelled: { txt: "⛔ Demo cancelled", cls: "bg-amber-50 text-amber-800 border-amber-200" },
                  upcoming: { txt: "📅 Demo coming up", cls: "bg-teal-50 text-teal-700 border-teal-200" },
                  pending: { txt: "❓ Demo happened, no status yet", cls: "bg-slate-100 text-slate-700 border-slate-300" },
                  missing: { txt: "❓ Not in the demos sheet", cls: "bg-slate-100 text-slate-700 border-slate-300" },
                };
                return <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-bold border whitespace-nowrap", M[o].cls)} title={t.demo.when ? `Demo ${fmtWhen(t.demo.when)}` : undefined}>{M[o].txt}{t.demo.when ? ` · ${fmtWhen(t.demo.when)}` : ""}</span>;
              })()}
              {t.kind === "closed" && <span className="font-bold text-[#15803d]">{t.amount ? `$${t.amount.toLocaleString()}` : "no upfront logged"}</span>}
              {t.kind !== "upcoming" && t.kind !== "no_status" && t.kind !== "closed" && (t.kind !== "booked" || t.demo?.outcome === "no_show") && (
                <span className="inline-flex items-center gap-0.5 ml-1" title={t.lastFollowUp ? `Last follow-up: ${t.lastFollowUp}` : "No follow-up logged yet"}>
                  {[0, 1, 2].map((n) => <span key={n} className={cn("w-2.5 h-2.5 rounded-full border", n < t.followUps ? "bg-[#15B7AE] border-[#15B7AE]" : "bg-white border-[#c3cdd9]")} />)}
                  <span className="ml-1 text-[10px] text-[#697a91]">{t.followUps}/3 follow-ups</span>
                </span>
              )}
              {t.urgent && <span className="text-[10px] font-bold text-[#be123c]">← {t.followUps === 0 && t.kind !== "no_status" ? "no follow-up yet" : t.kind === "no_status" ? "update the sheet" : "next follow-up due"}</span>}
              {t.notes && <span className="w-full text-[11px] text-[#8595a8] italic pl-1">“{t.notes}”</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SetterView({ b, who, win }: { b: Board; who: string; win: Win }) {
  const s: SetterStats | undefined = b.setterStats[who]?.[win];
  if (!s) return null;
  const p = (v: number | null) => v == null ? "—" : `${v}%`;
  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        <Kpi label="Discoveries" value={String(s.total)} sub={`${s.noStatus} without a status`} tone={s.noStatus > 0 ? "yellow" : "gray"} hint="Leads assigned in the window (by sign-up date)" />
        <Kpi label="Show-up rate" value={p(s.showUp)} sub={`target ${TARGETS.discShowUp}% · ${s.noShow} no-show · ${s.cancelled} cancelled`} tone={grade(s.showUp, TARGETS.discShowUp)} hint="(discoveries − no-shows − cancelled) ÷ discoveries" />
        <Kpi label="Demos booked" value={String(s.demoScheduled)} sub={`${s.didntBook} didn't book · ${s.disqualified} disqualified`} tone="gray" />
        <Kpi label="Book rate" value={p(s.bookRate)} sub={`target ${TARGETS.bookRate}% · ${p(s.bookRateExDisq)} excl. disqualified`} tone={grade(s.bookRate, TARGETS.bookRate)} hint="demos booked ÷ discoveries (the tracker's definition)" />
        <Kpi label="Demo show-up" value={p(s.demoShowUp)} sub={`target ${TARGETS.demoShowUp}%`} tone={grade(s.demoShowUp, TARGETS.demoShowUp)} hint="Of the demos this setter booked that have a status, how many actually happened" />
      </div>
      <TodoList todos={b.setterTodos} who={who} win={win} kinds={["booked", "no_show", "cancelled", "didnt_book", "no_status"]} />
    </div>
  );
}

function CloserView({ b, who, win }: { b: Board; who: string; win: Win }) {
  const s: CloserStats | undefined = b.closerStats[who]?.[win];
  if (!s) return null;
  const p = (v: number | null) => v == null ? "—" : `${v}%`;
  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        <Kpi label="Demos" value={String(s.total)} sub={`${s.noStatus} without a status`} tone={s.noStatus > 0 ? "yellow" : "gray"} hint="Demos in the window (by demo date)" />
        <Kpi label="Demo show-up" value={p(s.showUp)} sub={`target ${TARGETS.demoShowUp}% · ${s.noShow} no-show`} tone={grade(s.showUp, TARGETS.demoShowUp)} hint="(demos − no-shows − cancelled) ÷ demos" />
        <Kpi label="Closed" value={String(s.closed)} sub={`${s.didntClose} didn't close`} tone="gray" />
        <Kpi label="Close rate" value={p(s.closeRate)} sub={`target ${TARGETS.closeRate}%`} tone={grade(s.closeRate, TARGETS.closeRate)} hint="closed ÷ demos that happened" />
        <Kpi label="Upfront collected" value={`$${s.upfront.toLocaleString()}`} tone={s.upfront > 0 ? "green" : "gray"} />
      </div>
      <TodoList todos={b.closerTodos} who={who} win={win} kinds={["closed", "upcoming", "demo_no_show", "didnt_close", "no_status"]} />
    </div>
  );
}

function TeamTable({ b, win }: { b: Board; win: Win }) {
  const p = (v: number | null) => v == null ? "—" : `${v}%`;
  return (
    <div className="grid lg:grid-cols-2 gap-3">
      <div className="rounded-xl border border-[#e4ebf2] bg-white overflow-auto">
        <div className="px-3 py-2 text-sm font-bold text-[#1f3559] border-b border-[#eef3f8]">Appointment setters · last {win} days</div>
        <table className="w-full text-[12px]">
          <thead><tr className="text-left text-[10px] uppercase text-[#697a91]"><th className="px-3 py-1.5">Setter</th><th className="px-2 py-1.5 text-right">Disc.</th><th className="px-2 py-1.5 text-right">Show-up</th><th className="px-2 py-1.5 text-right">Demos</th><th className="px-2 py-1.5 text-right">Book rate</th><th className="px-2 py-1.5 text-right">No status</th></tr></thead>
          <tbody>{b.setters.map((n) => { const s = b.setterStats[n][win]; return (
            <tr key={n} className={cn("border-t border-[#eef3f8]", n === FORMER && "text-[#8595a8] italic")}><td className="px-3 py-1.5 font-semibold text-[#1f3559]">{n === FORMER ? "⚠ Former reps (sheet)" : n}</td><td className="px-2 py-1.5 text-right">{s.total}</td>
              <td className={cn("px-2 py-1.5 text-right font-semibold", TONE[grade(s.showUp, TARGETS.discShowUp)].split(" ")[1])}>{p(s.showUp)}</td><td className="px-2 py-1.5 text-right">{s.demoScheduled}</td>
              <td className={cn("px-2 py-1.5 text-right font-semibold", TONE[grade(s.bookRate, TARGETS.bookRate)].split(" ")[1])}>{p(s.bookRate)}</td><td className={cn("px-2 py-1.5 text-right", s.noStatus > 0 && "text-[#d97706] font-semibold")}>{s.noStatus}</td></tr>); })}</tbody>
        </table>
      </div>
      <div className="rounded-xl border border-[#e4ebf2] bg-white overflow-auto">
        <div className="px-3 py-2 text-sm font-bold text-[#1f3559] border-b border-[#eef3f8]">Closers · last {win} days</div>
        <table className="w-full text-[12px]">
          <thead><tr className="text-left text-[10px] uppercase text-[#697a91]"><th className="px-3 py-1.5">Closer</th><th className="px-2 py-1.5 text-right">Demos</th><th className="px-2 py-1.5 text-right">Show-up</th><th className="px-2 py-1.5 text-right">Closed</th><th className="px-2 py-1.5 text-right">Close rate</th><th className="px-2 py-1.5 text-right">Upfront</th></tr></thead>
          <tbody>{b.closers.map((n) => { const s = b.closerStats[n][win]; return (
            <tr key={n} className={cn("border-t border-[#eef3f8]", n === FORMER && "text-[#8595a8] italic")}><td className="px-3 py-1.5 font-semibold text-[#1f3559]">{n === FORMER ? "⚠ Former reps (sheet)" : n}</td><td className="px-2 py-1.5 text-right">{s.total}</td>
              <td className={cn("px-2 py-1.5 text-right font-semibold", TONE[grade(s.showUp, TARGETS.demoShowUp)].split(" ")[1])}>{p(s.showUp)}</td><td className="px-2 py-1.5 text-right">{s.closed}</td>
              <td className={cn("px-2 py-1.5 text-right font-semibold", TONE[grade(s.closeRate, TARGETS.closeRate)].split(" ")[1])}>{p(s.closeRate)}</td><td className="px-2 py-1.5 text-right font-semibold text-[#0e8f88]">${s.upfront.toLocaleString()}</td></tr>); })}</tbody>
        </table>
      </div>
    </div>
  );
}

type Scoped = Board & { scope?: { setter: boolean; closer: boolean; myName: string } };

export function SalesBoardView() {
  const [b, setB] = useState<Scoped | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [seat, setSeat] = useState<"setter" | "closer" | "team">("setter");
  const [win, setWin] = useState<Win>(30);
  const [who, setWho] = useState<string>("ALL");
  const load = async () => {
    setLoading(true); setErr(null);
    try { const r = await fetch("/api/sales/board"); const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); setB(j); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  // A sales seat only gets its own side from the API: hide the other seat's
  // button (and the team table), and land on the side they do have.
  const scope = b?.scope;
  const seats = useMemo(() => ([
    ...(!scope || scope.setter ? [["setter", "📞 Appointment setter"] as const] : []),
    ...(!scope || scope.closer ? [["closer", "🤝 Closer"] as const] : []),
    ...(!scope ? [["team", "👥 Whole team"] as const] : []),
  ]), [scope]);
  useEffect(() => { if (scope && !seats.some(([k]) => k === seat)) setSeat(seats[0]?.[0] ?? "setter"); }, [scope, seats, seat]);
  const people = useMemo(() => !b ? [] : seat === "setter" ? b.setters : seat === "closer" ? b.closers : [], [b, seat]);
  useEffect(() => { if (who !== "ALL" && !people.includes(who)) setWho("ALL"); }, [people, who]);
  useEffect(() => { if (scope?.closer && seat === "closer" && people.length === 1) setWho(people[0]); }, [scope, seat, people]);

  if (err) return <div className="mt-4 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] p-3 text-sm text-[#be123c]">{err}</div>;
  if (!b) return <div className="mt-6 flex items-center gap-2 text-sm text-[#697a91]"><Loader2 size={14} className="animate-spin" /> Loading the sales numbers…</div>;

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 rounded-lg bg-[#eef2f7] p-1">
          {seats.map(([k, l]) => (
            <button key={k} onClick={() => setSeat(k)} className={cn("px-3 py-1.5 rounded-md text-sm font-semibold", seat === k ? "bg-white text-[#0e8f88] shadow-sm" : "text-[#697a91]")}>{l}</button>
          ))}
        </div>
        <div className="flex gap-1 rounded-lg bg-[#eef2f7] p-1">
          {WINDOWS.map((w) => <button key={w} onClick={() => setWin(w)} className={cn("px-2.5 py-1 rounded-md text-xs font-semibold", win === w ? "bg-white text-[#0e8f88] shadow-sm" : "text-[#697a91]")}>{w}d</button>)}
        </div>
        {seat !== "team" && (
          <div className="flex gap-1 flex-wrap">
            {[...(scope && people.length <= 1 ? [] : ["ALL"]), ...people].map((n) => <button key={n} onClick={() => setWho(n)} title={n === FORMER ? "Leads whose sheet row still names a rep who left — see the note below" : undefined} className={cn("px-2.5 py-1 rounded-lg text-xs font-semibold border", who === n ? "bg-[#1f3559] text-white border-[#1f3559]" : n === FORMER ? "bg-white text-[#8595a8] border-dashed border-[#c3cdd9]" : "bg-white text-[#34568a] border-[#d7e0ea] hover:bg-[#f6f9fc]")}>{n === "ALL" ? "Everyone" : n === FORMER ? "⚠ Former reps" : n}</button>)}
          </div>
        )}
        <button onClick={load} disabled={loading} className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border border-[#d7e0ea] bg-white text-[#34568a] hover:bg-[#f6f9fc] disabled:opacity-60" title="The sheets sync every 15 minutes; this re-reads what's synced">
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> Reload
        </button>
      </div>
      <p className="text-[11px] text-[#8595a8]">
        From the Sales Calls Stats sheet + the setter/closer trackers (synced every 15 min). Targets: discovery show-up {TARGETS.discShowUp}%, book rate {TARGETS.bookRate}%, demo show-up {TARGETS.demoShowUp}%, close rate {TARGETS.closeRate}%.
        Follow-up dots come from the tracker sheets — mark them there.
      </p>
      {seat !== "team" && (() => {
        const former = seat === "setter" ? b.formerSetters : b.formerClosers;
        const names = Object.entries(former).sort((a, c) => c[1] - a[1]);
        if (!names.length) return null;
        return (
          <div className="rounded-lg border border-[#fcd9a8] bg-[#fff7ec] px-3 py-2 text-[11px] text-[#9a5b00]">
            ⚠ <b>{names.reduce((t, [, n]) => t + n, 0)} {seat === "setter" ? "leads" : "demos"} in the last 90 days</b> are marked in the sheet with someone who is not on the team any more
            ({names.map(([n, c]) => `${n} ${c}`).join(", ")}). Either the rep left, or a returning lead was written into their old row, which still carries the old rep&apos;s name (in GHL those leads are assigned to the current setter).
            They are pooled under <b>Former reps</b> and counted in Everyone; fix the name in the Sales Calls Stats sheet and they move to the right person.
          </div>
        );
      })()}
      {seat === "setter" && <SetterView b={b} who={who} win={win} />}
      {seat === "closer" && scope?.closer && b.closers.length === 0 && (
        <div className="rounded-lg border border-[#fcd9a8] bg-[#fff7ec] px-3 py-2 text-sm text-[#9a5b00]">
          {scope.myName
            ? <>No demos found under the name <b>{scope.myName}</b> in the last 90 days.</>
            : <>Your login isn&apos;t linked to a name in the sales sheet yet — ask an admin to set it in Settings.</>}
        </div>
      )}
      {seat === "closer" && <CloserView b={b} who={who} win={win} />}
      {seat === "team" && <TeamTable b={b} win={win} />}
    </div>
  );
}
