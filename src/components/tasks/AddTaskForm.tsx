"use client";
import { useEffect, useState } from "react";
import { Loader2, Check, X } from "lucide-react";
import { toast } from "sonner";

/* One form for both entry points (owner, 10/19/2026): "Add task" on the
   Tasks tab (type the client's name) and "Create this as a task" in the AI
   tab (contact already known, title/details pre-filled from the chat). It
   creates a real GHL task on the contact, so it shows up in GHL and on the
   Tasks tab for whoever it is assigned to. */
export function AddTaskForm({ contactId, contactName, initialTitle = "", initialBody = "", initialAssignee = "", initialDueInDays = 1, aiNote, onRedraft, onDone, onCancel }: {
  contactId?: string | null; contactName?: string;
  initialTitle?: string; initialBody?: string; initialAssignee?: string; initialDueInDays?: number;
  aiNote?: string; onRedraft?: () => void;
  onDone: () => void; onCancel: () => void;
}) {
  const [client, setClient] = useState(contactName ?? "");
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [assignee, setAssignee] = useState(initialAssignee);
  const tomorrow = new Date(Date.now() + Math.max(1, initialDueInDays) * 86400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const [due, setDue] = useState(`${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/ghl/tasks?users=1").then((r) => r.json()).then((j) => setUsers(j.users ?? [])).catch(() => {});
  }, []);
  const submit = async () => {
    if (busy || title.trim().length < 3 || (!contactId && client.trim().length < 3)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/ghl/tasks", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contactId || undefined, client: contactId ? undefined : client, title, body, dueDate: due ? new Date(`${due}T09:00:00`).toISOString() : null, assignedTo: assignee || null }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not create the task");
      toast.success(`Task created in GHL${j.contactName ? ` for ${j.contactName}` : ""}`);
      onDone();
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally { setBusy(false); }
  };
  const inp = "w-full px-2 py-1.5 bg-white border border-[#d7e0ea] rounded text-xs text-[#1f3559] focus:outline-none focus:border-[#15B7AE]";
  return (
    <form className="rounded-lg border border-[#c9dbfb] bg-[#f7faff] p-2.5 space-y-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {contactId
        ? <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-[#34568a]">📋 New task for {contactName}{aiNote ? <span className="font-normal text-[#697a91]"> · {aiNote}</span> : null}</span>
            {onRedraft && <button type="button" onClick={onRedraft} className="text-[11px] text-[#0e8f88] hover:underline">re-read chat</button>}
          </div>
        : <input id="task-client" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Client — owner or business name" autoFocus className={inp} />}
      <input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" autoFocus={!!contactId} className={inp} />
      <textarea id="task-body" value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Details (optional)" className={`${inp} resize-none`} />
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-[11px] text-[#697a91]">Due</label>
        <input id="task-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="px-2 py-1 bg-white border border-[#d7e0ea] rounded text-xs text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
        <label className="text-[11px] text-[#697a91]">Assign to</label>
        <select id="task-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} className="px-2 py-1 bg-white border border-[#d7e0ea] rounded text-xs text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
          <option value="">Unassigned</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="px-2 py-1 rounded-lg text-[11px] font-semibold text-[#8595a8] hover:text-[#e11d48] inline-flex items-center gap-1"><X size={11} /> Cancel</button>
        <button type="submit" disabled={busy || title.trim().length < 3 || (!contactId && client.trim().length < 3)}
          className="px-2.5 py-1 rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white text-[11px] font-bold inline-flex items-center gap-1 disabled:opacity-50">
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Create task
        </button>
      </div>
    </form>
  );
}
