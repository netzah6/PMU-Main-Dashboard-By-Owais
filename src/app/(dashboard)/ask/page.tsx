"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles, ChevronDown, ChevronRight, Copy, ExternalLink, Check, MessageCircle, RefreshCw, X, Pencil } from "lucide-react";
import { toast } from "sonner";
import { cn, userColor } from "@/lib/utils";

type Draft = { contactName: string; channel: string; draft: string; voice: string; conversationUrl: string; conversationId?: string; contactId?: string | null };
type Msg = { role: "user" | "assistant"; content: string; queries?: string[]; drafts?: Draft[]; reports?: string[] };
type Conv = {
  id: string;
  contactId: string | null;
  contactName: string;
  lastMessageBody: string;
  lastMessageDate: string | null;
  unreadCount: number;
  channel: string;
  assignedTo: string | null;
  assignedToName: string;
};
type ThreadMsg = { id: string; direction: "inbound" | "outbound"; body: string; dateAdded: string | null; channel: string };

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

export default function AskPage() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const [convs, setConvs] = useState<Conv[]>([]);
  const [convsLoading, setConvsLoading] = useState(true);
  const [convsError, setConvsError] = useState<string | null>(null);
  // Members are server-filtered to their own assigned chats; admins get
  // everything plus the roster and this client-side filter.
  const [role, setRole] = useState<"admin" | "member">("member");
  const [roster, setRoster] = useState<{ id: string; name: string }[]>([]);
  const [filterUser, setFilterUser] = useState<string>("all");
  const [showChats, setShowChats] = useState(false); // mobile toggle
  const [locationId, setLocationId] = useState<string>("");
  const [pending, setPending] = useState<Conv | null>(null); // chat awaiting a draft
  const [note, setNote] = useState("");                       // optional steer for the AI
  const [thread, setThread] = useState<ThreadMsg[]>([]);      // full conversation shown in the composer
  const [threadLoading, setThreadLoading] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  // Open conversations at the BOTTOM (latest message) — scrolling down from
  // the top by hand on every chat was the #1 annoyance.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread]);
  // Manual send — YOU type it, YOU click Send; nothing automated.
  const [sendText, setSendText] = useState("");
  const [sending, setSending] = useState(false);
  // Admin-only agent inbox view toggle.
  const [view, setView] = useState<"chat" | "agent">("chat");
  const [agentPending, setAgentPending] = useState(0);

  const loadConvs = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) { setConvsLoading(true); setConvsError(null); }
    try {
      const res = await fetch("/api/ghl/reply/conversations");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load chats");
      setConvs(json.conversations ?? []);
      setLocationId(json.locationId ?? "");
      setRole(json.role ?? "member");
      setRoster(json.roster ?? []);
    } catch (e) {
      setConvsError(`${e}`.replace("Error: ", ""));
    } finally {
      setConvsLoading(false);
    }
  }, []);

  // Build the GHL deep-link that reliably opens this contact's chat.
  const chatUrl = useCallback((c: Conv) =>
    c.contactId && locationId
      ? `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${c.contactId}`
      : locationId ? `https://app.gohighlevel.com/v2/location/${locationId}/conversations/conversations/${c.id}` : "",
  [locationId]);
  useEffect(() => { loadConvs(); }, [loadConvs]);

  // Keep the inbox fresh for the team: silently re-fetch every 45s while the
  // page is visible, so new client messages appear without a manual refresh.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") loadConvs({ silent: true });
    }, 45_000);
    return () => clearInterval(t);
  }, [loadConvs]);

  const sendManual = useCallback(async () => {
    if (!pending?.contactId || !sendText.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/ghl/reply/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: pending.contactId, message: sendText.trim(), channel: pending.channel }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Send failed");
      toast.success(`Message sent to ${pending.contactName}`);
      setSendText("");
      setPending(null);
      loadConvs();
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally {
      setSending(false);
    }
  }, [pending, sendText, sending, loadConvs]);

  // Badge count for the Agent toggle, fetched once the role is known.
  useEffect(() => {
    if (role !== "admin") return;
    fetch("/api/agent/proposals")
      .then((r) => r.json())
      .then((j) => setAgentPending(j.pending ?? 0))
      .catch(() => {});
  }, [role]);

  // Load the full conversation whenever the composer opens for a chat.
  useEffect(() => {
    if (!pending) { setThread([]); return; }
    let cancelled = false;
    setThreadLoading(true); setThread([]);
    fetch(`/api/ghl/reply/thread?conversationId=${encodeURIComponent(pending.id)}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setThread(j.messages ?? []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setThreadLoading(false); });
    return () => { cancelled = true; };
  }, [pending]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setError(null);
    setInput("");
    const history = [...msgs, { role: "user" as const, content: q }];
    setMsgs(history);
    setBusy(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setMsgs((m) => [...m, { role: "assistant", content: json.answer, queries: json.queries, drafts: json.drafts, reports: json.reports }]);
    } catch (e) {
      setError(`${e}`.replace("Error: ", ""));
      setMsgs((m) => m.slice(0, -1));
      setInput(q);
    } finally {
      setBusy(false);
    }
  }, [busy, msgs]);

  // Clicking a chat opens the composer (with an optional note) rather than
  // firing off a draft immediately — so you can steer the reply first.
  const clickConv = useCallback((c: Conv) => {
    setShowChats(false);
    setNote("");
    setSendText("");
    setPending(c);
  }, []);

  // Draft deterministically off the exact conversation id (no LLM name-guessing),
  // passing the optional note as instructions. Fixes wrong-chat + adds the note.
  const generateDraft = useCallback(async (c: Conv, steer: string) => {
    if (busy) return;
    setPending(null);
    const trimmed = steer.trim();
    const label = `Draft a reply to ${c.contactName}${trimmed ? ` — note: ${trimmed}` : ""}`;
    setMsgs((m) => [...m, { role: "user", content: label }]);
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/ghl/reply/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: c.id, contactName: c.contactName, instructions: trimmed || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to draft a reply");
      const voice = json.voice?.name ?? "";
      const draft: Draft = { contactName: c.contactName, channel: c.channel, draft: json.draft, voice, conversationUrl: chatUrl(c), conversationId: c.id, contactId: c.contactId };
      setMsgs((m) => [...m, { role: "assistant", content: `Here's a draft for ${c.contactName}${voice ? ` in ${voice}'s style` : ""} — use the buttons below to copy it and open the chat.`, drafts: [draft] }]);
    } catch (e) {
      setError(`${e}`.replace("Error: ", ""));
      setMsgs((m) => m.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }, [busy, chatUrl]);

  // "Edit" on a draft card: regenerate the SAME draft with the user's change
  // notes applied. The previous draft text is sent along so the AI revises it
  // instead of starting over.
  const editDraft = useCallback(async (d: Draft, editNote: string) => {
    const change = editNote.trim();
    if (!change || busy || !d.conversationId) return;
    setMsgs((m) => [...m, { role: "user", content: `Edit the draft for ${d.contactName} — ${change}` }]);
    setBusy(true); setError(null);
    try {
      const instructions = `You already wrote this draft:\n"""\n${d.draft}\n"""\nRewrite it, applying these changes: ${change}\nKeep everything that wasn't asked to change.`;
      const res = await fetch("/api/ghl/reply/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: d.conversationId, contactName: d.contactName, instructions }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to update the draft");
      const voice = json.voice?.name ?? d.voice;
      const draft: Draft = { ...d, draft: json.draft, voice };
      setMsgs((m) => [...m, { role: "assistant", content: `Updated draft for ${d.contactName} — your changes are in. Edit again if it still needs work.`, drafts: [draft] }]);
    } catch (e) {
      setError(`${e}`.replace("Error: ", ""));
      setMsgs((m) => m.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // Admin-only client-side filter (members are already server-filtered).
  const shownConvs = role === "admin" && filterUser !== "all"
    ? convs.filter((c) => (filterUser === "__none" ? !c.assignedTo : c.assignedTo === filterUser))
    : convs;

  const chatList = (
    <>
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#eef3f8]">
        <span className="text-xs font-bold text-[#1f3559] flex items-center gap-1.5"><MessageCircle size={13} className="text-[#15B7AE]" /> {role === "member" ? "Your unread chats" : "Unread chats"} {shownConvs.length > 0 && <span className="px-1.5 rounded-full bg-[#fde8ee] text-[#e11d48] text-[10px] font-bold">{shownConvs.length}</span>}</span>
        <button onClick={() => loadConvs()} title="Refresh" className="p-1 rounded text-[#8595a8] hover:text-[#0e8f88]"><RefreshCw size={13} className={convsLoading ? "animate-spin" : ""} /></button>
      </div>
      {role === "admin" && (
        <div className="px-3 py-1.5 border-b border-[#eef3f8]">
          <select value={filterUser} onChange={(e) => setFilterUser(e.target.value)}
            className="w-full text-xs border border-[#e4ebf2] rounded-lg px-2 py-1 bg-white text-[#1f3559]">
            <option value="all">👥 Everyone</option>
            {roster.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            <option value="__none">Unassigned</option>
          </select>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {convsError ? (
          <p className="p-3 text-xs text-[#e11d48]">{convsError}</p>
        ) : convsLoading && convs.length === 0 ? (
          <p className="p-3 text-xs text-[#8595a8] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Loading chats…</p>
        ) : shownConvs.length === 0 ? (
          <p className="p-3 text-xs text-[#8595a8]">{role === "member" ? "No unread chats assigned to you 🎉" : "Inbox zero — no unread chats 🎉"}</p>
        ) : (
          shownConvs.map((c) => (
            <button key={c.id} onClick={() => clickConv(c)} disabled={busy}
              className="w-full text-left px-3 py-2.5 border-b border-[#f1f5f9] hover:bg-[#f7fdfc] disabled:opacity-50 transition-colors">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-bold text-[#1f3559] truncate">
                  {c.contactName}
                  {c.assignedToName && (() => {
                    const uc = userColor(c.assignedToName);
                    return (
                      <span className="ml-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap border align-middle"
                        style={{ background: uc?.bg, color: uc?.text, borderColor: uc?.border }}>
                        {c.assignedToName.split(" ")[0]}
                      </span>
                    );
                  })()}
                </span>
                <span className="shrink-0 text-[10px] text-[#8595a8]">{timeAgo(c.lastMessageDate)}</span>
              </div>
              <p className="text-[11px] text-[#697a91] truncate mt-0.5">{c.lastMessageBody || "(no text)"}</p>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="text-[9px] font-semibold uppercase text-[#0e8f88]">{c.channel}</span>
                {c.unreadCount > 0 && <span className="px-1 rounded-full bg-[#e11d48] text-white text-[9px] font-bold">{c.unreadCount}</span>}
              </div>
            </button>
          ))
        )}
      </div>
      <p className="px-3 py-2 border-t border-[#eef3f8] text-[9px] text-[#a6b3c4]">Click a chat → add an optional note → the AI drafts a reply in your voice</p>
    </>
  );

  return (
    <div className="flex h-full w-full">
      {/* Chats sidebar — desktop (wider so client names + assignee fit) */}
      <aside className="hidden md:flex flex-col w-80 xl:w-96 shrink-0 border-r border-[#e4ebf2] bg-white">
        {chatList}
      </aside>
      {/* Chats drawer — mobile */}
      {showChats && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="w-80 max-w-[85vw] flex flex-col bg-white shadow-xl">{chatList}</div>
          <div className="flex-1 bg-black/30" onClick={() => setShowChats(false)} />
        </div>
      )}

    <div className="flex flex-col h-full flex-1 min-w-0 max-w-3xl mx-auto w-full p-2 sm:p-3">
      {/* Slim top row: agent toggle (admins) + mobile chats button — the old
          "AI" headline was removed to give the conversation more height. */}
      <div className="mb-2 flex items-center justify-between gap-2">
      {role === "admin" ? (
        <div className="flex gap-1 rounded-lg border border-[#e4ebf2] bg-white p-1 w-fit">
          {(["chat", "agent"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={cn("px-3 py-1.5 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5",
                view === v ? "bg-[#15B7AE] text-white" : "text-[#34568a] hover:bg-[#f7fdfc]")}>
              {v === "chat" ? "💬 Chat" : "🕵️ Agent"}
              {v === "agent" && agentPending > 0 && (
                <span className={cn("px-1.5 rounded-full text-[10px] font-bold", view === v ? "bg-white text-[#0e8f88]" : "bg-[#e11d48] text-white")}>{agentPending}</span>
              )}
            </button>
          ))}
        </div>
      ) : <span />}
        <button onClick={() => setShowChats(true)}
          className="md:hidden shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#d7e0ea] text-xs font-semibold text-[#34568a]">
          <MessageCircle size={13} /> Chats{convs.length > 0 ? ` (${convs.length})` : ""}
        </button>
      </div>

      {view === "agent" && role === "admin" ? (
        <AgentPanel onCount={setAgentPending} />
      ) : (
      <>
      <div className="flex-1 overflow-y-auto space-y-3 pb-4">
        {msgs.length === 0 && (
          <div className="pt-16 text-center text-sm text-[#8595a8]">
            Ask anything, type a client&apos;s name for their report, ask &quot;what&apos;s unread?&quot;, or &quot;draft a reply to …&quot;.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn(
              "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words",
              m.role === "user"
                ? "bg-[#15B7AE] text-white rounded-br-md"
                : "bg-white border border-[#e4ebf2] text-[#1f3559] rounded-bl-md",
            )}>
              {m.content}
              {m.role === "assistant" && (m.reports ?? []).map((r, j) => (
                // Server-rendered report card — exact computed text, the model
                // never touches these numbers.
                <pre key={"r" + j} className="mt-2 p-3 rounded-lg bg-[#f8fafc] border border-[#e4ebf2] text-[12px] leading-relaxed whitespace-pre-wrap font-sans text-[#1f3559]">{r}</pre>
              ))}
              {m.role === "assistant" && (m.drafts ?? []).map((d, j) => <DraftCard key={j} d={d} busy={busy} onEdit={editDraft} />)}
              {m.role === "assistant" && (m.queries?.length ?? 0) > 0 && <QueryDetails queries={m.queries!} />}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md px-4 py-2.5 bg-white border border-[#e4ebf2] text-sm text-[#697a91] flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-[#15B7AE]" /> Querying the data…
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && <div className="mb-2 px-3 py-2 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-xs">{error}</div>}

      {/* Reply composer — appears when a chat is clicked. Shows the full
          conversation, then a clearly-labelled note the AI reads before drafting. */}
      {pending && (
        <div className="mb-2 rounded-xl border border-[#a7e3df] bg-[#f7fdfc] p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#0e8f88] flex items-center gap-1.5">
              <MessageCircle size={13} /> {pending.contactName}{pending.channel ? ` · ${pending.channel}` : ""}
            </span>
            <button onClick={() => setPending(null)} title="Cancel" className="p-0.5 rounded text-[#8595a8] hover:text-[#e11d48]"><X size={14} /></button>
          </div>

          {/* Full conversation thread */}
          <div ref={threadRef} className="mb-2.5 max-h-[55vh] overflow-y-auto rounded-lg border border-[#e4ebf2] bg-white p-2 space-y-1.5">
            {threadLoading ? (
              <p className="text-[11px] text-[#8595a8] flex items-center gap-1.5 py-1"><Loader2 size={11} className="animate-spin" /> Loading conversation…</p>
            ) : thread.length === 0 ? (
              <p className="text-[11px] text-[#8595a8] py-1">No readable messages in this conversation.</p>
            ) : (
              thread.map((m) => (
                <div key={m.id} className={cn("flex", m.direction === "inbound" ? "justify-start" : "justify-end")}>
                  <div className={cn(
                    "max-w-[85%] rounded-lg px-2.5 py-1.5 text-[12px] leading-snug whitespace-pre-wrap break-words",
                    m.direction === "inbound" ? "bg-[#f1f5f9] text-[#1f3559]" : "bg-[#e6f7f5] text-[#0e5f5a]",
                  )}>
                    {m.body}
                    {m.dateAdded && <span className="block mt-0.5 text-[9px] text-[#a6b3c4]">{timeAgo(m.dateAdded)} ago</span>}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Note box — explicitly labelled so it's clear the AI reads it */}
          <div className="rounded-lg border border-[#ffd8a8] bg-[#fffaf2] p-2">
            <label htmlFor="ai-note" className="flex items-center gap-1.5 text-[11px] font-bold text-[#c2620a] mb-1">
              📝 Note for the AI <span className="font-medium text-[#a1783f]">— it reads this before writing the reply (optional)</span>
            </label>
            <textarea
              id="ai-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); generateDraft(pending, note); } }}
              rows={2}
              autoFocus
              placeholder="e.g. 'let her know Tue 2pm is open' or 'gently ask for the $50 deposit'. Leave blank for a standard draft."
              className="w-full px-3 py-2 text-sm text-[#1f3559] bg-white border border-[#f0d9ae] rounded-lg focus:outline-none focus:border-[#f0a742] resize-none"
            />
          </div>

          <div className="flex items-center gap-2 mt-2">
            <button onClick={() => generateDraft(pending, note)} disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Generate draft
            </button>
            <span className="text-[10px] text-[#8595a8]">⌘/Ctrl+Enter to generate</span>
          </div>

          {/* Manual send — goes straight into the GHL chat, only when YOU click Send */}
          <div className="mt-2.5 rounded-lg border border-[#c9dbfb] bg-[#f7faff] p-2">
            <label htmlFor="manual-send" className="flex items-center gap-1.5 text-[11px] font-bold text-[#34568a] mb-1">
              ✍️ Send a message yourself <span className="font-medium text-[#8595a8]">— sends in GHL as-is when you click Send ({pending.channel || "SMS"})</span>
            </label>
            <textarea
              id="manual-send"
              value={sendText}
              onChange={(e) => setSendText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendManual(); } }}
              rows={2}
              placeholder={`Type the exact message to send to ${pending.contactName}…`}
              className="w-full px-3 py-2 text-sm text-[#1f3559] bg-white border border-[#c9dbfb] rounded-lg focus:outline-none focus:border-[#4f46e5] resize-none"
            />
            <div className="flex items-center gap-2 mt-1.5">
              <button onClick={sendManual} disabled={sending || !sendText.trim() || !pending.contactId}
                className="px-3 py-1.5 rounded-lg bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
                {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send to {pending.contactName}
              </button>
              <span className="text-[10px] text-[#8595a8]">{pending.contactId ? "⌘/Ctrl+Enter to send" : "no contact id — open the chat in GHL"}</span>
            </div>
          </div>
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. How many leads does Sabby Beauty have this month?"
          className="flex-1 px-4 py-3 bg-white border border-[#d7e0ea] rounded-xl text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}
          className="px-4 py-3 rounded-xl bg-[#15B7AE] hover:bg-[#0e8f88] text-white disabled:opacity-50 flex items-center gap-1.5 text-sm font-semibold">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </form>
      </>
      )}
    </div>
    </div>
  );
}

// ── CEO Agent inbox (admin only) ─────────────────────────────────────────────
// Client requests the scanner detected, waiting for an explicit Approve/Deny.
// Approve sends the (editable) reply; account changes queue for the browser
// worker. Nothing ever executes without a click here.
type AgentProposal = {
  id: string; created_at: string; contact_name: string; channel: string | null;
  client_message: string; summary: string; action_type: "reply" | "account_change";
  proposed_reply: string | null; action_detail: string | null;
  status: string; decided_by: string | null; result: string | null;
};

function AgentPanel({ onCount }: { onCount: (n: number) => void }) {
  const [proposals, setProposals] = useState<AgentProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/agent/proposals");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load proposals");
      setProposals(json.proposals ?? []);
      onCount(json.pending ?? 0);
    } catch (e) {
      setErr(`${e}`.replace("Error: ", ""));
    } finally {
      setLoading(false);
    }
  }, [onCount]);
  useEffect(() => { load(); }, [load]);

  const pending = proposals.filter((p) => p.status === "pending");
  const history = proposals.filter((p) => p.status !== "pending");

  return (
    <div className="flex-1 overflow-y-auto space-y-3 pb-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#697a91]">
          The agent reads incoming client messages every 10 minutes and files requests here. <b>Nothing runs without your Approve.</b>
        </p>
        <button onClick={load} title="Refresh" className="p-1.5 rounded text-[#8595a8] hover:text-[#0e8f88]">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {err && <div className="px-3 py-2 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-xs">{err}</div>}
      {loading && proposals.length === 0 ? (
        <p className="text-xs text-[#8595a8] flex items-center gap-1.5 py-8 justify-center"><Loader2 size={13} className="animate-spin" /> Loading the agent inbox…</p>
      ) : pending.length === 0 ? (
        <div className="text-center py-8 text-sm text-[#8595a8]">No pending requests — the agent found nothing that needs you right now 🎉</div>
      ) : (
        pending.map((p) => <ProposalCard key={p.id} p={p} onDecided={load} />)
      )}
      {history.length > 0 && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8] mb-1 mt-4">History</div>
          <div className="space-y-1">
            {history.map((p) => (
              <div key={p.id} className="rounded-lg border border-[#eef3f8] bg-white px-3 py-2 text-[11px] text-[#697a91]">
                <span className={cn("font-bold mr-1.5", p.status === "denied" ? "text-[#e11d48]" : p.status === "failed" ? "text-[#c2620a]" : "text-[#15803d]")}>
                  {p.status === "queued_browser" ? "queued for browser" : p.status}
                </span>
                <span className="font-semibold text-[#1f3559]">{p.contact_name}</span> — {p.summary}
                {p.result && <span className="text-[#8595a8]"> · {p.result}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProposalCard({ p, onDecided }: { p: AgentProposal; onDecided: () => void }) {
  const [reply, setReply] = useState(p.proposed_reply ?? "");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const sensitive = (p.action_detail ?? "").startsWith("SENSITIVE:");

  const decide = useCallback(async (decision: "approve" | "deny") => {
    if (busy) return;
    setBusy(decision);
    try {
      const res = await fetch("/api/agent/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id, decision, reply: decision === "approve" ? reply : undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      toast.success(decision === "deny" ? "Denied — nothing sent" : json.status === "queued_browser" ? "Reply sent · account change queued for the browser worker" : "Approved — reply sent");
      onDecided();
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
      setBusy(null);
    }
  }, [busy, p.id, reply, onDecided]);

  return (
    <div className={cn("rounded-xl border p-3", sensitive ? "border-[#f5c2cf] bg-[#fffafb]" : "border-[#c9dbfb] bg-[#f7faff]")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-bold text-[#1f3559]">{p.contact_name}</span>
        <span className="text-[10px] text-[#8595a8]">{timeAgo(p.created_at)} ago{p.channel ? ` · ${p.channel}` : ""}</span>
      </div>
      <p className="mt-1.5 text-[12px] text-[#697a91] border-l-2 border-[#d7e0ea] pl-2 whitespace-pre-wrap">&ldquo;{p.client_message}&rdquo;</p>
      <p className="mt-2 text-sm text-[#1f3559]"><b>Wants:</b> {p.summary}</p>
      {p.action_type === "account_change" && (
        <div className={cn("mt-1.5 rounded-lg border px-2.5 py-1.5 text-[12px]", sensitive ? "border-[#f5c2cf] bg-[#fde8ee] text-[#9f1239]" : "border-[#ffd8a8] bg-[#fffaf2] text-[#c2620a]")}>
          {sensitive ? "⚠️ SENSITIVE — " : "🔧 "}Account change: {(p.action_detail ?? "").replace(/^SENSITIVE:\s*/, "")}
          <span className="block text-[10px] mt-0.5 opacity-80">Approve sends the reply below and queues this change for the browser worker — it is NOT auto-executed.</span>
        </div>
      )}
      <label className="block mt-2 text-[11px] font-bold text-[#34568a]">Reply to send (edit freely — empty = send nothing):</label>
      <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2}
        className="w-full mt-1 px-3 py-2 text-sm text-[#1f3559] bg-white border border-[#c9dbfb] rounded-lg focus:outline-none focus:border-[#4f46e5] resize-none" />
      <div className="flex items-center gap-2 mt-2">
        <button onClick={() => decide("approve")} disabled={!!busy}
          className="px-3 py-1.5 rounded-lg bg-[#15803d] hover:bg-[#166534] text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy === "approve" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Approve{reply.trim() ? " & send" : ""}
        </button>
        <button onClick={() => decide("deny")} disabled={!!busy}
          className="px-3 py-1.5 rounded-lg border border-[#f5c2cf] text-[#e11d48] hover:bg-[#fde8ee] text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy === "deny" ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} Deny
        </button>
      </div>
    </div>
  );
}

function DraftCard({ d, busy, onEdit }: { d: Draft; busy?: boolean; onEdit?: (d: Draft, note: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editNote, setEditNote] = useState("");
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent">("idle");
  // Manual text editing: `text` is the live draft — Send/Copy/AI-edit all use
  // it, so hand-typed changes carry through everywhere.
  const [text, setText] = useState(d.draft);
  const [manualOpen, setManualOpen] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }, [text]);
  const canEdit = !!(onEdit && d.conversationId);
  // Manual send of THIS exact draft text — one explicit click, no automation.
  const canSend = !!d.contactId && d.channel !== "Email" && d.channel !== "Call";
  const sendDraft = useCallback(async () => {
    if (!d.contactId || sendState !== "idle" || !text.trim()) return;
    setSendState("sending");
    try {
      const res = await fetch("/api/ghl/reply/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: d.contactId, message: text.trim(), channel: d.channel }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Send failed");
      setSendState("sent");
      toast.success(`Sent to ${d.contactName}`);
    } catch (e) {
      setSendState("idle");
      toast.error(`${e}`.replace("Error: ", ""));
    }
  }, [d, sendState, text]);
  const submitEdit = () => {
    if (!editNote.trim() || !onEdit) return;
    onEdit({ ...d, draft: text }, editNote); // AI revises the CURRENT text, manual edits included
    setEditOpen(false);
    setEditNote("");
  };
  return (
    <div className="mt-2.5 rounded-xl border border-[#a7e3df] bg-[#f7fdfc] p-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-[#0e8f88] mb-1.5">
        Draft for {d.contactName}{d.channel ? ` · ${d.channel}` : ""}{d.voice ? ` · in ${d.voice}'s style` : ""}
      </p>
      {manualOpen ? (
        <div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(8, Math.max(3, text.split("\n").length + 1))} autoFocus
            className="w-full px-3 py-2 text-sm text-[#1f3559] bg-white border border-[#a7e3df] rounded-lg focus:outline-none focus:border-[#15B7AE] resize-y" />
          <button onClick={() => setManualOpen(false)} disabled={!text.trim()}
            className="mt-1 px-3 py-1 rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white text-xs font-semibold disabled:opacity-50">
            Done
          </button>
        </div>
      ) : (
        <p className="text-sm text-[#1f3559] whitespace-pre-wrap">{text}</p>
      )}
      <div className="flex items-center gap-2 mt-2.5 flex-wrap">
        {canSend && (
          <button onClick={sendDraft} disabled={sendState !== "idle"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-semibold disabled:opacity-60">
            {sendState === "sending" ? <Loader2 size={12} className="animate-spin" /> : sendState === "sent" ? <Check size={12} /> : <Send size={12} />}
            {sendState === "sent" ? "Sent ✓" : `Send to ${d.contactName}`}
          </button>
        )}
        <button
          onClick={() => { copy(); window.open(d.conversationUrl, "_blank", "noopener"); toast.success("Draft copied — paste it in the chat"); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white text-xs font-semibold">
          <ExternalLink size={12} /> Copy &amp; open chat
        </button>
        <button onClick={() => { copy(); toast.success("Draft copied"); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#a7e3df] text-[#0e8f88] hover:bg-white text-xs font-semibold">
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </button>
        <button onClick={() => setManualOpen((o) => !o)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#c9dbfb] text-[#34568a] hover:bg-[#f7faff] text-xs font-semibold">
          <Pencil size={12} /> {manualOpen ? "Close editor" : "Edit text"}
        </button>
        {canEdit && (
          <button onClick={() => setEditOpen((o) => !o)} disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#f0d9ae] text-[#c2620a] hover:bg-[#fffaf2] text-xs font-semibold disabled:opacity-50">
            <Sparkles size={12} /> AI edit
          </button>
        )}
        <span className="text-[10px] text-[#8595a8]">draft only — you send it</span>
      </div>
      {editOpen && canEdit && (
        <div className="mt-2.5 rounded-lg border border-[#ffd8a8] bg-[#fffaf2] p-2">
          <label className="flex items-center gap-1.5 text-[11px] font-bold text-[#c2620a] mb-1">
            📝 What should change? <span className="font-medium text-[#a1783f]">— the AI rewrites this draft with your notes applied</span>
          </label>
          <textarea
            value={editNote}
            onChange={(e) => setEditNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitEdit(); } }}
            rows={2}
            autoFocus
            placeholder="e.g. 'mention the price is $50' or 'make it shorter and add a booking link'"
            className="w-full px-3 py-2 text-sm text-[#1f3559] bg-white border border-[#f0d9ae] rounded-lg focus:outline-none focus:border-[#f0a742] resize-none"
          />
          <div className="flex items-center gap-2 mt-1.5">
            <button onClick={submitEdit} disabled={busy || !editNote.trim()}
              className="px-3 py-1.5 rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Regenerate draft
            </button>
            <span className="text-[10px] text-[#8595a8]">⌘/Ctrl+Enter</span>
          </div>
        </div>
      )}
    </div>
  );
}

function QueryDetails({ queries }: { queries: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 pt-2 border-t border-[#f1f5f9]">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[10px] font-semibold text-[#8595a8] hover:text-[#0e8f88]">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {queries.length} {queries.length === 1 ? "query" : "queries"} run
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {queries.map((q, i) => (
            <pre key={i} className="text-[10px] leading-snug bg-[#f8fafc] border border-[#eef3f8] rounded-lg p-2 overflow-x-auto text-[#34568a]">{q}</pre>
          ))}
        </div>
      )}
    </div>
  );
}
