"use client";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useUser } from "@/lib/hooks/useUser";
import { cn } from "@/lib/utils";
import type { Tracker, TrackerPerson, TrackerStatus, DemoPerson } from "@/lib/winback-tracker";

/* 🔁 Win-back tracker (owner, 11/06/2026): one place to see the whole
   reactivation effort — who we texted, who answered, who came back, who is
   still getting follow-ups, when the next one goes out and what it says, plus
   the people who had a demo (closed / didn't close). Click a person to read
   the latest messages. Tick people to put them in the next blast: ticking only
   marks them, nothing is sent from this page. */

type Data = Tracker & { followupTexts: { price: string; spots: string } };
type Msg = { id: string; fromHer: boolean; body: string; at: string | null; channel: string };

const STATUS: Record<TrackerStatus, { label: string; hint: string; cls: string }> = {
  joined: { label: "🎉 Came back", hint: "clients again", cls: "bg-[#ecfdf5] text-[#047857] border-[#a7f3d0]" },
  interested: { label: "💬 Answered, still open", hint: "interested, not closed yet", cls: "bg-[#fff7e6] text-[#b45309] border-[#fcd34d]" },
  said_no: { label: "🚫 Said no", hint: "not interested / asked to stop", cls: "bg-[#fef2f2] text-[#b91c1c] border-[#fecaca]" },
  following: { label: "⏳ On follow-up", hint: "no answer yet, more messages coming", cls: "bg-[#eef6ff] text-[#1d4ed8] border-[#bfdbfe]" },
  no_answer: { label: "😶 No answer", hint: "all 4 messages sent", cls: "bg-[#f1f5f9] text-[#475569] border-[#cbd5e1]" },
  scheduled: { label: "🗓️ Scheduled", hint: "approved, first text has a date", cls: "bg-[#f5f3ff] text-[#6d28d9] border-[#ddd6fe]" },
  picked: { label: "✅ Picked for next blast", hint: "you ticked them, no date yet", cls: "bg-[#ecfeff] text-[#0e7490] border-[#a5f3fc]" },
  not_yet: { label: "🕓 Not texted yet", hint: "can be texted, no date yet", cls: "bg-[#effaf9] text-[#0e8f88] border-[#a7e3df]" },
  held: { label: "✋ On hold", hint: "old chat ended tense / badly, or can't be texted", cls: "bg-[#fafafa] text-[#525252] border-[#e5e5e5]" },
  removed: { label: "✖️ Off the list", hint: "you removed them, or current clients", cls: "bg-[#fafafa] text-[#737373] border-[#e5e5e5]" },
};
const ORDER: TrackerStatus[] = ["joined", "interested", "following", "scheduled", "picked", "said_no", "no_answer", "not_yet", "held", "removed"];

// Month-first dates on the owner's clock (Pacific).
const TZ = "America/Los_Angeles";
const mdy = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: TZ }) : "—");
const mdyTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", timeZone: TZ }) : "—");
const demoDay = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "UTC" }) : "—");

function Card({ label, value, hint, active, onClick, cls }: { label: string; value: number; hint?: string; active?: boolean; onClick?: () => void; cls?: string }) {
  return (
    <button onClick={onClick} disabled={!onClick}
      className={cn("text-left rounded-xl border px-3 py-2 min-w-[8.5rem] transition", cls ?? "bg-white border-[#e4ebf2] text-[#1f3559]", active && "ring-2 ring-[#15B7AE]", onClick && "hover:brightness-95")}>
      <div className="text-xl font-bold leading-tight">{value}</div>
      <div className="text-xs font-semibold">{label}</div>
      {hint && <div className="text-[10px] opacity-80">{hint}</div>}
    </button>
  );
}

function Tick({ on, busy, disabled, onChange, title }: { on: boolean; busy: boolean; disabled?: boolean; onChange: (v: boolean) => void; title: string }) {
  if (busy) return <Loader2 className="w-3.5 h-3.5 animate-spin text-[#15B7AE]" />;
  return <input type="checkbox" checked={on} disabled={disabled} title={title} onClick={(e) => e.stopPropagation()} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 accent-[#15B7AE] cursor-pointer disabled:cursor-not-allowed disabled:opacity-40" />;
}

function nextCell(p: TrackerPerson, texts: Data["followupTexts"]) {
  if (p.nextAt) {
    return (
      <div>
        <div className="font-semibold text-[#1f3559]">{mdyTime(p.nextAt)}</div>
        <div className="text-[#4a5a6e]">{p.nextLabel}</div>
        {p.nextText && <div className="mt-0.5 text-[#697a91] italic">“{p.nextText}”</div>}
      </div>
    );
  }
  if (p.status === "interested") {
    if (p.followupAt) {
      const t = (p.followupKind === "price" ? texts.price : texts.spots).replace("{first}", p.name.split(" ")[0]).replace("{until}", p.followupUntil ?? "");
      return (
        <div>
          <div className="text-[#4a5a6e]">Follow-up sent {mdy(p.followupAt)} · {p.followupKind === "price" ? `$60 rate held until ${p.followupUntil ?? "?"}` : "limited spots + call link"}</div>
          <div className="mt-0.5 text-[#697a91] italic">“{t}”</div>
          <div className="mt-0.5 text-[#8595a8]">Nothing automatic next. A person answers her.</div>
        </div>
      );
    }
    return <div className="text-[#8595a8]">Nothing automatic. Use 💬 Follow up in the AI tab, or answer her by hand.</div>;
  }
  if (p.status === "picked") return <div className="text-[#0e7490]">In the next blast. No date yet.{p.note ? ` ${p.note}` : ""}</div>;
  if (p.status === "held" || p.status === "not_yet") {
    return (
      <div className="text-[#8595a8]">
        {p.note && <div className="text-[#4a5a6e]">{p.note}</div>}
        {p.reviewNote && <div className="italic">{p.reviewNote}</div>}
        {!p.note && !p.reviewNote && "—"}
      </div>
    );
  }
  if (p.note) return <div className="text-[#8595a8]">{p.note}</div>;
  return <div className="text-[#8595a8]">—</div>;
}

/* The latest messages with one person, loaded when her row is opened. */
function Thread({ contactId }: { contactId: string }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    fetch(`/api/winback/tracker/thread?contactId=${encodeURIComponent(contactId)}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? "Couldn't load"); return j; })
      .then((j) => { if (!off) { setMsgs(j.messages ?? []); setTotal(j.total ?? 0); } })
      .catch((e) => { if (!off) setError(e instanceof Error ? e.message : "Couldn't load"); });
    return () => { off = true; };
  }, [contactId]);
  if (error) return <div className="text-xs text-[#b91c1c]">{error}</div>;
  if (!msgs) return <div className="flex items-center gap-2 text-xs text-[#697a91]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading her messages…</div>;
  if (!msgs.length) return <div className="text-xs text-[#8595a8]">No messages with her yet.</div>;
  return (
    <div className="space-y-1.5 max-w-3xl">
      {total > msgs.length && <div className="text-[10px] text-[#8595a8]">Latest {msgs.length} of {total} messages</div>}
      {msgs.map((m) => (
        <div key={m.id} className={cn("flex", m.fromHer ? "justify-start" : "justify-end")}>
          <div className={cn("rounded-xl px-2.5 py-1.5 text-xs max-w-[85%] whitespace-pre-wrap", m.fromHer ? "bg-white border border-[#e4ebf2] text-[#1c2b3a]" : "bg-[#e6f7f6] text-[#0f3d3a]")}>
            <div className="text-[10px] font-semibold opacity-70 mb-0.5">{m.fromHer ? "She wrote" : "We sent"} · {m.channel} · {mdyTime(m.at)}</div>
            {m.body}
          </div>
        </div>
      ))}
    </div>
  );
}

function PeopleTable({ rows, texts, busy, onPick }: { rows: TrackerPerson[]; texts: Data["followupTexts"]; busy: Set<string>; onPick: (keys: string[], picked: boolean) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!rows.length) return <p className="text-sm text-[#697a91] px-3 py-4">Nobody here.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[#8595a8] border-b border-[#eef3f8]">
            <th className="pl-3 py-2 font-semibold w-6" title="Tick to put her in the next blast">Pick</th>
            <th className="px-3 py-2 font-semibold">Client</th>
            <th className="px-3 py-2 font-semibold">Where she stands</th>
            <th className="px-3 py-2 font-semibold whitespace-nowrap">First text</th>
            <th className="px-3 py-2 font-semibold whitespace-nowrap">Sent</th>
            <th className="px-3 py-2 font-semibold whitespace-nowrap">She answered</th>
            <th className="px-3 py-2 font-semibold">Next follow-up and what she gets</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <Fragment key={p.sheetRow}>
              <tr onClick={() => setOpen(open === p.sheetRow ? null : p.sheetRow)} className={cn("border-b border-[#f3f6fa] align-top cursor-pointer hover:bg-[#f8fbfd]", open === p.sheetRow && "bg-[#f8fbfd]")}>
                <td className="pl-3 py-2">
                  {(p.canPick || p.status === "picked") && (
                    <Tick on={p.status === "picked"} busy={busy.has(`f${p.sheetRow}`)} onChange={(v) => onPick([String(p.sheetRow)], v)} title={p.status === "picked" ? "Take her out of the next blast" : "Put her in the next blast"} />
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="font-semibold text-[#1c2b3a]">{open === p.sheetRow ? "▾" : "▸"} {p.name}</div>
                  <div className="text-[#8595a8]">{p.business ?? ""}{p.lastPaid ? ` · left ${p.lastPaid}` : ""}</div>
                </td>
                <td className="px-3 py-2"><span className={cn("inline-block rounded-full border px-1.5 py-px text-[10px] font-semibold whitespace-nowrap", STATUS[p.status].cls)}>{STATUS[p.status].label}</span></td>
                <td className="px-3 py-2 whitespace-nowrap text-[#4a5a6e]">{p.textedAt ? `${mdy(p.textedAt)} · batch ${p.batchNo}` : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap text-[#4a5a6e]">{p.batchNo ? `${p.messagesSent} of 4` : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap text-[#4a5a6e]">{mdy(p.repliedAt)}</td>
                <td className="px-3 py-2 min-w-[18rem] max-w-[30rem]">{nextCell(p, texts)}</td>
              </tr>
              {open === p.sheetRow && (
                <tr className="border-b border-[#eef3f8] bg-[#f8fbfd]">
                  <td colSpan={7} className="px-4 py-3">
                    {p.contactId ? <Thread contactId={p.contactId} /> : <div className="text-xs text-[#8595a8]">She was not found in GHL, so there are no messages to show.</div>}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DemoTable({ rows, busy, onPick }: { rows: DemoPerson[]; busy: Set<string>; onPick: (keys: string[], picked: boolean) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 100);
  if (!rows.length) return <p className="text-sm text-[#697a91] px-3 py-4">Nobody here.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[#8595a8] border-b border-[#eef3f8]">
            <th className="pl-3 py-2 font-semibold w-6" title="Tick to put her in the next blast">Pick</th>
            <th className="px-3 py-2 font-semibold">Name</th>
            <th className="px-3 py-2 font-semibold">Demo result</th>
            <th className="px-3 py-2 font-semibold whitespace-nowrap">Signed up</th>
            <th className="px-3 py-2 font-semibold">Closer</th>
            <th className="px-3 py-2 font-semibold">Reach-out</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((d) => (
            <tr key={d.key} className="border-b border-[#f3f6fa]">
              <td className="pl-3 py-1.5">
                {d.status !== "closed" && !d.alsoFormerClient && (
                  <Tick on={d.picked} busy={busy.has(`d${d.key}`)} onChange={(v) => onPick([d.key], v)} title={d.picked ? "Take her out of the next blast" : "Put her in the next blast"} />
                )}
              </td>
              <td className="px-3 py-1.5 font-semibold text-[#1c2b3a]">{d.name}</td>
              <td className="px-3 py-1.5 text-[#4a5a6e]">{d.status === "closed" ? "✅ Closed" : d.status === "no_money" ? "💸 Didn't close (no money)" : "🫠 Didn't close"}</td>
              <td className="px-3 py-1.5 whitespace-nowrap text-[#4a5a6e]">{demoDay(d.demoDate)}</td>
              <td className="px-3 py-1.5 text-[#4a5a6e]">{d.closer ?? "—"}</td>
              <td className={cn("px-3 py-1.5", d.picked ? "text-[#0e7490] font-semibold" : "text-[#8595a8]")}>{d.status === "closed" ? "—" : d.alsoFormerClient ? "In the former-client list" : d.picked ? "✅ Picked for next blast" : "Not contacted yet"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <button onClick={() => setAll(true)} className="m-3 text-xs font-semibold text-[#0e8f88] hover:underline">Show all {rows.length}</button>
      )}
    </div>
  );
}

export default function WinbackTrackerPage() {
  const { role, loading: roleLoading } = useUser();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const [group, setGroup] = useState<"former" | "demo">("former");
  const [filter, setFilter] = useState<TrackerStatus | "texted" | "all">("texted");
  const [demoView, setDemoView] = useState<"open" | "no_money" | "picked" | "closed">("open");
  const [year, setYear] = useState<number | "all">("all");
  const [q, setQ] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/winback/tracker");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Couldn't load");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (role === "admin") load(); }, [role, load]);

  // Tick / untick: saved right away, then the page reloads its numbers.
  const pick = useCallback(async (grp: "former" | "demo", keys: string[], picked: boolean) => {
    const tags = keys.map((k) => `${grp === "former" ? "f" : "d"}${k}`);
    setBusy((b) => new Set([...b, ...tags]));
    if (keys.length > 1) setBulk(true);
    setError(null);
    try {
      const r = await fetch("/api/winback/tracker/pick", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: grp, keys, picked }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Couldn't save");
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy((b) => { const n = new Set(b); tags.forEach((t) => n.delete(t)); return n; });
      setBulk(false);
    }
  }, [load]);

  const needle = q.trim().toLowerCase();
  const people = useMemo(() => {
    const rows = (data?.people ?? []).filter((p) => (filter === "all" ? true : filter === "texted" ? !!p.batchNo : p.status === filter));
    const found = needle ? rows.filter((p) => `${p.name} ${p.business ?? ""}`.toLowerCase().includes(needle)) : rows;
    return [...found].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (a.nextAt ?? "9").localeCompare(b.nextAt ?? "9") || a.sheetRow - b.sheetRow);
  }, [data, filter, needle]);

  const demoYears = useMemo(() => [...new Set((data?.demos.open ?? []).map((d) => d.year).filter((y): y is number => !!y))].sort((a, b) => b - a), [data]);
  const demos = useMemo(() => {
    const open = data?.demos.open ?? [];
    const base = demoView === "closed" ? data?.demos.closed ?? [] : demoView === "picked" ? open.filter((d) => d.picked) : demoView === "no_money" ? open.filter((d) => d.status === "no_money") : open;
    return base.filter((d) => (year === "all" || d.year === year) && (!needle || d.name.toLowerCase().includes(needle)));
  }, [data, demoView, year, needle]);
  const demoPicked = useMemo(() => (data?.demos.open ?? []).filter((d) => d.picked).length, [data]);

  // The next dates something goes out, soonest first.
  const upcoming = useMemo(() => {
    const m = new Map<string, { at: string; label: string; n: number }>();
    for (const p of data?.people ?? []) {
      if (!p.nextAt || !p.nextLabel) continue;
      const key = `${mdy(p.nextAt)}|${p.nextLabel}`;
      const cur = m.get(key);
      if (cur) cur.n++; else m.set(key, { at: p.nextAt, label: p.nextLabel, n: 1 });
    }
    return [...m.values()].sort((a, b) => a.at.localeCompare(b.at));
  }, [data]);

  if (roleLoading) return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-[#15B7AE]" /></div>;
  if (role !== "admin") return <div className="p-8 text-sm text-[#697a91]">Admins only.</div>;

  const c = data?.counts;
  const tab = (id: "former" | "demo", label: string) => (
    <button onClick={() => setGroup(id)} className={cn("px-3 py-1.5 rounded-lg text-sm font-semibold border", group === id ? "bg-[#1f3559] text-white border-[#1f3559]" : "bg-white text-[#1f3559] border-[#e4ebf2] hover:bg-[#f6f9fc]")}>{label}</button>
  );
  const pill = <T extends string | number>(val: T, cur: T, set: (v: T) => void, label: string) => (
    <button key={String(val)} onClick={() => set(val)} className={cn("px-2 py-1 rounded-full text-xs font-semibold border", cur === val ? "bg-[#effaf9] text-[#0e8f88] border-[#a7e3df]" : "bg-white text-[#4a5a6e] border-[#e4ebf2]")}>{label}</button>
  );
  const bulkBtn = (label: string, onClick: () => void, show: boolean) => show && (
    <button onClick={onClick} disabled={bulk} className="inline-flex items-center gap-1.5 rounded-lg border border-[#a5f3fc] bg-[#ecfeff] px-2.5 py-1 text-xs font-semibold text-[#0e7490] hover:brightness-95 disabled:opacity-60">
      {bulk && <Loader2 className="w-3 h-3 animate-spin" />}{bulk ? "Saving…" : label}
    </button>
  );
  const pickableDemos = demos.filter((d) => d.status !== "closed" && !d.alsoFormerClient);
  const pickablePeople = people.filter((p) => p.canPick || p.status === "picked");

  return (
    <div className="p-3 md:p-4 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h1 className="text-lg font-bold text-[#1f3559]">🔁 Win-back tracker</h1>
        <span className="text-xs text-[#8595a8]">everyone we reached out to, where each one stands, and what goes out next</span>
        <button onClick={() => load()} disabled={loading} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[#e4ebf2] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1f3559] hover:bg-[#f6f9fc] disabled:opacity-60">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {error && <div className="mb-3 text-sm bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c] rounded-lg px-3 py-2">{error}</div>}
      {!data || !c ? (
        <div className="flex justify-center py-10"><Loader2 className="animate-spin text-[#15B7AE]" /></div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-3">
            {tab("former", `Former clients (${data.people.length})`)}
            {tab("demo", `Had a demo (${data.demos.open.length + data.demos.closed.length})`)}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name…" className="ml-auto rounded-lg border border-[#e4ebf2] px-2.5 py-1.5 text-sm w-48" />
          </div>

          {group === "former" ? (
            <>
              <div className="flex flex-wrap gap-2 mb-2">
                <Card label="📤 Texted so far" value={c.texted} hint={`${c.answered} answered`} active={filter === "texted"} onClick={() => setFilter("texted")} />
                {ORDER.map((s) => (
                  <Card key={s} label={STATUS[s].label} value={c[s]} hint={STATUS[s].hint} cls={STATUS[s].cls} active={filter === s} onClick={() => setFilter(s)} />
                ))}
                <Card label="Everyone" value={data.people.length} active={filter === "all"} onClick={() => setFilter("all")} />
              </div>

              {upcoming.length > 0 && (
                <div className="mb-3 rounded-xl border border-[#e4ebf2] bg-white px-3 py-2">
                  <div className="text-xs font-semibold text-[#1f3559] mb-1">What goes out next</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#4a5a6e]">
                    {upcoming.map((u) => <span key={`${u.at}${u.label}`}><b className="text-[#1f3559]">{mdy(u.at)}</b> · {u.label} · {u.n} {u.n === 1 ? "person" : "people"}</span>)}
                  </div>
                </div>
              )}

              <div className="border border-[#e4ebf2] rounded-xl bg-white">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-[#8595a8] border-b border-[#eef3f8]">
                  <span>{people.length} {people.length === 1 ? "person" : "people"} · click a person to read the latest messages · a tick puts her in the next blast (nothing is sent from here)</span>
                  <span className="ml-auto flex gap-2">
                    {bulkBtn(`Pick all ${pickablePeople.filter((p) => p.status !== "picked").length} shown`, () => pick("former", pickablePeople.filter((p) => p.status !== "picked").map((p) => String(p.sheetRow)), true), pickablePeople.some((p) => p.status !== "picked"))}
                    {bulkBtn("Untick all shown", () => pick("former", pickablePeople.filter((p) => p.status === "picked").map((p) => String(p.sheetRow)), false), pickablePeople.some((p) => p.status === "picked"))}
                  </span>
                </div>
                <PeopleTable rows={people} texts={data.followupTexts} busy={busy} onPick={(k, v) => pick("former", k, v)} />
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 mb-2">
                <Card label="🫠 Had a demo, didn't close" value={data.demos.open.length} hint="next group to reach out to" active={demoView === "open"} onClick={() => setDemoView("open")} />
                <Card label="💸 Said no money" value={data.demos.open.filter((d) => d.status === "no_money").length} hint="best fit for pay-per-appointment" active={demoView === "no_money"} onClick={() => setDemoView("no_money")} />
                <Card label="✅ Picked for next blast" value={demoPicked} hint="you ticked them, no date yet" cls={STATUS.picked.cls} active={demoView === "picked"} onClick={() => setDemoView("picked")} />
                <Card label="🎉 Had a demo and closed" value={data.demos.closed.length} active={demoView === "closed"} onClick={() => setDemoView("closed")} />
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {pill<number | "all">("all", year, setYear, "All years")}
                {demoYears.map((y) => pill<number | "all">(y, year, setYear, String(y)))}
              </div>
              <div className="border border-[#e4ebf2] rounded-xl bg-white">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-[#8595a8] border-b border-[#eef3f8]">
                  <span>{demos.length} people · from the sales sheet · a tick puts her in the next blast (nothing is sent from here)</span>
                  <span className="ml-auto flex gap-2">
                    {bulkBtn(`Pick all ${pickableDemos.filter((d) => !d.picked).length} shown`, () => pick("demo", pickableDemos.filter((d) => !d.picked).map((d) => d.key), true), pickableDemos.some((d) => !d.picked))}
                    {bulkBtn("Untick all shown", () => pick("demo", pickableDemos.filter((d) => d.picked).map((d) => d.key), false), pickableDemos.some((d) => d.picked))}
                  </span>
                </div>
                <DemoTable rows={demos} busy={busy} onPick={(k, v) => pick("demo", k, v)} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
