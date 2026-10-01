"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles, ChevronDown, ChevronRight, Copy, Check, MessageCircle, RefreshCw, X, Pencil } from "lucide-react";
import { toast } from "sonner";
import { cn, userColor } from "@/lib/utils";

// voiceInfo only comes from /api/ghl/reply/draft — AI-chat drafts carry just
// the name, so the "written in …'s voice" line is skipped for those.
type VoiceInfo = { name: string; matched: boolean; samplesUsed: number };
type Draft = { contactName: string; channel: string; draft: string; voice: string; voiceInfo?: VoiceInfo; conversationUrl: string; conversationId?: string; contactId?: string | null };
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
  // ── CEO Agent, merged into the chat (owner request 2026-10-01) ──
  // Admin only. Cards live next to their conversation instead of a separate
  // tab; nothing runs until someone opens the card and clicks Approve.
  const [proposals, setProposals] = useState<AgentProposal[]>([]);
  const [lastScan, setLastScan] = useState<ScanLog | null>(null);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [proposalsLoaded, setProposalsLoaded] = useState(false);
  const [proposalsErr, setProposalsErr] = useState<string | null>(null);
  // Latest-wins guard: a slow 45 s refresh must not wipe a card that 🪄 just
  // filed (or a decision just made) with an older copy of the list.
  const proposalsReq = useRef(0);
  const [proposing, setProposing] = useState<Set<string>>(new Set()); // conversation ids with a 🪄 in flight
  const proposingRef = useRef<Set<string>>(new Set());
  // Approved cards stay on screen with their before → after proof until
  // dismissed, even after the refreshed list says they're no longer pending.
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [openCardId, setOpenCardId] = useState<string | null>(null); // card shown on its own (chat not in the unread list)
  // A card's edited reply, by card id — kept here so it survives the card
  // moving between the composer and the main area, or a list refresh.
  const [cardReplies, setCardReplies] = useState<Record<string, string>>({});
  const setCardReply = useCallback((id: string, v: string) => setCardReplies((m) => ({ ...m, [id]: v })), []);
  const [showActivity, setShowActivity] = useState(false);            // "Agent activity & settings" in the main area
  const [orphansOpen, setOrphansOpen] = useState(true);
  // The owner's text says "Approve or deny: …/ask?view=agent&p=<id>" — open
  // that card once the lists load (window.location, not useSearchParams, so
  // the page needs no Suspense boundary).
  const [focusProposal, setFocusProposal] = useState<string | null>(null);
  const deepLinkDone = useRef(false);
  // Highlight + scroll to a card. The tick re-runs the scroll even when the
  // same card is asked for twice (🪄 on a chat that already has one).
  const scrolledTo = useRef<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const focusCard = useCallback((id: string) => {
    scrolledTo.current = null;
    setFocusProposal(id);
    setFocusTick((t) => t + 1);
  }, []);
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.get("p")) setFocusProposal(q.get("p"));
      else if (q.get("view") === "agent") setShowActivity(true); // old inbox link → the activity view
    } catch { /* no query string */ }
  }, []);

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

  const loadProposals = useCallback(async (opts?: { silent?: boolean }) => {
    const req = ++proposalsReq.current;
    if (!opts?.silent) { setProposalsLoading(true); setProposalsErr(null); }
    try {
      const res = await fetch("/api/agent/proposals");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load agent requests");
      if (req !== proposalsReq.current) return; // a newer load or local change won
      setProposals(json.proposals ?? []);
      setLastScan(json.lastScan ?? null);
      setProposalsErr(null);
    } catch (e) {
      if (req === proposalsReq.current) setProposalsErr(`${e}`.replace("Error: ", ""));
    } finally {
      setProposalsLoading(false);
      setProposalsLoaded(true);
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
  // Agent cards ride the same timer so the 🕵️ row badges stay current.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      loadConvs({ silent: true });
      if (role === "admin") loadProposals({ silent: true });
    }, 45_000);
    return () => clearInterval(t);
  }, [loadConvs, loadProposals, role]);

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

  // Agent cards are admin-only — members never fetch (or see) them.
  useEffect(() => {
    if (role === "admin") loadProposals();
  }, [role, loadProposals]);

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
    setShowActivity(false);
    setOpenCardId(null);
    setNote("");
    setSendText("");
    setPending(c);
  }, []);

  // What the composer holds right now, readable from async 🪄 callbacks: a
  // card that lands 20 s later must not wipe a reply someone is typing.
  const composerRef = useRef<{ id: string | null; dirty: boolean }>({ id: null, dirty: false });
  useEffect(() => {
    composerRef.current = { id: pending?.id ?? null, dirty: !!(note.trim() || sendText.trim()) };
  }, [pending, note, sendText]);

  // Show a card: in its conversation's composer when that chat is in the
  // list, otherwise on its own in the main area. Already-decided cards (an
  // SMS link opened late) always go on their own — the composer only lists
  // live ones.
  const openProposal = useCallback((p: AgentProposal) => {
    focusCard(p.id);
    const c = p.status === "pending" ? convs.find((x) => x.id === p.conversation_id) : undefined;
    if (c) {
      if (composerRef.current.id !== c.id) clickConv(c);
      else { setShowActivity(false); setShowChats(false); }
      return;
    }
    setPending(null);
    setShowActivity(false);
    setShowChats(false);
    setOpenCardId(p.id);
  }, [convs, clickConv, focusCard]);

  // 🪄 "Let AI handle it": files (or returns the open) card for this chat.
  // It only PROPOSES — the card still needs a human Approve to do anything.
  const proposeFor = useCallback(async (c: Conv) => {
    // Always ask the server: it hands back the open card when nothing new has
    // arrived, and re-reads the chat when the client wrote since.
    if (proposingRef.current.has(c.id)) return;
    proposingRef.current.add(c.id);
    setProposing(new Set(proposingRef.current));
    try {
      const res = await fetch("/api/agent/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: c.id, contactId: c.contactId, contactName: c.contactName, channel: c.channel }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.proposal) throw new Error(json.error || "The AI couldn't take this one");
      const p = json.proposal as AgentProposal;
      proposalsReq.current++; // any in-flight refresh predates this card
      setProposals((list) => [p, ...list.filter((x) => x.id !== p.id)]);
      const cur = composerRef.current;
      if (cur.id && cur.id !== c.id && cur.dirty) {
        // Someone is mid-reply in another chat — don't yank them away.
        toast.success(`AI plan ready for ${c.contactName}`, { action: { label: "Open", onClick: () => { focusCard(p.id); clickConv(c); } } });
      } else {
        focusCard(p.id);
        if (cur.id !== c.id) clickConv(c);
        else { setShowActivity(false); setOpenCardId(null); }
      }
    } catch (e) {
      toast.error(`${c.contactName}: ${`${e}`.replace("Error: ", "")}`);
    } finally {
      proposingRef.current.delete(c.id);
      setProposing(new Set(proposingRef.current));
    }
  }, [clickConv, focusCard]);

  // Card lifecycle → list upkeep. Approving pins the card so its proof stays
  // up through the refresh; deny / dismiss / a failed request let it go.
  const onCardPhase = useCallback((id: string, phase: CardPhase) => {
    if (phase === "approving") { setPinned((s) => new Set(s).add(id)); return; }
    if (phase !== "approved") {
      setPinned((s) => { const n = new Set(s); n.delete(id); return n; });
      if (phase !== "error") setOpenCardId((cur) => (cur === id ? null : cur));
    }
    loadProposals({ silent: true });
  }, [loadProposals]);

  // Deep link from the SMS alert: open that card once both lists are in.
  useEffect(() => {
    if (deepLinkDone.current || !focusProposal || role !== "admin" || !proposalsLoaded || convsLoading) return;
    deepLinkDone.current = true;
    const p = proposals.find((x) => x.id === focusProposal);
    if (p) openProposal(p);
    else toast.error(proposalsErr ? `Couldn't load agent requests: ${proposalsErr}` : "That agent request isn't in the recent list anymore");
  }, [focusProposal, role, proposalsLoaded, convsLoading, proposals, proposalsErr, openProposal]);

  // Bring the focused card into view once it is actually on screen (the
  // composer mounts a render after the card is chosen).
  useEffect(() => {
    if (!focusProposal || scrolledTo.current === focusProposal) return;
    const el = document.getElementById(`proposal-${focusProposal}`);
    if (!el) return;
    scrolledTo.current = focusProposal;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusProposal, focusTick, pending, openCardId, proposals]);

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
      const draft: Draft = { contactName: c.contactName, channel: c.channel, draft: json.draft, voice, voiceInfo: json.voice ?? undefined, conversationUrl: chatUrl(c), conversationId: c.id, contactId: c.contactId };
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
      const draft: Draft = { ...d, draft: json.draft, voice, voiceInfo: json.voice ?? d.voiceInfo };
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

  // Agent view-model — empty for members, so none of the agent UI renders.
  const isAdmin = role === "admin";
  const agentPending = isAdmin ? proposals.filter((p) => p.status === "pending") : [];
  const cardConvIds = new Set(agentPending.map((p) => p.conversation_id));
  const shownIds = new Set(shownConvs.map((c) => c.id));
  // Cards with no row to sit next to (chat already read, or filtered out).
  const orphanCards = agentPending.filter((p) => !shownIds.has(p.conversation_id));
  // The open chat's cards; approved ones stay (pinned) to show their proof.
  const convCards = isAdmin && pending
    ? proposals.filter((p) => p.conversation_id === pending.id && (p.status === "pending" || pinned.has(p.id)))
    : [];
  const openCard = isAdmin && openCardId ? proposals.find((p) => p.id === openCardId) ?? null : null;

  const chatList = (
    <>
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#eef3f8]">
        <span className="text-xs font-bold text-[#1f3559] flex items-center gap-1.5"><MessageCircle size={13} className="text-[#15B7AE]" /> {role === "member" ? "Your unread chats" : "Unread chats"} {shownConvs.length > 0 && <span className="px-1.5 rounded-full bg-[#fde8ee] text-[#e11d48] text-[10px] font-bold">{shownConvs.length}</span>}</span>
        <div className="flex items-center gap-0.5">
          {isAdmin && (
            // Where the old Agent tab's scan log, history and SMS settings live now.
            <button onClick={() => {
              // Give the activity view the whole main area — an open chat squeezed it to nothing.
              setShowActivity((s) => { if (!s) { setPending(null); setOpenCardId(null); } return !s; });
              setShowChats(false);
            }}
              title="Agent activity & settings" aria-label="Agent activity & settings" aria-pressed={showActivity}
              className={cn("px-1.5 py-0.5 rounded text-[12px] flex items-center gap-1", showActivity ? "bg-[#e6f7f5] text-[#0e8f88]" : "text-[#8595a8] hover:bg-[#f7fdfc]")}>
              🕵️{agentPending.length > 0 && <span className="px-1 rounded-full bg-[#e11d48] text-white text-[9px] font-bold">{agentPending.length}</span>}
            </button>
          )}
          <button onClick={() => { loadConvs(); if (isAdmin) loadProposals({ silent: true }); }} title="Refresh" className="p-1 rounded text-[#8595a8] hover:text-[#0e8f88]"><RefreshCw size={13} className={convsLoading || proposalsLoading ? "animate-spin" : ""} /></button>
        </div>
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
      {orphanCards.length > 0 && (
        <div className="border-b border-[#eef3f8] bg-[#f7faff]">
          <button onClick={() => setOrphansOpen((o) => !o)} aria-expanded={orphansOpen}
            className="w-full flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-[#34568a] hover:text-[#185fa5]">
            {orphansOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />} 🕵️ Agent requests ({orphanCards.length})
          </button>
          {orphansOpen && (
            <div className="max-h-48 overflow-y-auto pb-1">
              {orphanCards.map((p) => (
                <button key={p.id} onClick={() => openProposal(p)}
                  className={cn("w-full text-left px-3 py-1.5 hover:bg-white", openCardId === p.id && "bg-white")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-[#1f3559] truncate">{p.contact_name}</span>
                    <span className="shrink-0 text-[10px] text-[#8595a8]">{timeAgo(p.created_at)}</span>
                  </div>
                  <p className="text-[11px] text-[#697a91] truncate">{p.summary}</p>
                </button>
              ))}
            </div>
          )}
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
            // A div, not a button: the 🪄 is its own button and buttons
            // can't nest.
            <div key={c.id} className={cn("flex items-stretch border-b border-[#f1f5f9] hover:bg-[#f7fdfc] transition-colors", pending?.id === c.id && "bg-[#f0fbfa]")}>
            <button onClick={() => clickConv(c)} disabled={busy}
              className="flex-1 min-w-0 text-left pl-3 pr-1 py-2.5 disabled:opacity-50">
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
                {cardConvIds.has(c.id) && (
                  <span title="An AI plan is waiting for your Approve" className="px-1 rounded bg-[#e3eefb] text-[#185fa5] text-[9px] font-bold">🕵️ plan</span>
                )}
              </div>
            </button>
            {isAdmin && (
              // Only files a card — the card itself still needs Approve.
              <button onClick={() => proposeFor(c)} disabled={proposing.has(c.id)}
                title="Let AI handle it" aria-label="Let AI handle it"
                className="shrink-0 w-9 flex items-center justify-center text-[15px] hover:bg-[#eef9f8] disabled:cursor-wait">
                {proposing.has(c.id) ? <Loader2 size={14} className="animate-spin text-[#15B7AE]" /> : "🪄"}
              </button>
            )}
            </div>
          ))
        )}
      </div>
      <p className="px-3 py-2 border-t border-[#eef3f8] text-[9px] text-[#a6b3c4]">
        {isAdmin
          ? "Click a chat → optional note → the AI drafts a reply · 🪄 → the AI plans it, you approve"
          : "Click a chat → add an optional note → the AI drafts a reply in your voice"}
      </p>
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
      {/* Mobile-only top row: the chats drawer button. The Chat/Agent toggle
          is gone (2026-10-01) — agent cards now sit inside the chat. */}
      <div className="md:hidden mb-2 flex items-center justify-end gap-2">
        <button onClick={() => setShowChats(true)}
          className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#d7e0ea] text-xs font-semibold text-[#34568a]">
          <MessageCircle size={13} /> Chats{convs.length > 0 ? ` (${convs.length})` : ""}{agentPending.length > 0 ? ` · 🕵️ ${agentPending.length}` : ""}
        </button>
      </div>

      {showActivity && isAdmin ? (
        <AgentActivity proposals={proposals} lastScan={lastScan} loading={proposalsLoading} err={proposalsErr}
          onRefresh={() => loadProposals()} onOpen={openProposal} onClose={() => setShowActivity(false)} />
      ) : (
      <div className="flex-1 overflow-y-auto space-y-3 pb-4">
        {msgs.length === 0 && (
          <div className="pt-16 text-center text-sm text-[#8595a8]">
            Ask me anything &mdash; write a text blast, draft an email, think something through.
            <br />
            I also know our data: type a client&apos;s name for their report, ask &quot;what&apos;s unread?&quot;, or &quot;draft a reply to …&quot;.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn(
              // Full width on phones — the 85% cap left a dead strip on the
              // right and pushed drafts twice as far down (user, 2026-09-14).
              "max-w-full sm:max-w-[85%] rounded-2xl px-3 sm:px-4 py-2.5 text-sm whitespace-pre-wrap break-words",
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
      )}

      {error && <div className="mb-2 px-3 py-2 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-xs">{error}</div>}

      {/* A card with no chat row to open (already read, or an SMS link to a
          decided one) — shown on its own; "open chat" loads its thread. */}
      {openCard && !pending && (
        <div className="mb-2 max-h-[70vh] overflow-y-auto rounded-xl border border-[#c9dbfb] bg-white p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-bold text-[#34568a]">🕵️ Agent request</span>
            <div className="flex items-center gap-2">
              <button onClick={() => clickConv(convFromProposal(openCard))} className="text-[11px] text-[#0e8f88] hover:underline">open chat</button>
              <button onClick={() => setOpenCardId(null)} title="Close" className="p-0.5 rounded text-[#8595a8] hover:text-[#e11d48]"><X size={14} /></button>
            </div>
          </div>
          {/* Keyed by id: a card's typed reply must never carry over to the next card shown here. */}
          <ProposalCard key={openCard.id} p={openCard} focused={openCard.id === focusProposal} onPhase={(ph) => onCardPhase(openCard.id, ph)}
            reply={cardReplies[openCard.id]} onReplyChange={(v) => setCardReply(openCard.id, v)} />
        </div>
      )}

      {/* Reply composer — appears when a chat is clicked. Shows the full
          conversation, then a clearly-labelled note the AI reads before drafting.
          Scrolls itself when an agent card makes it taller than the screen. */}
      {pending && (
        <div className="mb-2 min-h-0 overflow-y-auto rounded-xl border border-[#a7e3df] bg-[#f7fdfc] p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#0e8f88] flex items-center gap-1.5">
              <MessageCircle size={13} /> {pending.contactName}{pending.channel ? ` · ${pending.channel}` : ""}
            </span>
            <button onClick={() => setPending(null)} title="Cancel" className="p-0.5 rounded text-[#8595a8] hover:text-[#e11d48]"><X size={14} /></button>
          </div>

          {/* Agent card(s) for this chat, on top so the plan is read before the
              thread. Admin only (convCards is empty for members). */}
          {isAdmin && proposing.has(pending.id) && convCards.length === 0 && (
            <p className="mb-2.5 rounded-lg border border-[#c9dbfb] bg-[#f7faff] px-3 py-2 text-[11px] text-[#34568a] flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> 🪄 The AI is reading this chat and drafting a plan (10–30 s) — nothing is sent until you Approve.
            </p>
          )}
          {convCards.length > 0 && (
            <div className="mb-2.5 space-y-2">
              {convCards.map((p) => (
                <ProposalCard key={p.id} p={p} focused={p.id === focusProposal} onPhase={(ph) => onCardPhase(p.id, ph)}
                  reply={cardReplies[p.id]} onReplyChange={(v) => setCardReply(p.id, v)} />
              ))}
            </div>
          )}

          {/* Full conversation thread (shorter when a card sits above it) */}
          <div ref={threadRef} className={cn("mb-2.5 overflow-y-auto rounded-lg border border-[#e4ebf2] bg-white p-2 space-y-1.5", convCards.length > 0 ? "max-h-[30vh]" : "max-h-[55vh]")}>
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
              📝 Note for the AI
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
              ✍️ Send a message yourself
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

      <form onSubmit={(e) => { e.preventDefault(); setShowActivity(false); send(input); }} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask anything — e.g. 'write me a Labor Day text blast' or 'how many leads does Sabby Beauty have?'"
          className="flex-1 px-4 py-3 bg-white border border-[#d7e0ea] rounded-xl text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}
          className="px-4 py-3 rounded-xl bg-[#15B7AE] hover:bg-[#0e8f88] text-white disabled:opacity-50 flex items-center gap-1.5 text-sm font-semibold">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </form>
    </div>
    </div>
  );
}

// ── CEO Agent (admin only) ───────────────────────────────────────────────────
// Client requests the scanner detected — or that someone handed over with 🪄
// — waiting for an explicit Approve/Deny. Since 2026-10-01 the cards live in
// the chat itself (next to their conversation) instead of a separate tab.
// Approve sends the (editable) reply and — phase 2, 2026-09-28 — runs the
// account change in the client's own sub-account through the GHL API,
// keeping a before → after line per step as proof. Steps the API cannot
// reach (pipeline stages, workflows) park the card as "needs a teammate".
// Nothing ever executes without a click on Approve.
type PlanStep = { type: string; [k: string]: unknown };
type AgentProposal = {
  id: string; created_at: string; conversation_id: string; contact_id: string | null;
  contact_name: string; channel: string | null;
  client_message: string; summary: string; action_type: "reply" | "account_change";
  proposed_reply: string | null; action_detail: string | null;
  status: string; decided_by: string | null; result: string | null;
  action_plan?: PlanStep[] | null; location_id?: string | null; notified_at?: string | null;
};
type ScanLog = { at: string; unread: number; scanned: number; filed: number; closed?: number; skipped: Array<{ who: string; why: string }>; errors: string[]; notify?: { sent: boolean; note: string } };
// What a card tells the page so it can keep the shared list in step.
type CardPhase = "approving" | "approved" | "denied" | "error" | "dismissed";

// Enough of a Conv to open a card's chat in the composer when that chat is
// not in the unread list (the thread endpoint only needs the id).
function convFromProposal(p: AgentProposal): Conv {
  return {
    id: p.conversation_id, contactId: p.contact_id, contactName: p.contact_name,
    lastMessageBody: "", lastMessageDate: null, unreadCount: 0,
    channel: p.channel ?? "", assignedTo: null, assignedToName: "",
  };
}

// Plain-English line per planned step (mirrors describeStep on the server).
function stepText(s: PlanStep): string {
  const D = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  switch (s.type) {
    case "custom_value_set": return `Set "${s.name}" to "${s.value}"`;
    case "calendar_block_dates": return `Block ${(s.dates as string[]).join(", ")}${s.calendar ? ` on "${s.calendar}"` : ""}`;
    case "calendar_hours_set": return `Hours${s.calendar ? ` on "${s.calendar}"` : ""}: ${(s.hours as Array<{ days: number[]; open: string; close: string }>).map((h) => `${h.days.map((d) => D[d]).join("/")} ${h.open}–${h.close}`).join(", ")}`;
    case "location_address_set": return `Address → ${[s.address1, s.city, s.state, s.postalCode].filter(Boolean).join(", ")}`;
    case "manual": return `Needs a teammate: ${s.what}`;
    default: return JSON.stringify(s);
  }
}
const STATUS_LABEL: Record<string, string> = { done: "done", denied: "denied", failed: "failed", queued_browser: "needs a teammate", handled: "handled in chat", pending: "pending" };

// The old Agent tab minus the cards (those sit next to their chats now): the
// SMS settings, what the last scan did and why it skipped chats, a short
// list of what's waiting, and the decided history. Opened from 🕵️ in the
// chats header; the data comes from the page so there is one list to refresh.
function AgentActivity({ proposals, lastScan, loading, err, onRefresh, onOpen, onClose }: {
  proposals: AgentProposal[]; lastScan: ScanLog | null; loading: boolean; err: string | null;
  onRefresh: () => void; onOpen: (p: AgentProposal) => void; onClose: () => void;
}) {
  const [showSkipped, setShowSkipped] = useState(false);
  const waiting = proposals.filter((p) => p.status === "pending");
  const history = proposals.filter((p) => p.status !== "pending");

  return (
    <div className="flex-1 overflow-y-auto space-y-3 pb-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-[#1f3559]">🕵️ Agent activity &amp; settings</span>
        <div className="flex items-center gap-1">
          <button onClick={onRefresh} disabled={loading} title="Refresh" className="p-1.5 rounded text-[#8595a8] hover:text-[#0e8f88] disabled:opacity-60">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} title="Back to chat" className="p-1.5 rounded text-[#8595a8] hover:text-[#e11d48]"><X size={14} /></button>
        </div>
      </div>
      <p className="text-xs text-[#697a91]">Client requests are checked every 10 minutes — or press 🪄 on any chat. Cards sit next to their chat (🕵️). <b>Nothing runs without your Approve.</b></p>
      <NotifySettingsBox />
      {lastScan && (
        <div className="text-[11px] text-[#8595a8] flex items-center gap-2 flex-wrap">
          <span>Last scan {timeAgo(lastScan.at)} ago · {lastScan.unread} unread chats · {lastScan.scanned} new checked · <b className="text-[#1f3559]">{lastScan.filed} filed</b>{lastScan.closed ? ` · ${lastScan.closed} closed (answered in chat)` : ""}{lastScan.notify?.sent ? " · you were texted" : ""}</span>
          {lastScan.skipped?.length > 0 && (
            <button onClick={() => setShowSkipped((s) => !s)} className="text-[#0e8f88] hover:underline">
              {showSkipped ? "hide" : "why skipped"} ({lastScan.skipped.length})
            </button>
          )}
          {lastScan.errors?.length > 0 && <span className="text-[#c2620a]">{lastScan.errors.length} error{lastScan.errors.length === 1 ? "" : "s"}</span>}
        </div>
      )}
      {showSkipped && lastScan && (
        <div className="rounded-lg border border-[#eef3f8] bg-white px-3 py-2 text-[11px] text-[#697a91] space-y-0.5">
          {lastScan.skipped.map((s, i) => <div key={i}><b className="text-[#1f3559]">{s.who}</b> — {s.why}</div>)}
          {lastScan.errors.map((e, i) => <div key={`e${i}`} className="text-[#c2620a]">⚠ {e}</div>)}
        </div>
      )}
      {err && <div className="px-3 py-2 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-xs">{err}</div>}
      {loading && proposals.length === 0 ? (
        <p className="text-xs text-[#8595a8] flex items-center gap-1.5 py-8 justify-center"><Loader2 size={13} className="animate-spin" /> Loading agent activity…</p>
      ) : (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8] mb-1">Waiting for you ({waiting.length})</div>
          {waiting.length === 0 ? (
            <p className="text-xs text-[#8595a8]">No pending requests — nothing needs you right now 🎉</p>
          ) : (
            <div className="space-y-1">
              {waiting.map((p) => (
                <button key={p.id} onClick={() => onOpen(p)}
                  className="w-full text-left rounded-lg border border-[#c9dbfb] bg-[#f7faff] px-3 py-2 text-[11px] text-[#697a91] hover:border-[#15B7AE]">
                  <span className="font-semibold text-[#1f3559]">{p.contact_name}</span> — {p.summary}
                  <span className="ml-1.5 text-[10px] text-[#a6b3c4]">{timeAgo(p.created_at)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {history.length > 0 && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8] mb-1 mt-4">History</div>
          <div className="space-y-1">
            {history.map((p) => (
              <div key={p.id} className="rounded-lg border border-[#eef3f8] bg-white px-3 py-2 text-[11px] text-[#697a91]">
                <span className={cn("font-bold mr-1.5", p.status === "denied" ? "text-[#e11d48]" : p.status === "failed" ? "text-[#c2620a]" : p.status === "queued_browser" ? "text-[#9a5b00]" : p.status === "handled" ? "text-[#34568a]" : "text-[#15803d]")}>
                  {STATUS_LABEL[p.status] ?? p.status}
                </span>
                <span className="font-semibold text-[#1f3559]">{p.contact_name}</span> — {p.summary}
                {p.result && <pre className="mt-1 whitespace-pre-wrap font-sans text-[#8595a8]">{p.result}</pre>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// "Text me when a request comes in" — the owner's number, saved once. The
// text goes out through the main account, so the owner becomes a contact
// there; the API does that and stores the contact id.
function NotifySettingsBox() {
  const [settings, setSettings] = useState<{ enabled: boolean; phone: string } | null | undefined>(undefined);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "toggle" | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    fetch("/api/agent/notify").then((r) => r.json()).then((j) => setSettings(j.settings ?? null)).catch(() => setSettings(null));
  }, []);
  const post = async (body: Record<string, unknown>, kind: "save" | "test" | "toggle", okMsg: string) => {
    setBusy(kind);
    try {
      const r = await fetch("/api/agent/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed");
      if (j.settings) setSettings(j.settings);
      toast.success(okMsg);
      if (kind === "save") { setPhone(""); setOpen(false); }
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally { setBusy(null); }
  };
  if (settings === undefined) return null;
  return (
    <div className={cn("rounded-lg border px-3 py-2 text-xs", settings?.enabled ? "border-[#bfe3cd] bg-[#f3fbf6]" : "border-[#fcd9a8] bg-[#fff7ec]")}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className={settings?.enabled ? "text-[#15803d]" : "text-[#9a5b00]"}>
          {settings ? (settings.enabled ? `📱 Texting you at ${settings.phone} when a request comes in` : `⏸ Texts paused (${settings.phone})`) : "⚠ Not texting you yet — add your mobile number so new requests reach you"}
        </span>
        <div className="flex items-center gap-1.5">
          {settings && (
            <>
              <button onClick={() => post({ enabled: !settings.enabled }, "toggle", settings.enabled ? "Texts paused" : "Texts resumed")} disabled={!!busy}
                className="px-2 py-1 rounded border border-[#d7e0ea] bg-white text-[#34568a] hover:border-[#15B7AE] disabled:opacity-50 flex items-center gap-1">
                {busy === "toggle" && <Loader2 size={11} className="animate-spin" />}{settings.enabled ? "Pause" : "Resume"}
              </button>
              <button onClick={() => post({ test: true }, "test", "Test text sent")} disabled={!!busy}
                className="px-2 py-1 rounded border border-[#d7e0ea] bg-white text-[#34568a] hover:border-[#15B7AE] disabled:opacity-50 flex items-center gap-1">
                {busy === "test" && <Loader2 size={11} className="animate-spin" />}Send test
              </button>
            </>
          )}
          <button onClick={() => setOpen((o) => !o)} className="px-2 py-1 rounded bg-[#15B7AE] text-white hover:bg-[#0e8f88]">
            {settings ? "Change number" : "Add my number"}
          </button>
        </div>
      </div>
      {open && (
        <form className="mt-2 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void post({ phone }, "save", "Saved — you'll be texted on the next request"); }}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Your mobile, e.g. 213-555-0100" inputMode="tel" autoFocus
            className="flex-1 px-2 py-1.5 bg-white border border-[#d7e0ea] rounded text-xs text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
          <button type="submit" disabled={!!busy || !phone.trim()} className="px-3 py-1.5 rounded bg-[#15803d] text-white disabled:opacity-50 flex items-center gap-1">
            {busy === "save" ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Save
          </button>
        </form>
      )}
    </div>
  );
}

function ProposalCard({ p, onPhase, focused, reply: keptReply, onReplyChange }: {
  p: AgentProposal; onPhase: (phase: CardPhase) => void; focused?: boolean;
  reply?: string; onReplyChange?: (v: string) => void;
}) {
  const [localReply, setLocalReply] = useState(p.proposed_reply ?? "");
  const reply = keptReply ?? localReply;
  const setReply = (v: string) => { setLocalReply(v); onReplyChange?.(v); };
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [outcome, setOutcome] = useState<{ status: string; result: string } | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const sensitive = (p.action_detail ?? "").startsWith("SENSITIVE:");
  const plan = p.action_plan ?? [];
  const manualOnly = plan.length > 0 && plan.every((s) => s.type === "manual");

  const decide = useCallback(async (decision: "approve" | "deny") => {
    if (busy) return;
    setBusy(decision);
    if (decision === "approve") onPhase("approving"); // pin before a refresh can drop it
    try {
      const res = await fetch("/api/agent/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id, decision, reply: decision === "approve" ? reply : undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      if (decision === "deny") { toast.success("Denied — nothing sent or changed"); onPhase("denied"); return; }
      // Keep the card up with the proof until the owner has read it.
      setOutcome({ status: json.status, result: json.result ?? "" });
      toast.success(json.status === "done" ? "Done — change made and reply sent" : json.status === "queued_browser" ? "Reply sent · a teammate must finish this one" : "Something failed — see the card");
      setBusy(null);
      onPhase("approved");
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
      setBusy(null);
      onPhase("error");
    }
  }, [busy, p.id, reply, onPhase]);

  // A card that was decided elsewhere (SMS link, another admin, a remount)
  // shows its stored result — never live Approve/Deny buttons again.
  const shown = outcome ?? (p.status !== "pending" ? { status: p.status, result: p.result ?? "" } : null);
  if (shown) {
    const ok = shown.status === "done";
    const label = ok ? "✅ done" : shown.status === "failed" ? "❌ failed" : shown.status === "queued_browser" ? "👤 needs a teammate" : STATUS_LABEL[shown.status] ?? shown.status;
    return (
      <div id={`proposal-${p.id}`} className={cn("rounded-xl border p-3", ok ? "border-[#bfe3cd] bg-[#f3fbf6]" : shown.status === "failed" ? "border-[#f5c2cf] bg-[#fffafb]" : shown.status === "queued_browser" ? "border-[#fcd9a8] bg-[#fff7ec]" : "border-[#e4ebf2] bg-white")}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-bold text-[#1f3559]">{p.contact_name} — {label}</span>
          <button onClick={() => onPhase("dismissed")} className="text-[11px] text-[#0e8f88] hover:underline">dismiss</button>
        </div>
        <p className="mt-1 text-xs text-[#697a91]">{p.summary}</p>
        {shown.result && <pre className="mt-2 whitespace-pre-wrap font-sans text-[12px] text-[#1f3559] bg-white/70 rounded-lg px-2.5 py-2 border border-black/5">{shown.result}</pre>}
      </div>
    );
  }

  // Compact by default (owner: "a lot of text, messy to track"): who, one
  // line of what they want, the steps, the reply. The raw message and the
  // AI's notes sit behind "details".
  const tag = sensitive ? "💰 money" : p.action_type === "account_change" ? (manualOnly ? "👤 teammate" : "🔧 change") : "💬 reply";
  return (
    <div id={`proposal-${p.id}`} className={cn("rounded-xl border p-3", sensitive ? "border-[#f5c2cf] bg-[#fffafb]" : "border-[#c9dbfb] bg-[#f7faff]", focused && "ring-2 ring-[#15B7AE]")}>
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold text-[#1f3559]">{p.contact_name}</span>
        <span className={cn("text-[10px] font-bold px-1.5 py-px rounded", sensitive ? "bg-[#fde8ee] text-[#9f1239]" : p.action_type === "account_change" ? "bg-[#fff1e0] text-[#c2410c]" : "bg-[#e3eefb] text-[#185fa5]")}>{tag}</span>
        <span className="ml-auto text-[10px] text-[#8595a8]">{timeAgo(p.created_at)}{p.channel ? ` · ${p.channel}` : ""}</span>
      </div>
      <p className="mt-1 text-sm text-[#1f3559]">{p.summary}</p>
      {plan.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[12px] text-[#34568a]">
          {plan.map((s, i) => (
            <li key={i} className="flex gap-1.5"><span className="text-[#8595a8]">{s.type === "manual" ? "👤" : "▸"}</span><span>{stepText(s)}</span></li>
          ))}
        </ul>
      )}
      <button onClick={() => setShowDetails((d) => !d)} className="mt-1.5 text-[11px] text-[#0e8f88] hover:underline">
        {showDetails ? "hide details" : "details"}
      </button>
      {showDetails && (
        <div className="mt-1 space-y-1.5 text-[12px] text-[#697a91]">
          <p className="border-l-2 border-[#d7e0ea] pl-2 whitespace-pre-wrap">&ldquo;{p.client_message}&rdquo;</p>
          {p.action_detail && <p>{p.action_detail.replace(/^SENSITIVE:\s*/, "")}</p>}
          <p className="text-[11px] text-[#8595a8]">
            {sensitive ? "Money involved: Approve sends the reply only, a teammate makes the change."
              : manualOnly ? "Not reachable by API: Approve sends the reply and marks it for a teammate."
              : p.action_type === "account_change" ? `Approve sends the reply, makes the change in ${p.contact_name}'s account, and shows before → after.`
              : "Approve sends the reply."}
            {p.notified_at ? " You were texted about this." : ""}
          </p>
        </div>
      )}
      <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Reply to the client (empty = send nothing)"
        className="w-full mt-2 px-3 py-2 text-sm text-[#1f3559] bg-white border border-[#c9dbfb] rounded-lg focus:outline-none focus:border-[#4f46e5] resize-none" />
      <div className="flex items-center gap-2 mt-2">
        <button onClick={() => decide("approve")} disabled={!!busy}
          className="px-3 py-1.5 rounded-lg bg-[#15803d] hover:bg-[#166534] text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy === "approve" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {busy === "approve" ? "Working…" : "Approve"}
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
  // When Send can't be offered, say why — a silently missing button reads as
  // "the feature was removed" (owner asked where it went, 2026-09-22).
  const noSendReason = canSend
    ? ""
    : d.channel === "Email" || d.channel === "Call"
      ? `${d.channel} can't be sent from here — open the chat in GHL`
      : "no contact id on this chat — open it in GHL to reply";
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
  // Whose real replies the draft copied — "0" means it fell back to a plain
  // style, which explains a draft that doesn't sound like anyone.
  const vi = d.voiceInfo;
  const voiceLine = !vi ? ""
    : vi.samplesUsed > 0 ? `Written in ${vi.name}'s voice · ${vi.samplesUsed} real ${vi.samplesUsed === 1 ? "reply" : "replies"}`
    : "No real replies found — plain style";
  return (
    <>
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
        <button onClick={() => { copy(); toast.success("Draft copied"); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#a7e3df] text-[#0e8f88] hover:bg-white text-xs font-semibold">
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </button>
        <button onClick={() => setManualOpen((o) => !o)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#c9dbfb] text-[#34568a] hover:bg-[#f7faff] text-xs font-semibold">
          <Pencil size={12} /> {manualOpen ? "Close editor" : "Edit"}
        </button>
        {canEdit && (
          <button onClick={() => setEditOpen((o) => !o)} disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#f0d9ae] text-[#c2620a] hover:bg-[#fffaf2] text-xs font-semibold disabled:opacity-50">
            <Sparkles size={12} /> AI edit
          </button>
        )}
        <span className="text-[10px] text-[#8595a8]">{canSend ? "nothing sends until you click Send" : noSendReason}</span>
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
    {voiceLine && <p className="mt-1 px-1 text-[10px] text-[#8595a8]">{voiceLine}</p>}
    </>
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
