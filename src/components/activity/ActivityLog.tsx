"use client";
import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { userColor } from "@/lib/utils";
import { Loader2, Plus, Trash2, CalendarClock } from "lucide-react";

interface Entry {
  id: string;
  client_key: string;
  action_date: string; // YYYY-MM-DD
  note: string;
  created_at: string;
  created_by_email: string | null;
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
export function ActivityLog({ clientKey, clientLabel }: { clientKey: string; clientLabel?: string }) {
  const [supabase] = useState(() => createClient());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

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
      created_by: user?.id ?? null,
      created_by_email: user?.email ?? null,
    });
    setSaving(false);
    if (!error) { setNote(""); setDate(todayISO()); load(); }
  }

  async function remove(id: string) {
    await supabase.from("client_activity").delete().eq("id", id);
    setEntries((e) => e.filter((x) => x.id !== id));
  }

  return (
    <div className="rounded-xl border border-[#e4ebf2] bg-white p-4 space-y-3 shadow-sm">
      <div className="flex items-center gap-2 text-[#1f3559]">
        <CalendarClock size={15} className="text-[#0e8f88]" />
        <h3 className="text-sm font-semibold">Activity &amp; Changes Log</h3>
        {clientLabel && <span className="text-xs text-[#697a91]">· {clientLabel}</span>}
      </div>

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
            placeholder="e.g. Raised daily budget to $40, paused Campaign B"
            className="w-full px-3 py-1.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <button type="submit" disabled={saving || !note.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-[#1f3559] transition-all disabled:opacity-50"
          style={{ background: "#15B7AE" }}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add
        </button>
      </form>

      {/* List */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-[#697a91] py-3"><Loader2 size={13} className="animate-spin" />Loading…</div>
      ) : entries.length === 0 ? (
        <p className="text-xs text-[#8595a8] py-2">No changes logged yet. Add the first one above.</p>
      ) : (
        <ul className="divide-y divide-[#eef3f8] border border-[#eef3f8] rounded-lg overflow-hidden">
          {entries.map((en) => (
            <li key={en.id} className="flex items-start gap-3 px-3 py-2 hover:bg-[#fafcfe]">
              <span className="mt-0.5 shrink-0 inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-[#e6f7f5] text-[#0e8f88] border border-[#a7e3df] whitespace-nowrap">
                {prettyDate(en.action_date)}
              </span>
              <span className="flex-1 text-sm text-[#1f3559] whitespace-pre-wrap break-words">{en.note}</span>
              <AuthorChip email={en.created_by_email} />
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
