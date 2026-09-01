"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, ListTodo, CheckCircle2, Circle } from "lucide-react";

interface Task {
  id: string;
  title: string;
  body: string;
  dueDate: string | null;
  completed: boolean;
  assignedToName: string;
}

function prettyDue(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// The tasks box next to the Activity & Changes Log: every GHL task on this
// client's contact — open ones on top, completed below. The log's "Task"
// button files new ones here (and onto the Tasks tab); it fires a
// client-tasks-changed event so this box refreshes without a reload.
export function ClientTasks({ clientLabel }: { clientLabel: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [contactId, setContactId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!clientLabel) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/ghl/client-tasks?name=${encodeURIComponent(clientLabel)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load tasks");
      setTasks((j.tasks as Task[]) ?? []);
      setContactId(j.contactId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, [clientLabel]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail === clientLabel) load();
    };
    window.addEventListener("client-tasks-changed", onChanged);
    return () => window.removeEventListener("client-tasks-changed", onChanged);
  }, [clientLabel, load]);

  async function toggle(t: Task) {
    if (!contactId || busy) return;
    setBusy(t.id);
    try {
      const r = await fetch(`/api/ghl/tasks/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, completed: !t.completed }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Update failed");
      setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, completed: !t.completed } : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(null);
    }
  }

  const open = tasks.filter((t) => !t.completed);
  const done = tasks.filter((t) => t.completed);

  return (
    <div className="rounded-xl border border-[#e4ebf2] bg-white p-4 space-y-2 shadow-sm">
      <div className="flex items-center gap-2 text-[#1f3559]">
        <ListTodo size={15} className="text-[#0e8f88]" />
        <h3 className="text-sm font-semibold">Tasks</h3>
        {open.length > 0 && (
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#e6f7f5] text-[#0e8f88] text-[10px] font-bold border border-[#a7e3df]">
            {open.length}
          </span>
        )}
      </div>

      {error && <p className="text-[11px] text-[#e11d48]">{error}</p>}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-[#697a91] py-2"><Loader2 size={13} className="animate-spin" />Loading…</div>
      ) : tasks.length === 0 ? (
        <p className="text-xs text-[#8595a8] py-1">No tasks for this client yet. Type a line in the log and hit “Task”.</p>
      ) : (
        <ul className="space-y-1">
          {open.map((t) => (
            <li key={t.id} className="flex items-start gap-2 rounded-lg border border-[#e4ebf2] bg-[#fafcfe] px-2.5 py-1.5">
              <button onClick={() => toggle(t)} disabled={busy === t.id} title="Mark done" className="mt-0.5 shrink-0 text-[#b6c0cd] hover:text-[#15803d]">
                {busy === t.id ? <Loader2 size={14} className="animate-spin" /> : <Circle size={14} />}
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-[#1f3559] break-words">{t.title}</p>
                <p className="text-[10px] text-[#8595a8]">
                  {prettyDue(t.dueDate) ? `due ${prettyDue(t.dueDate)}` : ""}
                  {t.assignedToName ? `${t.dueDate ? " · " : ""}${t.assignedToName}` : ""}
                </p>
              </div>
            </li>
          ))}
          {done.map((t) => (
            <li key={t.id} className="flex items-start gap-2 rounded-lg px-2.5 py-1 opacity-60">
              <button onClick={() => toggle(t)} disabled={busy === t.id} title="Re-open" className="mt-0.5 shrink-0 text-[#15803d]">
                {busy === t.id ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-[#697a91] line-through break-words">{t.title}</p>
                {t.assignedToName && <p className="text-[10px] text-[#8595a8]">{t.assignedToName}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
