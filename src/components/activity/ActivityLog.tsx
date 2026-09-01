"use client";
import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { userColor } from "@/lib/utils";
import { Loader2, Plus, Trash2, CalendarClock, Pin, PinOff, Pencil, Check, X, ClipboardList } from "lucide-react";

interface Entry {
  id: string;
  client_key: string;
  action_date: string; // YYYY-MM-DD
  note: string;
  created_at: string;
  created_by_email: string | null;
  pinned: boolean;
}

// "nicolas@pmu-bookings.com" → "Nicolas", shown in the user's dashboard color.
function AuthorChip({ email }: { email: string | null }) {
  if (!email) return null;
  const name = email.split("@")[0];
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  const c = userColor(label);
  return (
    <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap"
      style={c ? { background: c.bg, color: c.text, borderColor: c.border } : { background: "#f1f5f9", color: "#64748b", borderColor: "#d7e0ea" }}
      title={`Added by ${email}`}>
      {label}
    </span>
  );
}

// Local YYYY-MM-DD for the date input default (avoids UTC off-by-one).
function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function prettyDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y) return iso;
  return new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Per-client change/activity log. Keyed by `clientKey` so the same client's
// history shows up in every tab that renders it (Performance, Cost/Deposit…).
// Routine payment-status notes ("payment failed", "all good") are data for the
// Performance tab, not the Cost/Deposit analysis — hideRoutine filters them.
//
// Entries come in two kinds: dated timeline rows (default) and PINNED notes —
// standing facts about the client ("prefers WhatsApp", "on vacation till Oct")
// that stay stuck at the top of the box instead of scrolling away with time.
// Any row can be pinned/unpinned; pinned notes are editable in place and are
// excluded from the Cost/Deposit timeline pins (they're not dated actions).
const ROUTINE_NOTE = /payment\s*failed|all\s*good/i;

export function ActivityLog({ clientKey, clientLabel, hideRoutine }: { clientKey: string; clientLabel?: string; hideRoutine?: boolean }) {
  const [supabase] = useState(() => createClient());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [addPinned, setAddPinned] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskMsg, setTaskMsg] = useState<string | null>(null);

  // "Task" instead of "Add": the typed line becomes a GHL task for the person
  // clicking (self-assigned, shows on their Tasks tab and in the tasks box).
  async function addTask() {
    if (!note.trim() || taskSaving || !clientLabel) return;
    setTaskSaving(true);
    setTaskMsg(null);
    try {
      const r = await fetch("/api/ghl/client-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: clientLabel, title: note.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Task creation failed");
      setNote("");
      setTaskMsg("✓ Task added");
      window.dispatchEvent(new CustomEvent("client-tasks-changed", { detail: clientLabel }));
      setTimeout(() => setTaskMsg(null), 4000);
    } catch (e) {
      setTaskMsg(e instanceof Error ? e.message : "Task creation failed");
    } finally {
      setTaskSaving(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("client_activity")
      .select("*")
      .eq("client_key", clientKey)
      .order("action_date", { ascending: false })
      .order("created_at", { ascending: false });
    setEntries((data as Entry[]) ?? []);
    setLoading(false);
  }, [supabase, clientKey]);

  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim() || saving) return;
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("client_activity").insert({
      client_key: clientKey,
      client_label: clientLabel ?? null,
      action_date: date,
      note: note.trim(),
      pinned: addPinned,
      created_by: user?.id ?? null,
      created_by_email: user?.email ?? null,
    });
    setSaving(false);
    if (!error) { setNote(""); setDate(todayISO()); setAddPinned(false); load(); }
  }

  async function remove(id: string) {
    await supabase.from("client_activity").delete().eq("id", id);
    setEntries((e) => e.filter((x) => x.id !== id));
  }

  async function setPinned(id: string, pinned: boolean) {
    setEntries((e) => e.map((x) => (x.id === id ? { ...x, pinned } : x)));
    const { error } = await supabase.from("client_activity").update({ pinned }).eq("id", id);
    if (error) load();
  }

  async function saveEdit(id: string) {
    const text = editText.trim();
    if (!text) return;
    setEntries((e) => e.map((x) => (x.id === id ? { ...x, note: text } : x)));
    setEditingId(null);
    const { error } = await supabase.from("client_activity").update({ note: text }).eq("id", id);
    if (error) load();
  }

  const pinnedNotes = entries.filter((en) => en.pinned);
  const timeline = entries.filter((en) => !en.pinned && (!hideRoutine || !ROUTINE_NOTE.test(en.note)));

  return (
    <div className="rounded-xl border border-[#e4ebf2] bg-white p-4 space-y-3 shadow-sm">
      <div className="flex items-center gap-2 text-[#1f3559]">
        <CalendarClock size={15} className="text-[#0e8f88]" />
        <h3 className="text-sm font-semibold">Activity &amp; Changes Log</h3>
        {clientLabel && <span className="text-xs text-[#697a91]">· {clientLabel}</span>}
      </div>

      {/* Pinned notes — standing client facts, always stuck at the top. */}
      {pinnedNotes.length > 0 && (
        <div className="space-y-1.5">
          {pinnedNotes.map((en) => (
            <div key={en.id} className="flex items-start gap-2 rounded-lg border border-[#f5dfa0] bg-[#fffbeb] px-3 py-2">
              <Pin size={13} className="mt-1 shrink-0 text-[#b45309]" />
              {editingId === en.id ? (
                <>
                  <input
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveEdit(en.id); if (e.key === "Escape") setEditingId(null); }}
                    className="flex-1 px-2 py-1 bg-white border border-[#f5dfa0] rounded-md text-sm text-[#1f3559] focus:outline-none focus:border-[#b45309]"
                  />
                  <button onClick={() => saveEdit(en.id)} title="Save note"
                    className="shrink-0 mt-0.5 text-[#15803d] hover:text-[#166534]"><Check size={15} /></button>
                  <button onClick={() => setEditingId(null)} title="Cancel"
                    className="shrink-0 mt-0.5 text-[#b6c0cd] hover:text-[#697a91]"><X size={15} /></button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm text-[#713f12] whitespace-pre-wrap break-words">{en.note}</span>
                  <AuthorChip email={en.created_by_email} />
                  <button onClick={() => { setEditingId(en.id); setEditText(en.note); }} title="Edit note"
                    className="shrink-0 mt-0.5 text-[#b6c0cd] hover:text-[#0e8f88] transition-colors"><Pencil size={13} /></button>
                  <button onClick={() => setPinned(en.id, false)} title="Unpin — move back into the dated log"
                    className="shrink-0 mt-0.5 text-[#b6c0cd] hover:text-[#b45309] transition-colors"><PinOff size={13} /></button>
                  <button onClick={() => remove(en.id)} title="Delete note"
                    className="shrink-0 mt-0.5 text-[#b6c0cd] hover:text-[#e11d48] transition-colors"><Trash2 size={13} /></button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-[10px] font-medium uppercase tracking-wide text-[#8595a8] mb-1">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="px-2.5 py-1.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <div className="flex-1 min-w-[220px]">
          <label className="block text-[10px] font-medium uppercase tracking-wide text-[#8595a8] mb-1">What changed / action taken</label>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={addPinned ? "e.g. Prefers WhatsApp · husband handles billing" : "e.g. Raised daily budget to $40, paused Campaign B"}
            className="w-full px-3 py-1.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <button type="button" onClick={() => setAddPinned((p) => !p)}
          title={addPinned ? "Will be pinned to the top — click to add as a normal dated entry" : "Pin to top — a standing note that never scrolls away"}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm font-medium border transition-all ${
            addPinned ? "bg-[#fffbeb] text-[#b45309] border-[#f5dfa0]" : "bg-[#eef2f7] text-[#697a91] border-[#d7e0ea] hover:text-[#b45309]"
          }`}>
          <Pin size={13} /> {addPinned ? "Pinned" : "Pin"}
        </button>
        <button type="submit" disabled={saving || !note.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-[#1f3559] transition-all disabled:opacity-50"
          style={{ background: "#15B7AE" }}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add
        </button>
        {clientLabel && (
          <button type="button" onClick={addTask} disabled={taskSaving || !note.trim()}
            title="Turn this line into a task for yourself — it lands on your Tasks tab and in the tasks box"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border bg-[#eef2f7] text-[#34568a] border-[#d7e0ea] hover:border-[#15B7AE] hover:text-[#0e8f88] transition-all disabled:opacity-50">
            {taskSaving ? <Loader2 size={14} className="animate-spin" /> : <ClipboardList size={14} />}
            Task
          </button>
        )}
      </form>
      {taskMsg && (
        <p className={`text-[11px] ${taskMsg.startsWith("✓") ? "text-[#15803d]" : "text-[#e11d48]"}`}>{taskMsg}</p>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-[#697a91] py-3"><Loader2 size={13} className="animate-spin" />Loading…</div>
      ) : entries.length === 0 ? (
        <p className="text-xs text-[#8595a8] py-2">No changes logged yet. Add the first one above.</p>
      ) : timeline.length === 0 ? null : (
        <ul className="divide-y divide-[#eef3f8] border border-[#eef3f8] rounded-lg overflow-hidden">
          {timeline.map((en) => (
            <li key={en.id} className="flex items-start gap-3 px-3 py-2 hover:bg-[#fafcfe]">
              <span className="mt-0.5 shrink-0 inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-[#e6f7f5] text-[#0e8f88] border border-[#a7e3df] whitespace-nowrap">
                {prettyDate(en.action_date)}
              </span>
              <span className="flex-1 text-sm text-[#1f3559] whitespace-pre-wrap break-words">{en.note}</span>
              <AuthorChip email={en.created_by_email} />
              <button onClick={() => setPinned(en.id, true)} title="Pin to top — keep this visible as a standing note"
                className="shrink-0 text-[#b6c0cd] hover:text-[#b45309] transition-colors">
                <Pin size={14} />
              </button>
              <button onClick={() => remove(en.id)} title="Delete entry"
                className="shrink-0 text-[#b6c0cd] hover:text-[#e11d48] transition-colors">
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
