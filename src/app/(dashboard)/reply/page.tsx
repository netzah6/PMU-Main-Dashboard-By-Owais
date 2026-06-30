"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, RefreshCw, Sparkles, Copy, Check, ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface ConvSummary {
  id: string;
  contactId: string | null;
  contactName: string;
  lastMessageBody: string;
  lastMessageDirection: string | null;
  lastMessageDate: string | null;
  unreadCount: number;
}
interface ThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  dateAdded: string | null;
}
interface Me { matched: boolean; ghlUserId: string | null; name: string }

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ReplyPage() {
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<ConvSummary | null>(null);
  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const [instructions, setInstructions] = useState("");
  const [draft, setDraft] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/ghl/reply/conversations");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load conversations");
      setConversations(json.conversations ?? []);
      setMe(json.me ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openConversation = useCallback(async (c: ConvSummary) => {
    setSelected(c);
    setThread([]);
    setDraft("");
    setVoiceNote(null);
    setInstructions("");
    setThreadLoading(true);
    try {
      const res = await fetch(`/api/ghl/reply/thread/${c.id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load thread");
      setThread(json.messages ?? []);
    } catch (e) {
      toast.error(`Couldn't load conversation: ${e}`);
    } finally {
      setThreadLoading(false);
    }
  }, []);

  const generate = useCallback(async () => {
    if (!selected) return;
    setDrafting(true);
    setCopied(false);
    try {
      const res = await fetch("/api/ghl/reply/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: selected.id,
          contactName: selected.contactName,
          instructions: instructions.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to generate");
      setDraft(json.draft ?? "");
      const v = json.voice;
      setVoiceNote(
        v?.matched
          ? `Written in ${v.name}'s voice (${v.samplesUsed} past replies used).`
          : `Couldn't match your login to a GHL user — used a neutral voice.`
      );
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally {
      setDrafting(false);
    }
  }, [selected, instructions]);

  const copy = useCallback(async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      toast.success("Response copied — paste it into GHL");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }, [draft]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      `${c.contactName} ${c.lastMessageBody}`.toLowerCase().includes(q)
    );
  }, [conversations, search]);

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1f3559]">Reply</h1>
          <p className="text-sm text-[#697a91]">
            AI-drafted replies for PMU Bookings On Demand
            {me ? <> · writing as <strong className="text-[#34568a]">{me.name}</strong></> : null}
            {" "}· you copy &amp; paste, nothing auto-sends
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {me && !me.matched && (
        <div className="px-4 py-2.5 rounded-lg border border-[#fde68a] bg-[#fffbeb] text-[#92400e] text-xs">
          Your dashboard login email doesn&apos;t match a GHL user on this account, so drafts use a neutral voice.
          To get replies in your own voice, make sure your GHL user email matches your dashboard login.
        </div>
      )}

      {error ? (
        <div className="px-4 py-3 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-sm"><strong>Error:</strong> {error}</div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-12 justify-center"><Loader2 size={15} className="animate-spin" /> Loading conversations from GHL…</div>
      ) : (
        <div className="grid md:grid-cols-[330px_1fr] gap-4">
          {/* Conversation list */}
          <div className={cn("space-y-2", selected && "hidden md:block")}>
            <div className="relative">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or message…"
                className="w-full pl-8 pr-3 py-2 bg-[#eef2f7] border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
            </div>
            <div className="rounded-xl border border-[#e4ebf2] bg-white divide-y divide-[#eef3f8] overflow-hidden max-h-[70vh] overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="py-10 text-center text-[#8595a8] text-sm">No conversations.</div>
              ) : filtered.map((c) => (
                <button key={c.id} onClick={() => openConversation(c)}
                  className={cn("w-full text-left px-3 py-2.5 hover:bg-[#f1f5f9] transition-colors",
                    selected?.id === c.id && "bg-[#e6f7f5]")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-[#1f3559] truncate">{c.contactName}</span>
                    <span className="text-[10px] text-[#8595a8] shrink-0">{timeAgo(c.lastMessageDate)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {c.lastMessageDirection === "inbound" && (
                      <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-[#15B7AE]" title="They replied last" />
                    )}
                    <span className="text-xs text-[#697a91] truncate">{c.lastMessageBody || "—"}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Thread + draft */}
          <div className={cn(!selected && "hidden md:block")}>
            {!selected ? (
              <div className="h-full min-h-[300px] rounded-xl border border-dashed border-[#d7e0ea] bg-white flex items-center justify-center text-sm text-[#8595a8]">
                Select a conversation to draft a reply.
              </div>
            ) : (
              <div className="rounded-xl border border-[#e4ebf2] bg-white overflow-hidden flex flex-col">
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#eef3f8] bg-[#f8fafc]">
                  <button onClick={() => setSelected(null)} className="md:hidden text-[#34568a]"><ChevronLeft size={18} /></button>
                  <span className="text-sm font-bold text-[#1f3559] truncate">{selected.contactName}</span>
                </div>

                {/* Messages */}
                <div className="p-3 space-y-2 max-h-[44vh] overflow-y-auto bg-[#fbfdff]">
                  {threadLoading ? (
                    <div className="flex items-center gap-2 text-sm text-[#697a91] py-8 justify-center"><Loader2 size={14} className="animate-spin" /> Loading…</div>
                  ) : thread.length === 0 ? (
                    <div className="text-center text-[#8595a8] text-sm py-8">No messages in this conversation.</div>
                  ) : thread.map((m) => (
                    <div key={m.id} className={cn("flex", m.direction === "outbound" ? "justify-end" : "justify-start")}>
                      <div className={cn("max-w-[78%] px-3 py-1.5 rounded-2xl text-sm whitespace-pre-wrap break-words",
                        m.direction === "outbound"
                          ? "bg-[#15B7AE] text-white rounded-br-sm"
                          : "bg-[#eef2f7] text-[#1f3559] rounded-bl-sm")}>
                        {m.body}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Draft composer */}
                <div className="border-t border-[#eef3f8] p-3 space-y-2 bg-white">
                  <input value={instructions} onChange={(e) => setInstructions(e.target.value)}
                    placeholder="Optional: steer this reply (e.g. offer the $497 deal, book a call)…"
                    className="w-full px-3 py-1.5 bg-[#eef2f7] border border-[#e4ebf2] rounded-lg text-xs text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
                  <div className="flex items-center gap-2">
                    <button onClick={generate} disabled={drafting || threadLoading}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white disabled:opacity-60">
                      {drafting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                      {draft ? "Regenerate" : "Generate reply"}
                    </button>
                    {voiceNote && <span className="text-[11px] text-[#8595a8]">{voiceNote}</span>}
                  </div>

                  {draft && (
                    <>
                      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4}
                        className="w-full px-3 py-2 border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE] resize-y" />
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[#8595a8]">Edit if needed, then copy.</span>
                        <button onClick={copy}
                          className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-[#1f3559] hover:bg-[#13233d] text-white">
                          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy Response"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
