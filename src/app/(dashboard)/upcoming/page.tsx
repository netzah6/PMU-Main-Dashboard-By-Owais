"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useUser } from "@/lib/hooks/useUser";
import { cn } from "@/lib/utils";

/* 🗓️ Upcoming (owner, 11/03/2026: "where can I track all the future builds?
   How can I know what you're going to do on which date?"). Every planned
   launch, test readout, scheduled job and open decision, by date. Claude
   keeps the rows (planned_items) current; the owner can tick one done. */

type Item = {
  id: number; due_date: string | null; due_label: string | null; title: string; detail: string | null;
  who: "auto" | "claude" | "claude_ok" | "owner" | "outside"; status: "scheduled" | "planned" | "waiting" | "parked" | "done";
  area: string | null; done_at: string | null;
};

const WHO: Record<Item["who"], { label: string; cls: string }> = {
  auto: { label: "🤖 Runs on its own", cls: "bg-[#eef6ff] text-[#1d4ed8] border-[#bfdbfe]" },
  claude: { label: "🧠 Claude does it", cls: "bg-[#effaf9] text-[#0e8f88] border-[#a7e3df]" },
  claude_ok: { label: "✋ Claude, after your OK", cls: "bg-[#fff7e6] text-[#b45309] border-[#fcd34d]" },
  owner: { label: "👤 You", cls: "bg-[#fdf2f8] text-[#be185d] border-[#fbcfe8]" },
  outside: { label: "⏳ Waiting on others", cls: "bg-[#f1f5f9] text-[#475569] border-[#cbd5e1]" },
};

// Date-only "YYYY-MM-DD" anchored at noon UTC so the day never shifts.
const day = (d: string) => new Date(`${d}T12:00:00Z`);
const mmdd = (d: string) => day(d).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", timeZone: "UTC" });
const wkday = (d: string) => day(d).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD, owner's clock

function Row({ it, busy, onDone, today }: { it: Item; busy: boolean; onDone: (it: Item, done: boolean) => void; today: string }) {
  const overdue = !it.done_at && it.due_date && it.due_date < today;
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 border-t border-[#eef3f8] first:border-t-0">
      <div className={cn("w-16 shrink-0 text-center rounded-lg border px-1 py-1", overdue ? "border-[#fecaca] bg-[#fef2f2]" : "border-[#e4ebf2] bg-[#fafcfd]")}>
        {it.due_date ? (
          <>
            <div className={cn("text-sm font-bold", overdue ? "text-[#b91c1c]" : "text-[#1f3559]")}>{it.due_label || mmdd(it.due_date)}</div>
            <div className="text-[10px] text-[#8595a8]">{overdue ? "overdue" : wkday(it.due_date)}</div>
          </>
        ) : (
          <div className="text-[11px] font-semibold text-[#697a91] py-1">{it.due_label || "no date"}</div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-sm font-semibold text-[#1c2b3a]", it.done_at && "line-through text-[#8595a8]")}>{it.title}</div>
        {it.detail && <div className="text-xs text-[#4a5a6e] mt-0.5">{it.detail}</div>}
        <span className={cn("inline-block mt-1 rounded-full border px-1.5 py-px text-[10px] font-semibold", WHO[it.who]?.cls)}>{WHO[it.who]?.label ?? it.who}</span>
      </div>
      <button
        disabled={busy}
        onClick={() => onDone(it, !it.done_at)}
        title={it.done_at ? "Reopen" : "Mark done"}
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border border-[#e4ebf2] text-[#0e8f88] hover:bg-[#effaf9] disabled:opacity-60">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : it.done_at ? "↺" : "✓"}
      </button>
    </div>
  );
}

function Section({ title, hint, items, collapsed, ...rest }: { title: string; hint?: string; items: Item[]; collapsed?: boolean; busy: number | null; onDone: (it: Item, done: boolean) => void; today: string }) {
  const [open, setOpen] = useState(!collapsed);
  if (!items.length) return null;
  return (
    <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left">
        <span className="text-sm font-semibold text-[#1f3559]">{title}</span>
        <span className="text-xs text-[#8595a8]">{items.length}{hint ? ` · ${hint}` : ""}</span>
        <span className="ml-auto text-xs text-[#697a91]">{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="border-t border-[#eef3f8]">{items.map((it) => <Row key={it.id} it={it} busy={rest.busy === it.id} onDone={rest.onDone} today={rest.today} />)}</div>}
    </div>
  );
}

export default function UpcomingPage() {
  const { role, loading: roleLoading } = useUser();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/upcoming");
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? "Couldn't load");
    setItems(j.items ?? []);
  }, []);
  useEffect(() => { if (role === "admin") load().catch((e) => setError(e.message)); }, [role, load]);

  const onDone = useCallback(async (it: Item, done: boolean) => {
    setBusy(it.id); setError(null);
    try {
      const r = await fetch("/api/upcoming", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: it.id, done }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }, [load]);

  const today = todayIso();
  const groups = useMemo(() => {
    // done_at is the only "done" signal — reopening clears it and the item is back where it was.
    const open = (items ?? []).filter((i) => !i.done_at);
    const weekEnd = new Date(day(today).getTime() + 7 * 86400_000).toISOString().slice(0, 10);
    const dated = open.filter((i) => i.due_date && i.status !== "parked");
    return {
      week: dated.filter((i) => (i.due_date as string) <= weekEnd),
      later: dated.filter((i) => (i.due_date as string) > weekEnd),
      // Undated work that only needs a yes from the owner sits with his own to-dos.
      you: open.filter((i) => !i.due_date && i.status !== "parked" && (i.who === "owner" || i.who === "claude_ok")),
      others: open.filter((i) => !i.due_date && i.status !== "parked" && i.who === "outside"),
      ongoing: open.filter((i) => !i.due_date && i.status !== "parked" && (i.who === "auto" || i.who === "claude")),
      parked: open.filter((i) => i.status === "parked"),
      done: (items ?? []).filter((i) => i.done_at),
    };
  }, [items, today]);

  if (roleLoading) return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-[#15B7AE]" /></div>;
  if (role !== "admin") return <div className="p-8 text-sm text-[#697a91]">Admins only.</div>;

  const common = { busy, onDone, today };
  return (
    <div className="p-3 md:p-4 max-w-3xl mx-auto">
      <div className="flex flex-wrap items-baseline gap-2 mb-4">
        <h1 className="text-lg font-bold text-[#1f3559]">🗓️ Upcoming</h1>
        <span className="text-xs text-[#8595a8]">what happens next, by date · Claude keeps this list current</span>
      </div>
      {error && <div className="mb-3 text-sm bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c] rounded-lg px-3 py-2">{error}</div>}
      {!items ? (
        <div className="flex justify-center py-10"><Loader2 className="animate-spin text-[#15B7AE]" /></div>
      ) : (
        <>
          <Section title="Next 7 days" items={groups.week} {...common} />
          <Section title="Later" items={groups.later} {...common} />
          <Section title="Waiting on you" hint="needs you, or just your OK" items={groups.you} {...common} />
          <Section title="Waiting on others" items={groups.others} {...common} />
          <Section title="Runs on its own / ongoing" items={groups.ongoing} collapsed {...common} />
          <Section title="Ideas on hold" items={groups.parked} collapsed {...common} />
          <Section title="Done (last 30 days)" items={groups.done} collapsed {...common} />
          {!(items.length) && <p className="text-sm text-[#697a91]">Nothing planned yet.</p>}
        </>
      )}
    </div>
  );
}
