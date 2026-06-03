"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, MessageSquare } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { GhlNote } from "@/lib/types";

interface GhlNotesProps {
  contactId: string;
}

export function GhlNotes({ contactId }: GhlNotesProps) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<GhlNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);

  async function handleToggle() {
    if (!open && !fetched) {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/ghl/notes/${contactId}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Failed to fetch notes");
        setNotes(json.notes ?? []);
        setFetched(true);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
    setOpen((o) => !o);
  }

  return (
    <div className="border border-slate-700 rounded-lg overflow-hidden">
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-800 hover:bg-slate-750 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
          <MessageSquare size={14} className="text-teal-400" />
          Notes from GoHighLevel
        </div>
        <span className="text-slate-400">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>

      {open && (
        <div className="bg-slate-900 px-4 py-3 space-y-3">
          {loading && (
            <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
              <Loader2 size={14} className="animate-spin" />
              Fetching notes from GHL…
            </div>
          )}
          {error && (
            <p className="text-xs text-red-400 py-2">{error}</p>
          )}
          {!loading && !error && notes.length === 0 && (
            <p className="text-sm text-slate-500 py-3">No notes found for this contact.</p>
          )}
          {notes.map((note) => (
            <div
              key={note.id}
              className="border border-slate-700 rounded-lg p-3 bg-slate-800/60"
            >
              <p className="text-xs text-slate-400 mb-1.5">
                {formatDate(note.dateAdded)}
              </p>
              <p className="text-sm text-slate-200 whitespace-pre-line leading-relaxed">
                {note.body}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
