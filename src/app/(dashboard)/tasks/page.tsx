"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, RefreshCw, Check, ChevronDown, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { cn, userColor } from "@/lib/utils";

interface Task {
  id: string;
  title: string;
  body: string;
  dueDate: string | null;
  completed: boolean;
  assignedTo: string | null;
  assignedToName: string;
  contactId: string | null;
  contactName: string;
}
interface UserRow { id: string; name: string }

const UNASSIGNED = "Unassigned";

// Per-user color, consistent with the rest of the dashboard. Unassigned/empty = white.
function teamColorStyle(name: string) {
  const c = name && name !== UNASSIGNED ? userColor(name) : null;
  return c
    ? { background: c.bg, color: c.text, borderColor: c.border }
    : { background: "#ffffff", color: "#34568a", borderColor: "#d7e0ea" };
}

function dateInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
function dueLabel(iso: string | null): { text: string; overdue: boolean } {
  if (!iso) return { text: "No due date", overdue: false };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { text: "—", overdue: false };
  const overdue = d.getTime() < Date.now();
  return { text: d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }), overdue };
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [locationId, setLocationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [userFilter, setUserFilter] = useState("All");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/ghl/tasks");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load tasks");
      setTasks(json.tasks ?? []);
      setUsers(json.users ?? []);
      setLocationId(json.locationId ?? "");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (t: Task, changes: Partial<Task>) => {
    setSavingId(t.id);
    const prev = tasks;
    // optimistic; completing removes it from the open list
    setTasks((list) => changes.completed
      ? list.filter((x) => x.id !== t.id)
      : list.map((x) => (x.id === t.id ? { ...x, ...changes } : x)));
    try {
      const res = await fetch(`/api/ghl/tasks/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: t.contactId,
          title: changes.title ?? t.title,
          body: changes.body ?? t.body,
          dueDate: changes.dueDate !== undefined ? changes.dueDate : t.dueDate,
          completed: changes.completed ?? t.completed,
          assignedTo: changes.assignedTo !== undefined ? changes.assignedTo : t.assignedTo,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Save failed");
      toast.success(changes.completed ? "Task completed in GHL" : "Task updated in GHL");
    } catch (e) {
      setTasks(prev);
      toast.error(`Couldn't update task: ${e}`);
    } finally {
      setSavingId(null);
    }
  }, [tasks]);

  // Mark a task done (or its checkbox) — uses GHL's dedicated complete endpoint.
  const complete = useCallback(async (t: Task) => {
    setSavingId(t.id);
    const prev = tasks;
    // optimistic: completing removes it from the open list
    setTasks((list) => list.filter((x) => x.id !== t.id));
    try {
      const res = await fetch(`/api/ghl/tasks/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: t.contactId, completed: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Save failed");
      toast.success("Task marked done in GHL ✓");
    } catch (e) {
      setTasks(prev);
      toast.error(`Couldn't complete task: ${e}`);
    } finally {
      setSavingId(null);
    }
  }, [tasks]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return tasks.filter((t) => {
      if (userFilter !== "All") {
        const name = t.assignedToName || UNASSIGNED;
        if (name !== userFilter) return false;
      }
      if (q && !`${t.title} ${t.contactName} ${t.assignedToName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tasks, search, userFilter]);

  // group by assignee, sorted by name (Unassigned last)
  const groups = useMemo(() => {
    const m = new Map<string, Task[]>();
    filtered.forEach((t) => {
      const k = t.assignedToName || UNASSIGNED;
      (m.get(k) ?? m.set(k, []).get(k)!).push(t);
    });
    return Array.from(m.entries()).sort((a, b) =>
      a[0] === UNASSIGNED ? 1 : b[0] === UNASSIGNED ? -1 : a[0].localeCompare(b[0]));
  }, [filtered]);

  const userOptions = useMemo(() => {
    const names = new Set(tasks.map((t) => t.assignedToName || UNASSIGNED));
    return ["All", ...Array.from(names).sort((a, b) => (a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b)))];
  }, [tasks]);

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1f3559]">Tasks</h1>
          <p className="text-sm text-[#697a91]">GHL tasks for PMU Bookings On Demand · {tasks.length} open · edits sync to GHL</p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search task, contact or person…"
            className="w-full pl-8 pr-3 py-2 bg-[#eef2f7] border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-[#e4ebf2] bg-white text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
          {userOptions.map((u) => <option key={u} value={u}>{u === "All" ? "All people" : u}</option>)}
        </select>
      </div>

      {error ? (
        <div className="px-4 py-3 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-sm"><strong>Error:</strong> {error}</div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-12 justify-center"><Loader2 size={15} className="animate-spin" /> Loading tasks from GHL…</div>
      ) : groups.length === 0 ? (
        <div className="py-12 text-center text-[#8595a8]">No open tasks.</div>
      ) : (
        <div className="space-y-5">
          {groups.map(([person, list]) => (
            <div key={person}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="inline-flex items-center px-2 py-0.5 rounded-md text-sm font-bold border" style={teamColorStyle(person)}>{person}</span>
                <span className="text-xs text-[#8595a8]">{list.length}</span>
              </div>
              <div className="rounded-xl border border-[#e4ebf2] bg-white divide-y divide-[#eef3f8] overflow-hidden">
                {list.map((t) => {
                  const due = dueLabel(t.dueDate);
                  const saving = savingId === t.id;
                  const isOpen = expanded.has(t.id);
                  return (
                    <div key={t.id} className="px-3 py-2.5">
                      <div className="flex items-center gap-3">
                        <button onClick={() => complete(t)} disabled={saving} title="Mark done — syncs to GHL"
                          className="shrink-0 w-5 h-5 rounded-md border border-[#cbd5e1] hover:border-[#15B7AE] hover:bg-[#e6f7f5] flex items-center justify-center text-transparent hover:text-[#0e8f88]">
                          {saving ? <Loader2 size={12} className="animate-spin text-[#94a3b8]" /> : <Check size={12} />}
                        </button>
                        <input
                          defaultValue={t.title}
                          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.title) save(t, { title: v }); }}
                          className="flex-1 min-w-0 bg-transparent text-sm text-[#1f3559] px-1 py-0.5 rounded hover:bg-[#f1f5f9] focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#15B7AE]" />
                        {t.contactName && <span className="hidden sm:inline text-xs text-[#697a91] truncate max-w-[140px]" title={t.contactName}>{t.contactName}</span>}
                        {t.contactId && locationId && (
                          <a href={`https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${t.contactId}`}
                            target="_blank" rel="noopener noreferrer"
                            title={`Open chat with ${t.contactName || "contact"}`}
                            className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-[#94a3b8] hover:text-[#0e8f88] hover:bg-[#e6f7f5]">
                            <MessageSquare size={14} />
                          </a>
                        )}
                        <input type="date" value={dateInputValue(t.dueDate)}
                          onChange={(e) => save(t, { dueDate: e.target.value ? new Date(e.target.value + "T12:00:00").toISOString() : null })}
                          className={cn("shrink-0 text-xs rounded border px-1.5 py-1 focus:outline-none focus:border-[#15B7AE]",
                            due.overdue ? "border-[#f5c2cf] text-[#e11d48] bg-[#fff5f7]" : "border-[#d7e0ea] text-[#34568a] bg-white")}
                          title={due.overdue ? "Overdue" : due.text} />
                        <select value={t.assignedTo ?? ""} onChange={(e) => save(t, { assignedTo: e.target.value || null, assignedToName: users.find((u) => u.id === e.target.value)?.name ?? "" })}
                          style={teamColorStyle(t.assignedToName)}
                          className="shrink-0 max-w-[130px] text-xs font-semibold rounded border px-1.5 py-1 cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#15B7AE]/30">
                          <option value="">Unassigned</option>
                          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                        <button onClick={() => toggleExpand(t.id)} title={isOpen ? "Hide description" : "Show description"}
                          className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-[#697a91] hover:bg-[#f1f5f9] hover:text-[#0e8f88]">
                          <ChevronDown size={16} className={cn("transition-transform", isOpen && "rotate-180")} />
                        </button>
                      </div>
                      {isOpen && (
                        <div className="mt-2 pl-8 pr-1">
                          <label className="block text-[11px] uppercase tracking-wide text-[#8595a8] mb-1">Description</label>
                          <textarea
                            defaultValue={t.body}
                            placeholder="No description — add one…"
                            rows={3}
                            onBlur={(e) => { const v = e.target.value; if (v !== (t.body ?? "")) save(t, { body: v }); }}
                            className="w-full text-sm text-[#1f3559] bg-white border border-[#d7e0ea] rounded-lg px-2.5 py-2 resize-y focus:outline-none focus:border-[#15B7AE]" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
