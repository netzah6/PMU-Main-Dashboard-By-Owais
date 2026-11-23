"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { useUser } from "@/lib/hooks/useUser";
import { cn } from "@/lib/utils";

/* 🩹 Leaks (owner, 11/23/2026): every place leads slip away before paying,
   with what we changed and what we checked. Was a separate tracker page; now
   here so the nightly check can add new leaks itself. Short rows; the detail
   opens on a click. */

type Status = "new" | "owner" | "progress" | "batch" | "live" | "todo" | "done";
type Leak = {
  id: string; order: number; status: Status; area: string; title: string; short: string;
  problem?: string; change?: string; checked?: string; examples?: string; next?: string; where?: string;
  updated: string; found_by?: string; seen?: string;
};
type Scan = { day: string; at: string; chats: number; read: number; paid: number; errors: number; normal: number; fine: number; known: Record<string, { chats: number; accounts: number }>; other: number; new_leaks: string[] };

const GROUPS: { key: Status; label: string; cls: string; collapsed?: boolean }[] = [
  { key: "new", label: "🆕 New — found by the nightly check", cls: "bg-[#eef6ff] text-[#1d4ed8] border-[#bfdbfe]" },
  { key: "owner", label: "✋ Waiting for your OK", cls: "bg-[#fff7e6] text-[#b45309] border-[#fcd34d]" },
  { key: "progress", label: "🔧 In progress", cls: "bg-[#effaf9] text-[#0e8f88] border-[#a7e3df]" },
  { key: "batch", label: "📦 Ready — in the big batch", cls: "bg-[#f5f3ff] text-[#6d28d9] border-[#ddd6fe]" },
  { key: "live", label: "👀 Live — checking real leads", cls: "bg-[#ecfdf5] text-[#047857] border-[#a7f3d0]" },
  { key: "todo", label: "⏸ Not started", cls: "bg-[#f1f5f9] text-[#475569] border-[#cbd5e1]", collapsed: true },
  { key: "done", label: "✅ Done", cls: "bg-[#f1f5f9] text-[#475569] border-[#cbd5e1]", collapsed: true },
];
const LABEL = Object.fromEntries(GROUPS.map((g) => [g.key, g.label])) as Record<Status, string>;

const PARTS: [keyof Leak, string][] = [
  ["problem", "The problem"], ["change", "What we changed"], ["checked", "How we checked"],
  ["examples", "Real examples"], ["next", "Next"], ["where", "Where it lives"],
];

function Row({ l, busy, onStatus }: { l: Leak; busy: boolean; onStatus: (l: Leak, s: Status) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-[#eef3f8] first:border-t-0">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-[#fafcfd]">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[#1c2b3a]">{l.title}</div>
          <div className="text-xs text-[#4a5a6e] mt-0.5">{l.short}</div>
          {l.seen && !l.seen.includes("not seen") && <div className="text-[11px] text-[#b45309] mt-1">{l.seen}</div>}
          <div className="text-[10px] text-[#8595a8] mt-1">{l.area} · updated {l.updated}{l.found_by ? ` · found by ${l.found_by}` : ""}</div>
        </div>
        <ChevronDown size={14} className={cn("shrink-0 mt-1 text-[#697a91] transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {PARTS.filter(([k]) => l[k]).map(([k, label]) => (
            <div key={k}>
              <div className="text-[11px] font-semibold text-[#697a91]">{label}</div>
              <div className="text-xs text-[#34568a] whitespace-pre-line">{String(l[k])}</div>
            </div>
          ))}
          <label className="flex items-center gap-2 pt-1 text-xs text-[#697a91]">
            Move to
            <select value={l.status} disabled={busy} onChange={(e) => onStatus(l, e.target.value as Status)}
              className="border border-[#e4ebf2] rounded-lg px-2 py-1 text-xs text-[#1c2b3a] bg-white">
              {GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select>
            {busy && <Loader2 size={12} className="animate-spin" />}
          </label>
        </div>
      )}
    </div>
  );
}

function Group({ g, leaks, busy, onStatus }: { g: (typeof GROUPS)[number]; leaks: Leak[]; busy: string | null; onStatus: (l: Leak, s: Status) => void }) {
  const [open, setOpen] = useState(!g.collapsed);
  if (!leaks.length) return null;
  return (
    <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left">
        <span className={cn("rounded-full border px-2 py-px text-xs font-semibold", g.cls)}>{g.label}</span>
        <span className="text-xs text-[#8595a8]">{leaks.length}</span>
        <span className="ml-auto text-xs text-[#697a91]">{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="border-t border-[#eef3f8]">{leaks.map((l) => <Row key={l.id} l={l} busy={busy === l.id} onStatus={onStatus} />)}</div>}
    </div>
  );
}

export default function LeaksPage() {
  const { role, loading: roleLoading } = useUser();
  const [leaks, setLeaks] = useState<Leak[] | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/leaks");
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? "Couldn't load");
    setLeaks(j.leaks ?? []);
    setScan(j.scan ?? null);
  }, []);
  useEffect(() => { if (role === "admin") load().catch((e) => setError(e.message)); }, [role, load]);

  const onStatus = useCallback(async (l: Leak, status: Status) => {
    setBusy(l.id); setError(null);
    try {
      const r = await fetch("/api/leaks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: l.id, status }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }, [load]);

  const byStatus = useMemo(() => {
    const m = new Map<Status, Leak[]>();
    for (const l of leaks ?? []) m.set(LABEL[l.status] ? l.status : "todo", [...(m.get(LABEL[l.status] ? l.status : "todo") ?? []), l]);
    return m;
  }, [leaks]);

  if (roleLoading) return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-[#15B7AE]" /></div>;
  if (role !== "admin") return <div className="p-8 text-sm text-[#697a91]">Admins only.</div>;

  const open = (leaks ?? []).filter((l) => l.status !== "done").length;
  return (
    <div className="p-3 md:p-4 max-w-3xl mx-auto">
      <div className="flex flex-wrap items-baseline gap-2 mb-4">
        <h1 className="text-lg font-bold text-[#1f3559]">🩹 Leaks</h1>
        <span className="text-xs text-[#8595a8]">where leads slip away before paying · {open} open · click a leak for the detail</span>
      </div>
      <div className="mb-4 rounded-xl border border-[#e4ebf2] bg-[#fafcfd] px-3 py-2.5 text-xs text-[#34568a]">
        {scan ? (
          <>
            <span className="font-semibold text-[#1f3559]">🌙 Nightly check, {new Date(`${scan.day}T12:00:00Z`).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", timeZone: "UTC" })}:</span>{" "}
            read {scan.read} chats in your live V3 accounts ({scan.paid} already paid).{" "}
            {Object.values(scan.known).reduce((a, k) => a + k.chats, 0)} matched known leaks · {scan.other} new kind of problem
            {scan.new_leaks.length ? <> · <strong className="text-[#1d4ed8]">{scan.new_leaks.length} new leak{scan.new_leaks.length === 1 ? "" : "s"} added</strong></> : " · no new leak"}.
          </>
        ) : (
          <span>🌙 The nightly check reads every chat in your live V3 accounts each night and adds new leaks here. First results after tonight.</span>
        )}
      </div>
      {error && <div className="mb-3 text-sm bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c] rounded-lg px-3 py-2">{error}</div>}
      {!leaks ? (
        <div className="flex justify-center py-10"><Loader2 className="animate-spin text-[#15B7AE]" /></div>
      ) : leaks.length ? (
        GROUPS.map((g) => <Group key={g.key} g={g} leaks={byStatus.get(g.key) ?? []} busy={busy} onStatus={onStatus} />)
      ) : (
        <p className="text-sm text-[#697a91]">No leaks yet.</p>
      )}
    </div>
  );
}
