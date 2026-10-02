"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useUser } from "@/lib/hooks/useUser";

/* "My tasks" pop-up for Client Success Coaches (owner, 2026-10-02: "a little
   pop-up on their dashboard, that's how they will see them more in front of
   their eyes"). It reads the same /api/ghl/tasks list as the Tasks tab, which
   the server already narrows to the coach's own tasks.

   When it shows: on the dashboard when the coach has open tasks, once a day —
   and again the moment a task appears that they haven't seen yet. "Got it"
   hides it until tomorrow (or a new task); "Later" hides it for an hour.
   Nothing here changes a task except the ✓ button, which completes it in GHL
   exactly like the Tasks tab does. */

type Task = {
  id: string; title: string; body: string; dueDate: string | null; completed: boolean;
  contactId: string | null; contactName: string;
};
type Seen = { day: string; ids: string[]; snoozeUntil: number };

const REFRESH_MS = 15 * 60_000;
const SNOOZE_MS = 60 * 60_000;
const SHOW_MAX = 6;

const today = () => new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD
const dayOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA") : null);

// In-memory copy for when storage is blocked: "Got it" / "Later" must still
// hold for this tab instead of the pop-up returning on every refresh.
const memSeen = new Map<string, Seen>();
function readSeen(key: string): Seen {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? "null") as Seen | null;
    if (v && typeof v.day === "string" && Array.isArray(v.ids)) return { day: v.day, ids: v.ids, snoozeUntil: Number(v.snoozeUntil) || 0 };
  } catch { /* private window / blocked storage — fall back to memory */ }
  return memSeen.get(key) ?? { day: "", ids: [], snoozeUntil: 0 };
}
function writeSeen(key: string, v: Seen) {
  memSeen.set(key, v);
  try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* memory copy still holds */ }
}

function dueText(iso: string | null): { text: string; tone: "overdue" | "today" | "soon" | "none" } {
  const d = dayOf(iso);
  if (!d) return { text: "no due date", tone: "none" };
  const t = today();
  if (d < t) return { text: `overdue · ${new Date(iso as string).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, tone: "overdue" };
  if (d === t) return { text: "due today", tone: "today" };
  return { text: `due ${new Date(iso as string).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`, tone: "soon" };
}

export function TaskPopup() {
  const { user, role, viewAs, loading } = useUser();
  const pathname = usePathname();
  // Coaches only. An admin previewing as a coach sees it too (the list is
  // everyone's then — the server scopes by the REAL role).
  const enabled = !loading && role === "editor" && !!user;
  const seenKey = `pmu_task_popup:${user?.id ?? ""}`;

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [open, setOpen] = useState(false);
  const [doneBusy, setDoneBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/ghl/tasks");
      if (!r.ok) return;
      const j = (await r.json()) as { tasks?: Task[] };
      const list = (j.tasks ?? []).filter((t) => !t.completed);
      setTasks(list);
      const seen = readSeen(seenKey);
      const fresh = list.some((t) => !seen.ids.includes(t.id));
      if (list.length && Date.now() >= seen.snoozeUntil && (seen.day !== today() || fresh)) setOpen(true);
    } catch { /* try again on the next refresh */ }
  }, [seenKey]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [enabled, load]);

  // Overdue first, then by due date; undated last.
  const sorted = useMemo(() => [...(tasks ?? [])].sort((a, b) => {
    const da = a.dueDate ? Date.parse(a.dueDate) : Infinity;
    const db = b.dueDate ? Date.parse(b.dueDate) : Infinity;
    return da - db;
  }), [tasks]);
  const t0 = today();
  const overdue = sorted.filter((t) => (dayOf(t.dueDate) ?? "9") < t0).length;
  const dueToday = sorted.filter((t) => dayOf(t.dueDate) === t0).length;

  const gotIt = () => {
    writeSeen(seenKey, { day: today(), ids: (tasks ?? []).map((t) => t.id), snoozeUntil: 0 });
    setOpen(false);
  };
  const later = () => {
    const seen = readSeen(seenKey);
    writeSeen(seenKey, { ...seen, snoozeUntil: Date.now() + SNOOZE_MS });
    setOpen(false);
  };
  const complete = async (t: Task) => {
    if (!t.contactId || doneBusy) return;
    setDoneBusy(t.id);
    try {
      const r = await fetch(`/api/ghl/tasks/${t.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: t.contactId, completed: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Couldn't complete the task");
      setTasks((list) => (list ?? []).filter((x) => x.id !== t.id));
      toast.success("Task completed in GHL");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't complete the task");
    } finally { setDoneBusy(null); }
  };

  // Not on the Tasks tab itself — the full list is already on screen there.
  if (!enabled || !open || !sorted.length || pathname?.startsWith("/tasks")) return null;

  return (
    <div role="dialog" aria-label="Your tasks"
      className="fixed z-40 bottom-4 right-4 left-4 sm:left-auto sm:w-[380px] rounded-2xl border border-[#cdeeed] bg-white shadow-xl">
      <div className="flex items-start justify-between gap-2 px-4 pt-3 pb-2 border-b border-[#eef3f8]">
        <div>
          <p className="text-sm font-bold text-[#1f3559]">📋 Your tasks · {sorted.length} open</p>
          <p className="text-[11px] text-[#697a91]">
            {overdue > 0 && <span className="font-semibold text-[#e11d48]">{overdue} overdue</span>}
            {overdue > 0 && dueToday > 0 && " · "}
            {dueToday > 0 && <span className="font-semibold text-[#c2620a]">{dueToday} due today</span>}
            {!overdue && !dueToday && "Nothing overdue — nice."}
            {viewAs && " · preview (everyone's tasks)"}
          </p>
        </div>
        <button onClick={later} title="Remind me in an hour" aria-label="Close" className="p-1 rounded text-[#8595a8] hover:text-[#1f3559]"><X size={15} /></button>
      </div>
      <ul className="max-h-[50vh] overflow-y-auto divide-y divide-[#f1f5f9]">
        {sorted.slice(0, SHOW_MAX).map((t) => {
          const due = dueText(t.dueDate);
          return (
            <li key={t.id} className="flex items-start gap-2 px-4 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[#1f3559] break-words">{t.title || "(no title)"}</p>
                <p className="text-[11px] text-[#697a91] truncate">
                  {t.contactName && <>{t.contactName} · </>}
                  <span className={cn(due.tone === "overdue" && "text-[#e11d48] font-semibold", due.tone === "today" && "text-[#c2620a] font-semibold")}>{due.text}</span>
                </p>
              </div>
              {t.contactId && (
                <button onClick={() => void complete(t)} disabled={!!doneBusy} title="Mark done (in GHL)"
                  className="shrink-0 mt-0.5 w-7 h-7 rounded-full border border-[#bfe3cd] text-[#15803d] hover:bg-[#e7f6ec] flex items-center justify-center disabled:opacity-50">
                  {doneBusy === t.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-[#eef3f8]">
        <Link href="/tasks" onClick={gotIt} className="px-3 py-1.5 rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white text-xs font-semibold">
          {sorted.length > SHOW_MAX ? `See all ${sorted.length}` : "Open Tasks"}
        </Link>
        <button onClick={later} className="px-2 py-1.5 text-xs text-[#34568a] hover:underline">Later</button>
        <button onClick={gotIt} className="ml-auto px-2 py-1.5 text-xs font-semibold text-[#0e8f88] hover:underline">Got it</button>
      </div>
    </div>
  );
}
