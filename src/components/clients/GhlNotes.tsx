"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, MessageSquare } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { GhlNote } from "@/lib/types";

interface GhlNotesProps {
  contactId: string;
}

// GHL note bodies arrive as HTML (e.g. <p style="...">). Strip tags/entities
// so notes read clean and simple.
function cleanNote(raw: string): string {
  return String(raw ?? "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    <div className="border border-[#e4ebf2] rounded-lg overflow-hidden">
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-[#f1f5f9] transition-colors"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-[#1e2a3a]">
          <MessageSquare size={14} className="text-[#0e8f88]" />
          Notes from GoHighLevel
        </div>
        <span className="text-[#697a91]">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>

      {open && (
        <div className="bg-[#eef2f7] px-4 py-3 space-y-3">
          {loading && (
            <div className="flex items-center gap-2 text-[#697a91] text-sm py-4">
              <Loader2 size={14} className="animate-spin" />
              Fetching notes from GHL…
            </div>
          )}
          {error && (
            <p className="text-xs text-[#e11d48] py-2">{error}</p>
          )}
          {!loading && !error && notes.length === 0 && (
            <p className="text-sm text-[#8595a8] py-3">No notes found for this contact.</p>
          )}
          {notes.map((note) => (
            <div
              key={note.id}
              className="border border-[#e4ebf2] rounded-lg p-3 bg-white"
            >
              <p className="text-xs text-[#697a91] mb-1.5">
                {formatDate(note.dateAdded)}
              </p>
              <p className="text-sm text-[#1e2a3a] whitespace-pre-line leading-relaxed">
                {cleanNote(note.body)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
