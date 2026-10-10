"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles, ChevronDown, ChevronRight, Copy, Check, MessageCircle, RefreshCw, X, Pencil } from "lucide-react";
import { toast } from "sonner";
import { cn, userColor } from "@/lib/utils";
import { VoiceNoteButton } from "@/components/conversations/VoiceNoteButton";
import { WinbackList } from "@/components/conversations/WinbackList";

// voiceInfo only comes from /api/ghl/reply/draft — AI-chat drafts carry just
// the name, so the "written in …'s voice" line is skipped for those.
type VoiceInfo = { name: string; matched: boolean; samplesUsed: number; learnedFrom?: number; knowsClient?: boolean };
type Draft = { contactName: string; channel: string; draft: string; voice: string; voiceInfo?: VoiceInfo; conversationUrl: string; conversationId?: string; contactId?: string | null; inviteCall?: boolean; notes?: string[] };
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
type ThreadMsg = { id: string; direction: "inbound" | "outbound"; body: string; dateAdded: string | null; channel: string; attachments?: string[] };
// Media in a chat: voice notes get a player, photos a thumbnail, the rest a link.
const AUDIO_URL = /\.(mp3|m4a|aac|amr|wav|ogg|oga|opus|3gp)(\?|$)/i;
const IMAGE_URL = /\.(jpe?g|png|gif|webp|heic)(\?|$)/i;

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
  // 🔁 Win-back: admin-only list of the former clients we're bringing back.
  const [listView, setListView] = useState<"unread" | "winback">("unread");
  const [locationId, setLocationId] = useState<string>("");
  const [pending, setPending] = useState<Conv | null>(null); // chat awaiting a draft
  const [note, setNote] = useState("");                       // optional steer for the AI
  // "📞 Invite to a strategy call" — OFF by default, per chat. The AI never
  // adds a call invite or link on its own (owner, 2026-10-01).
  const [inviteCall, setInviteCall] = useState(false);
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
  const [schedTick, setSchedTick] = useState(0); // reloads the open chat's "Scheduled" list
  const [composerSchedBusy, setComposerSchedBusy] = useState(false);
  // ── CEO Agent, merged into the chat (owner request 2026-10-01) ──
  // Admin only. Cards live next to their conversation instead of a separate
  // tab; nothing runs until someone opens the card and clicks Approve.
  const [proposals, setProposals] = useState<AgentProposal[]>([]);
  const [lastScan, setLastScan] = useState<ScanLog | null>(null);
  const [workerBeat, setWorkerBeat] = useState<WorkerBeat>(null);
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
  // Edited payment-link amounts, kept per card for the same reason.
  const [cardAmounts, setCardAmounts] = useState<Record<string, string>>({});
  const setCardAmount = useCallback((id: string, v: string) => setCardAmounts((m) => ({ ...m, [id]: v })), []);
  const [showActivity, setShowActivity] = useState(false);            // "Agent activity & settings" in the main area
  // The open chat's agent panel starts CLOSED (owner, 2026-10-01: "I don't
  // want it, by default, to just open up"). Opening a chat shows one small
  // button; only clicking it runs the AI or shows its plan.
  const [agentOpenFor, setAgentOpenFor] = useState<string | null>(null);
  // Approves still running, by card id. Kept here, not in the card, so a
  // card hidden and re-opened mid-run still shows "Working…" instead of a
  // live Approve that would text the client twice.
  const [approvingIds, setApprovingIds] = useState<Set<string>>(new Set());
  const approvingRef = useRef<Set<string>>(new Set());
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
      else {
        // No SMS link to open — so the first in-app focus (a 🪄 plan
        // landing) isn't mistaken for one and re-opened / re-checked.
        deepLinkDone.current = true;
        if (q.get("view") === "agent") setShowActivity(true); // old inbox link → the activity view
      }
    } catch { deepLinkDone.current = true; /* no query string */ }
  }, []);

  // One list load at a time: a timer tick or tab-return while a load is still
  // running just waits for that one (a manual load still goes through).
  const convsInFlight = useRef(false);
  const loadConvs = useCallback(async (opts?: { silent?: boolean }) => {
    if (opts?.silent && convsInFlight.current) return;
    convsInFlight.current = true;
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
      convsInFlight.current = false;
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
      setWorkerBeat(json.worker ?? null);
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

  // Keep the inbox fresh for the team: silently re-fetch every 25s while the
  // page is visible, and right away when someone comes back to the tab, so new
  // client messages appear without a manual refresh. Agent cards ride the same
  // timer so the 🕵️ row badges stay current.
  useEffect(() => {
    let lastRun = 0;
    const refresh = () => {
      // Coming back to the tab fires both "visible" and "focus" — run once.
      if (document.visibilityState !== "visible" || Date.now() - lastRun < 5_000) return;
      lastRun = Date.now();
      loadConvs({ silent: true });
      if (role === "admin") loadProposals({ silent: true });
    };
    const t = setInterval(refresh, 25_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [loadConvs, loadProposals, role]);

  const sendManual = useCallback(async () => {
    if (!pending?.contactId || !sendText.trim() || sending || composerSchedBusy) return;
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
  }, [pending, sendText, sending, composerSchedBusy, loadConvs]);

  // Agent cards are admin-only — members never fetch (or see) them.
  useEffect(() => {
    if (role === "admin") loadProposals();
  }, [role, loadProposals]);

  // Closing the composer (X, Send, Generate draft, 🕵️) closes its agent
  // panel, so coming back to the chat starts with the one button again.
  useEffect(() => { if (!pending) setAgentOpenFor(null); }, [pending]);

  // Load the full conversation whenever the composer opens for a chat (and
  // again after a voice note goes out, so it shows up in the thread).
  const [threadTick, setThreadTick] = useState(0);
  const reloadThread = useCallback(() => setThreadTick((t) => t + 1), []);
  const threadFor = useRef<string | null>(null);
  useEffect(() => {
    if (!pending) { setThread([]); threadFor.current = null; return; }
    let cancelled = false;
    // A reload of the same chat keeps showing it; another chat starts empty.
    setThreadLoading(true);
    if (threadFor.current !== pending.id) { setThread([]); threadFor.current = pending.id; }
    fetch(`/api/ghl/reply/thread?conversationId=${encodeURIComponent(pending.id)}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setThread(j.messages ?? []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setThreadLoading(false); });
    return () => { cancelled = true; };
  }, [pending, threadTick]);

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
    setAgentOpenFor((cur) => (cur === c.id ? cur : null)); // another chat starts closed
    setNote("");
    setInviteCall(false);
    setSendText("");
    setPending(c);
  }, []);

  // What the composer holds right now, readable from async 🪄 callbacks: a
  // card that lands 20 s later must not wipe a reply someone is typing.
  const composerRef = useRef<{ id: string | null; dirty: boolean }>({ id: null, dirty: false });
  useEffect(() => {
    composerRef.current = { id: pending?.id ?? null, dirty: !!(note.trim() || sendText.trim()) };
  }, [pending, note, sendText]);

  // 🪄 "Let AI handle it" (inside the open chat): files (or returns the open)
  // card for this chat. It only PROPOSES — the card still needs Approve.
  const proposeFor = useCallback(async (c: Conv, opts: { fresh?: boolean } = {}) => {
    // Always ask the server: it hands back the open card when nothing new has
    // arrived, and re-reads the chat when the client wrote since.
    if (proposingRef.current.has(c.id)) return;
    proposingRef.current.add(c.id);
    setProposing(new Set(proposingRef.current));
    try {
      const res = await fetch("/api/agent/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: c.id, contactId: c.contactId, contactName: c.contactName, channel: c.channel, fresh: opts.fresh === true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.proposal) throw new Error(json.error || "The AI couldn't take this one");
      const p = json.proposal as AgentProposal;
      proposalsReq.current++; // any in-flight refresh predates this card
      setProposals((list) => [p, ...list.filter((x) => x.id !== p.id)]);
      // The server retires a plan written before newer texts — pick that up.
      if (p.id && proposals.some((x) => x.conversation_id === c.id && x.status === "pending" && x.id !== p.id)) void loadProposals({ silent: true });
      if (composerRef.current.id === c.id) {
        focusCard(p.id);
        setAgentOpenFor(c.id);
        setShowActivity(false);
        setOpenCardId(null);
      } else {
        // They moved on while the AI worked — don't yank them back.
        toast.success(`AI plan ready for ${c.contactName}`, {
          action: { label: "Open", onClick: () => { focusCard(p.id); clickConv(c); setAgentOpenFor(c.id); } },
        });
      }
    } catch (e) {
      toast.error(`${c.contactName}: ${`${e}`.replace("Error: ", "")}`);
    } finally {
      proposingRef.current.delete(c.id);
      setProposing(new Set(proposingRef.current));
    }
  }, [clickConv, focusCard, proposals, loadProposals]);

  // Open a chat's agent panel. A pending plan is re-checked on the way in
  // (the server hands it back unchanged when nothing new arrived, or retires
  // it and re-plans when the client wrote since), so every way in — the
  // button, the SMS link, the activity list, "open chat" — shows a plan that
  // still matches the chat. Approve stays disabled while it checks.
  const showAgent = useCallback((c: Conv) => {
    setAgentOpenFor(c.id);
    const here = proposals.filter((p) => p.conversation_id === c.id && p.status === "pending");
    if (here.length) {
      if (here.some((p) => !approvingRef.current.has(p.id))) void proposeFor(c);
      return;
    }
    // Only an approved card's proof is here ("See what the AI did") — show
    // it; a new plan is one click away ("re-read chat").
    if (proposals.some((p) => p.conversation_id === c.id && pinned.has(p.id))) return;
    void proposeFor(c);
  }, [proposals, proposeFor, pinned]);

  // Show a card. A pending one opens in its chat (re-checked), even when the
  // chat is no longer unread — reading the SMS in GHL marks it read, and a
  // card shown on its own would skip the re-check. Already-decided cards
  // (an SMS link opened late) go on their own, read-only.
  const openProposal = useCallback((p: AgentProposal) => {
    focusCard(p.id);
    const c = p.status === "pending" && !isTask(p) ? convs.find((x) => x.id === p.conversation_id) ?? convFromProposal(p) : undefined;
    if (c) {
      if (composerRef.current.id !== c.id) clickConv(c);
      else { setShowActivity(false); setShowChats(false); }
      showAgent(c); // asked for this card by name — show it (re-checked)
      return;
    }
    setPending(null);
    setShowActivity(false);
    setShowChats(false);
    setOpenCardId(p.id);
  }, [convs, clickConv, focusCard, showAgent]);

  // Card lifecycle → list upkeep. Approving pins the card so its proof stays
  // up through the refresh; deny / dismiss / a failed request let it go.
  const onCardPhase = useCallback((id: string, phase: CardPhase) => {
    if (phase === "approving") {
      approvingRef.current.add(id);
      setApprovingIds(new Set(approvingRef.current));
      setPinned((s) => new Set(s).add(id));
      return;
    }
    if (approvingRef.current.delete(id)) setApprovingIds(new Set(approvingRef.current));
    if (phase !== "approved") {
      setPinned((s) => { const n = new Set(s); n.delete(id); return n; });
      if (phase !== "error") {
        setOpenCardId((cur) => (cur === id ? null : cur));
        // Denied or dismissed — back to the one button, unless another
        // card is mid-Approve (its "Working…" must stay on screen).
        if (approvingRef.current.size === 0) setAgentOpenFor(null);
      }
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
  const generateDraft = useCallback(async (c: Conv, steer: string, call = false) => {
    if (busy) return;
    setPending(null);
    const trimmed = steer.trim();
    const label = `Draft a reply to ${c.contactName}${trimmed ? ` — note: ${trimmed}` : ""}${call ? " · 📞 invite to a strategy call" : ""}`;
    setMsgs((m) => [...m, { role: "user", content: label }]);
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/ghl/reply/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: c.id, contactName: c.contactName, contactId: c.contactId, instructions: trimmed || undefined, inviteCall: call }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to draft a reply");
      const voice = json.voice?.name ?? "";
      const draft: Draft = { contactName: c.contactName, channel: c.channel, draft: json.draft, voice, voiceInfo: json.voice ?? undefined, conversationUrl: chatUrl(c), conversationId: c.id, contactId: c.contactId, inviteCall: call, notes: trimmed ? [trimmed] : [] };
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
      /* Owner, 2026-10-04: an edit dropped the "Mon–Fri 9am–5pm" he asked for
         in the first note. Every earlier note travels with each edit as a
         must-keep list, and only the newest change is applied. */
      const earlier = (d.notes ?? []).filter(Boolean);
      const instructions = [
        `You already wrote this draft:\n"""\n${d.draft}\n"""`,
        earlier.length ? `Earlier notes for this reply — every point in them MUST still be in the new version:\n${earlier.map((n) => `- ${n}`).join("\n")}` : "",
        `Now apply ONLY this change: ${change}`,
        "Keep every other sentence and fact of the draft as it is. Do not drop anything to make room — the reply may get longer.",
      ].filter(Boolean).join("\n\n");
      const res = await fetch("/api/ghl/reply/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: d.conversationId, contactName: d.contactName, contactId: d.contactId ?? null, instructions, inviteCall: !!d.inviteCall, revise: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to update the draft");
      const voice = json.voice?.name ?? d.voice;
      const draft: Draft = { ...d, draft: json.draft, voice, voiceInfo: json.voice ?? d.voiceInfo, notes: [...(d.notes ?? []), change] };
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
  // The open chat's cards; approved ones stay (pinned) to show their proof.
  const convCards = isAdmin && pending
    ? proposals.filter((p) => p.conversation_id === pending.id && (p.status === "pending" || pinned.has(p.id)))
    : [];
  const agentOpen = isAdmin && !!pending && agentOpenFor === pending.id;
  const approvingHere = convCards.some((p) => approvingIds.has(p.id));
  const checkingHere = !!pending && proposing.has(pending.id);
  // The thread gets shorter when the panel opens — keep the newest messages
  // (the ones the plan is about) in view.
  const shortThread = agentOpen && convCards.length > 0;
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shortThread]);
  const openCard = isAdmin && openCardId ? proposals.find((p) => p.id === openCardId) ?? null : null;

  const chatList = (
    <>
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#eef3f8]">
        {isAdmin ? (
          <div className="flex items-center gap-0.5 text-xs font-bold">
            <button onClick={() => setListView("unread")}
              className={cn("px-1.5 py-0.5 rounded flex items-center gap-1", listView === "unread" ? "bg-[#e6f7f5] text-[#1f3559]" : "text-[#8595a8] hover:bg-[#f7fdfc]")}>
              <MessageCircle size={13} className="text-[#15B7AE]" /> Unread {shownConvs.length > 0 && <span className="px-1.5 rounded-full bg-[#fde8ee] text-[#e11d48] text-[10px] font-bold">{shownConvs.length}</span>}
            </button>
            <button onClick={() => setListView("winback")} title="Former clients we're bringing back"
              className={cn("px-1.5 py-0.5 rounded", listView === "winback" ? "bg-[#e6f7f5] text-[#1f3559]" : "text-[#8595a8] hover:bg-[#f7fdfc]")}>
              🔁 Win-back
            </button>
          </div>
        ) : (
          <span className="text-xs font-bold text-[#1f3559] flex items-center gap-1.5"><MessageCircle size={13} className="text-[#15B7AE]" /> Your unread chats {shownConvs.length > 0 && <span className="px-1.5 rounded-full bg-[#fde8ee] text-[#e11d48] text-[10px] font-bold">{shownConvs.length}</span>}</span>
        )}
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
      {isAdmin && listView === "winback" ? (
        <WinbackList activeId={pending?.id ?? null} disabled={busy} onOpen={(c) => clickConv(c)} />
      ) : (<>
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
            // No AI button on the row (owner, 2026-10-01: not a one-click
            // start) — open the chat first, the AI button is inside it.
            <button key={c.id} onClick={() => clickConv(c)} disabled={busy}
              className={cn("w-full text-left px-3 py-2.5 border-b border-[#f1f5f9] hover:bg-[#f7fdfc] transition-colors disabled:opacity-50", pending?.id === c.id && "bg-[#f0fbfa]")}>
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
                  <span title="The AI has a plan for this chat — open it to review" className="px-1 rounded bg-[#e3eefb] text-[#185fa5] text-[9px] font-bold">🕵️ plan</span>
                )}
              </div>
            </button>
          ))
        )}
      </div>
      <p className="px-3 py-2 border-t border-[#eef3f8] text-[9px] text-[#a6b3c4]">
        {isAdmin
          ? "Click a chat → draft a reply, or 🪄 let the AI handle it (you approve first)"
          : "Click a chat → add an optional note → the AI drafts a reply in your voice"}
      </p>
      </>)}
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
        <AgentActivity proposals={proposals} lastScan={lastScan} worker={workerBeat} loading={proposalsLoading} err={proposalsErr}
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
              {!isTask(openCard) && <button onClick={() => {
                const c = convFromProposal(openCard);
                clickConv(c);
                if (openCard.status === "pending") showAgent(c);
                else if (pinned.has(openCard.id)) setAgentOpenFor(c.id); // approved here — show its proof
              }} className="text-[11px] text-[#0e8f88] hover:underline">open chat</button>}
              <button onClick={() => setOpenCardId(null)} title="Close" className="p-0.5 rounded text-[#8595a8] hover:text-[#e11d48]"><X size={14} /></button>
            </div>
          </div>
          {/* Keyed by id: a card's typed reply must never carry over to the next card shown here. */}
          <ProposalCard key={openCard.id} p={openCard} focused={openCard.id === focusProposal} onPhase={(ph) => onCardPhase(openCard.id, ph)}
            reply={cardReplies[openCard.id]} onReplyChange={(v) => setCardReply(openCard.id, v)}
            amounts={cardAmounts[openCard.id]} onAmountsChange={(v) => setCardAmount(openCard.id, v)} working={approvingIds.has(openCard.id)} />
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

          {/* The AI agent for this chat — admin only. Closed by default: one
              small button. Clicking it shows the plan (or asks the AI for one);
              nothing is sent or changed until Approve on the card. */}
          {isAdmin && !agentOpen && (
            <button onClick={() => showAgent(pending)}
              className="mb-2.5 px-2.5 py-1 rounded-lg border border-[#c9dbfb] bg-white text-[11px] font-semibold text-[#34568a] hover:border-[#15B7AE] hover:text-[#0e8f88] flex items-center gap-1.5">
              {checkingHere
                ? <><Loader2 size={11} className="animate-spin" /> The AI is reading this chat…</>
                : convCards.some((p) => p.status === "pending") ? "🕵️ The AI has a plan — review"
                : convCards.length > 0 ? "🕵️ See what the AI did"
                : "🪄 Let AI handle it"}
            </button>
          )}
          {agentOpen && (
            <div className="mb-2.5 rounded-lg border border-[#c9dbfb] bg-[#f7faff] p-2">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-[11px] font-bold text-[#34568a]">🪄 AI agent · nothing happens until you Approve</span>
                <span className="flex items-center gap-2.5">
                  {convCards.length > 0 && (checkingHere
                    ? <span className="text-[11px] text-[#8595a8] flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> checking for new messages…</span>
                    : !approvingHere && <button onClick={() => proposeFor(pending, { fresh: true })} title="Read the chat again and write a new plan" className="text-[11px] text-[#0e8f88] hover:underline">re-read chat</button>)}
                  <button onClick={() => setAgentOpenFor(null)} disabled={approvingHere}
                    title={approvingHere ? "Wait for the Approve to finish" : undefined}
                    className="text-[11px] text-[#0e8f88] hover:underline disabled:opacity-40 disabled:no-underline">hide</button>
                </span>
              </div>
              {convCards.length > 0 ? (
                <div className="space-y-2">
                  {convCards.map((p) => (
                    <ProposalCard key={p.id} p={p} focused={p.id === focusProposal} onPhase={(ph) => onCardPhase(p.id, ph)}
                      reply={cardReplies[p.id]} onReplyChange={(v) => setCardReply(p.id, v)}
                      amounts={cardAmounts[p.id]} onAmountsChange={(v) => setCardAmount(p.id, v)}
                      working={approvingIds.has(p.id)} checking={checkingHere} />
                  ))}
                </div>
              ) : checkingHere ? (
                <p className="text-[11px] text-[#34568a] flex items-center gap-1.5 py-1">
                  <Loader2 size={12} className="animate-spin" /> Reading this chat and writing a plan (10–30 s)…
                </p>
              ) : (
                <p className="text-[11px] text-[#697a91] py-1">
                  No plan yet. <button onClick={() => proposeFor(pending)} className="text-[#0e8f88] font-semibold hover:underline">Ask the AI</button>
                </p>
              )}
            </div>
          )}

          {/* Full conversation thread (shorter when the agent panel is open) */}
          <div ref={threadRef} className={cn("mb-2.5 overflow-y-auto rounded-lg border border-[#e4ebf2] bg-white p-2 space-y-1.5", agentOpen && convCards.length > 0 ? "max-h-[30vh]" : "max-h-[55vh]")}>
            {threadLoading && thread.length === 0 ? (
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
                    {(m.attachments ?? []).map((u) => (
                      AUDIO_URL.test(u) ? <audio key={u} controls preload="none" src={u} className={cn("h-8 max-w-[240px]", m.body && "mt-1")} />
                        : IMAGE_URL.test(u) ? (
                          <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="block mt-1">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={u} alt="attachment" className="max-h-40 rounded-md" />
                          </a>
                        ) : <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="block mt-1 text-[11px] underline">📎 attachment</a>
                    ))}
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
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); generateDraft(pending, note, inviteCall); } }}
              rows={2}
              autoFocus
              placeholder="e.g. 'let her know Tue 2pm is open' or 'gently ask for the $50 deposit'. Leave blank for a standard draft."
              className="w-full px-3 py-2 text-sm text-[#1f3559] bg-white border border-[#f0d9ae] rounded-lg focus:outline-none focus:border-[#f0a742] resize-none"
            />
          </div>

          <div className="flex items-center gap-2 mt-2">
            <button onClick={() => generateDraft(pending, note, inviteCall)} disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Generate draft
            </button>
            {/* Off by default: the AI never invites to a call by itself. */}
            <label className={cn("flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] font-semibold cursor-pointer select-none",
              inviteCall ? "border-[#15B7AE] bg-[#e6f7f5] text-[#0e8f88]" : "border-[#e4ebf2] bg-white text-[#697a91]")}>
              <input type="checkbox" checked={inviteCall} onChange={(e) => setInviteCall(e.target.checked)} className="accent-[#15B7AE]" />
              📞 Invite to a strategy call
            </label>
            <span className="text-[10px] text-[#8595a8] hidden sm:inline">⌘/Ctrl+Enter to generate</span>
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
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <button onClick={sendManual} disabled={sending || composerSchedBusy || !sendText.trim() || !pending.contactId}
                className="px-3 py-1.5 rounded-lg bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
                {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send to {pending.contactName}
              </button>
              {pending.contactId && pending.channel !== "Email" && pending.channel !== "Call" && (
                <ScheduleControl contactId={pending.contactId} contactName={pending.contactName} channel={pending.channel}
                  text={sendText} disabled={!sendText.trim() || sending}
                  onScheduled={() => { setSendText(""); setSchedTick((t) => t + 1); }} onBusyChange={setComposerSchedBusy} />
              )}
              <span className="text-[10px] text-[#8595a8]">{pending.contactId ? "⌘/Ctrl+Enter to send" : "no contact id — open the chat in GHL"}</span>
              {/* Keyed by chat: switching chats throws away a half-made recording. */}
              <VoiceNoteButton key={pending.id} contactId={pending.contactId ?? null} contactName={pending.contactName} channel={pending.channel}
                onSent={() => { reloadThread(); loadConvs(); }} />
            </div>
            {pending.contactId && <ScheduledList contactId={pending.contactId} refreshKey={schedTick} />}
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
// Approve never texts the client (owner, 2026-10-10) — phase 2 runs the
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
  screenshots?: Array<{ name: string; url: string }> | null;
};
// Typed by a teammate on the Agent panel — no chat behind it.
const isTask = (p: { conversation_id: string }) => p.conversation_id.startsWith("task:");
type WorkerBeat = { at: string; host?: string } | null;
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
    case "calendar_slots_set": {
      const t12 = (x: string) => { const [h, m] = x.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`; };
      return `Calendar${s.calendar ? ` "${s.calendar}"` : ""}: open ${(s.days as number[]).map((d) => D[d]).join("/")} only, appointments at ${(s.times as string[]).map(t12).join(", ")}${s.max_per_day ? `, max ${s.max_per_day} a day` : ""}`;
    }
    case "calendar_max_per_day": return `Calendar${s.calendar ? ` "${s.calendar}"` : ""}: max ${s.max} appointments a day`;
    case "location_address_set": return `Address → ${[s.address1, s.city, s.state, s.postalCode].filter(Boolean).join(", ")}`;
    case "manual": return String(s.what);
    case "payment_links": {
      const a = (s.amounts_cents as number[]) ?? [];
      return `Create ${a.length === 1 ? "a Square payment link" : `${a.length} Square payment links`} (${a.map(money).join(" · ")}) for "${s.label}" and add ${a.length === 1 ? "it" : "them"} to the reply`;
    }
    default: return JSON.stringify(s);
  }
}

/* Square payment links on a card (mirrors withPaymentLinks on the server):
   "{{pay_link_N}}" lines under the reply until Approve makes the real links. */
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const linkLines = (cents: number[]) => cents.map((c, i) => `${cents.length > 1 ? `Payment ${i + 1} of ${cents.length} — ` : ""}${money(c)}: 🔗 link ${i + 1}`);
const stripLinkLines = (t: string) => t.split("\n").filter((l) => !/\{\{pay_link_\d+\}\}/.test(l)).join("\n").trimEnd();
/* "100, 150, 150" / "$100 / $150" → [10000, 15000, 15000]; "1,500" is one
   amount ($1,500). null when anything is off. */
function parseAmounts(text: string): number[] | null {
  const parts = text.replace(/(\d),(\d{3})(?!\d)/g, "$1$2").split(/[,/+\s]+/).map((t) => t.replace(/^\$/, "")).filter(Boolean);
  if (!parts.length || parts.length > 6) return null;
  const cents = parts.map((t) => Math.round(Number(t) * 100));
  return cents.every((c) => Number.isInteger(c) && c >= 100 && c <= 1_000_000) ? cents : null;
}
const STATUS_LABEL: Record<string, string> = { done: "done", denied: "denied", failed: "failed", queued_browser: "waiting for the Mac Mini", running: "Mac Mini working…", needs_teammate: "needs a teammate", handled: "handled in chat", pending: "pending" };

// The old Agent tab minus the cards (those sit next to their chats now): the
// SMS settings, what the last scan did and why it skipped chats, a short
// list of what's waiting, and the decided history. Opened from 🕵️ in the
// chats header; the data comes from the page so there is one list to refresh.
function AgentActivity({ proposals, lastScan, worker, loading, err, onRefresh, onOpen, onClose }: {
  proposals: AgentProposal[]; lastScan: ScanLog | null; worker: WorkerBeat; loading: boolean; err: string | null;
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
      <p className="text-xs text-[#697a91]">Client requests are checked every 10 minutes — or open a chat and press 🪄 Let AI handle it. Chats with a plan show 🕵️. <b>Nothing runs without your Approve, and the agent never texts clients.</b> Approved changes are done by the Mac Mini in GoHighLevel, with screenshots.</p>
      {(() => {
        const online = !!worker && Date.now() - Date.parse(worker.at) < 3 * 60_000;
        const queued = proposals.filter((p) => p.status === "queued_browser" || p.status === "running").length;
        return (
          <div className={cn("rounded-lg border px-3 py-2 text-xs", online ? "border-[#bfe3cd] bg-[#f3fbf6] text-[#15803d]" : "border-[#f5c2cf] bg-[#fffafb] text-[#b91c1c]")}>
            🖥️ {online ? `Mac Mini online (checked in ${timeAgo(worker!.at)} ago)` : worker ? `Mac Mini OFFLINE — last seen ${timeAgo(worker.at)} ago` : "Mac Mini not connected yet"}
            {queued > 0 && <span className="text-[#697a91]"> · {queued} task{queued === 1 ? "" : "s"} in its queue</span>}
          </div>
        );
      })()}
      <NewTaskBox onCreated={onRefresh} />
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
                <span className={cn("font-bold mr-1.5", p.status === "denied" ? "text-[#e11d48]" : p.status === "failed" ? "text-[#c2620a]" : p.status === "queued_browser" || p.status === "running" || p.status === "needs_teammate" ? "text-[#9a5b00]" : p.status === "handled" ? "text-[#34568a]" : "text-[#15803d]")}>
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

/* A task typed by a teammate (owner, 2026-10-10: "if my team member asks for
   that request, it can do it as well"). It becomes a normal card — still
   needs Approve — and the Mac Mini does it in GoHighLevel. */
function NewTaskBox({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [client, setClient] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !client.trim() || !task.trim()) return;
    setBusy(true);
    try {
      const r = await fetch("/api/agent/task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client, task }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed");
      toast.success(`Task added for ${j.client} — approve it under "Waiting for you"`);
      setClient(""); setTask(""); setOpen(false);
      onCreated();
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally { setBusy(false); }
  };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="w-full rounded-lg border border-dashed border-[#c9dbfb] bg-white px-3 py-2 text-xs font-semibold text-[#34568a] hover:border-[#15B7AE] text-left">
        ➕ New task for the AI (e.g. &ldquo;Add a &lsquo;Later date&rsquo; stage before Declining in Tammy&apos;s pipeline&rdquo;)
      </button>
    );
  }
  return (
    <form className="rounded-lg border border-[#c9dbfb] bg-[#f7faff] p-2.5 space-y-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Client — owner or business name" autoFocus
        className="w-full px-2 py-1.5 bg-white border border-[#d7e0ea] rounded text-xs text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
      <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} placeholder="What should be done in their GoHighLevel account? Be specific."
        className="w-full px-2 py-1.5 bg-white border border-[#d7e0ea] rounded text-xs text-[#1f3559] focus:outline-none focus:border-[#15B7AE] resize-none" />
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !client.trim() || !task.trim()} className="px-3 py-1.5 rounded bg-[#15803d] text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1">
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Add task
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-[#697a91] hover:underline">cancel</button>
        <span className="ml-auto text-[10px] text-[#8595a8]">Nothing runs until it&apos;s approved</span>
      </div>
    </form>
  );
}

// "Text me when a request comes in" — the owner's number, saved once. The
// text goes out through the main account, so the owner becomes a contact
// there; the API does that and stores the contact id.
function NotifySettingsBox() {
  const [settings, setSettings] = useState<{ enabled: boolean; phone: string; newCards?: boolean } | null | undefined>(undefined);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "toggle" | "cards" | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    fetch("/api/agent/notify").then((r) => r.json()).then((j) => setSettings(j.settings ?? null)).catch(() => setSettings(null));
  }, []);
  const post = async (body: Record<string, unknown>, kind: "save" | "test" | "toggle" | "cards", okMsg: string) => {
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
          {settings ? (settings.enabled ? `📱 Texting you at ${settings.phone} after each fix${settings.newCards ? " and when a request comes in" : ""}` : `⏸ Texts paused (${settings.phone})`) : "⚠ Add your mobile number to get a confirmation text after each fix"}
        </span>
        <div className="flex items-center gap-1.5">
          {settings && (
            <>
              <label className="flex items-center gap-1 text-[#34568a] cursor-pointer">
                <input type="checkbox" checked={!!settings.newCards} disabled={!!busy}
                  onChange={(e) => post({ newCards: e.target.checked }, "cards", e.target.checked ? "You'll also be texted about new requests" : "Confirmations only")} />
                {busy === "cards" && <Loader2 size={11} className="animate-spin" />}new requests too
              </label>
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
        <form className="mt-2 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void post({ phone }, "save", "Saved — you'll get a text after the next fix"); }}>
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

function ProposalCard({ p, onPhase, focused, reply: keptReply, amounts: keptAmounts, onAmountsChange, working, checking }: {
  p: AgentProposal; onPhase: (phase: CardPhase) => void; focused?: boolean;
  reply?: string; onReplyChange?: (v: string) => void;
  amounts?: string; onAmountsChange?: (v: string) => void;
  working?: boolean;  // an Approve for this card is still running (page-level)
  checking?: boolean; // the chat is being re-read — this plan may be replaced
}) {
  const [localReply] = useState(stripLinkLines(p.proposed_reply ?? ""));
  const reply = keptReply ?? localReply;
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [outcome, setOutcome] = useState<{ status: string; result: string } | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const sensitive = (p.action_detail ?? "").startsWith("SENSITIVE:");
  const plan = p.action_plan ?? [];
  // Payment links: amounts editable on the card; the reply's link lines follow.
  const linkStep = plan.find((s) => s.type === "payment_links") ?? null;
  const plannedCents = (linkStep?.amounts_cents as number[] | undefined) ?? [];
  const [localAmounts, setLocalAmounts] = useState(() => plannedCents.map((c) => String(c / 100)).join(", "));
  const amountsText = keptAmounts ?? localAmounts;
  const onAmounts = (v: string) => { setLocalAmounts(v); onAmountsChange?.(v); };
  const editedCents = linkStep ? parseAmounts(amountsText) : null;
  const billCents = (linkStep?.bill_cents as number | null | undefined) ?? null;
  const billPaid = /\bpaid\b/i.test(String(linkStep?.bill_status ?? ""));
  const needsMessage = false; // the team writes the reply; links are copied into it

  const decide = useCallback(async (decision: "approve" | "deny") => {
    if (busy || working || checking) return;
    setBusy(decision);
    if (decision === "approve") onPhase("approving"); // pin before a refresh can drop it
    try {
      const res = await fetch("/api/agent/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: p.id, decision, reply: decision === "approve" ? reply : undefined,
          // Always the amounts on screen — the server re-checks them.
          ...(decision === "approve" && linkStep && editedCents ? { links: { label: linkStep.label, amounts_cents: editedCents } } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      if (decision === "deny") { toast.success("Denied — nothing sent or changed"); onPhase("denied"); return; }
      // Keep the card up with the proof until the owner has read it.
      setOutcome({ status: json.status, result: json.result ?? "" });
      toast.success(json.status === "queued_browser" ? "Approved — the Mac Mini will do it and send screenshots" : json.status === "done" ? "Done (nothing texted to the client)" : json.status === "needs_teammate" ? "A teammate must do this one by hand" : "Something failed — see the card");
      setBusy(null);
      onPhase("approved");
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
      setBusy(null);
      onPhase("error");
    }
  }, [busy, working, checking, p.id, reply, onPhase, linkStep, editedCents]);

  // A card that was decided elsewhere (SMS link, another admin, a remount)
  // shows its stored result — never live Approve/Deny buttons again.
  // The stored card wins once it's decided — it keeps moving (queued →
  // Mac Mini working → done) and the page refreshes it every 25 s.
  const shown = p.status !== "pending" ? { status: p.status, result: p.result ?? "" } : outcome;
  if (shown) {
    const ok = shown.status === "done";
    const label = ok ? "✅ done" : shown.status === "failed" ? "❌ failed" : shown.status === "queued_browser" ? "⏳ waiting for the Mac Mini" : shown.status === "running" ? "🖥️ Mac Mini working…" : shown.status === "needs_teammate" ? "👤 needs a teammate" : STATUS_LABEL[shown.status] ?? shown.status;
    const shots = p.screenshots ?? [];
    return (
      <div id={`proposal-${p.id}`} className={cn("rounded-xl border p-3", ok ? "border-[#bfe3cd] bg-[#f3fbf6]" : shown.status === "failed" ? "border-[#f5c2cf] bg-[#fffafb]" : ["queued_browser", "running", "needs_teammate"].includes(shown.status) ? "border-[#fcd9a8] bg-[#fff7ec]" : "border-[#e4ebf2] bg-white")}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-bold text-[#1f3559]">{p.contact_name} — {label}</span>
          <button onClick={() => onPhase("dismissed")} className="text-[11px] text-[#0e8f88] hover:underline">dismiss</button>
        </div>
        <p className="mt-1 text-xs text-[#697a91]">{p.summary}</p>
        {shown.result && <pre className="mt-2 whitespace-pre-wrap font-sans text-[12px] text-[#1f3559] bg-white/70 rounded-lg px-2.5 py-2 border border-black/5">{shown.result}</pre>}
        {shots.length > 0 && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {shots.map((s, i) => (
              <a key={i} href={s.url} target="_blank" rel="noreferrer" className="block rounded-lg border border-black/10 overflow-hidden bg-white hover:border-[#15B7AE]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt={s.name || `Screenshot ${i + 1}`} className="w-full h-28 object-cover object-top" loading="lazy" />
                <span className="block px-2 py-1 text-[10px] text-[#697a91] truncate">{s.name || `Screenshot ${i + 1}`}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Compact (owner: "a lot of text, messy to track") but it must explain
  // itself before Approve (owner, 2026-10-01): what the client asked, then
  // exactly what Approve will do, in order. The client's own words and the
  // AI's notes sit behind "details".
  const tag = sensitive ? "💰 money" : linkStep ? "💳 payment links" : isTask(p) ? "📝 team task" : p.action_type === "account_change" ? "🔧 change" : "💬 reply";
  const change = (p.action_detail ?? "").replace(/^SENSITIVE:\s*/, "");
  // In the order executeProposal runs them. The client is never texted.
  const willDo: string[] = [];
  if (linkStep) willDo.push(editedCents ? `${stepText({ ...linkStep, amounts_cents: editedCents }).replace(/ and add (it|them) to the reply$/, "")} for you to paste in your reply` : "⚠️ Fix the payment amounts below");
  if (sensitive) willDo.push(`👤 Money is never automatic — a teammate makes this change by hand${change ? `: ${change}` : ""}`);
  else if (p.action_type === "account_change") {
    const steps = plan.filter((s) => s.type !== "payment_links");
    willDo.push(`On the Mac Mini, open ${p.contact_name}'s GoHighLevel account and:`);
    if (steps.length) willDo.push(...steps.map((s) => `   ${stepText(s)}`));
    else if (change) willDo.push(`   ${change}`);
    willDo.push("Screenshot the result and text it to you");
  }
  return (
    <div id={`proposal-${p.id}`} className={cn("rounded-xl border p-3", sensitive ? "border-[#f5c2cf] bg-[#fffafb]" : "border-[#c9dbfb] bg-[#f7faff]", focused && "ring-2 ring-[#15B7AE]")}>
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold text-[#1f3559]">{p.contact_name}</span>
        <span className={cn("text-[10px] font-bold px-1.5 py-px rounded", sensitive ? "bg-[#fde8ee] text-[#9f1239]" : p.action_type === "account_change" ? "bg-[#fff1e0] text-[#c2410c]" : "bg-[#e3eefb] text-[#185fa5]")}>{tag}</span>
        <span className="ml-auto text-[10px] text-[#8595a8]">{timeAgo(p.created_at)}{p.channel ? ` · ${p.channel}` : ""}</span>
      </div>
      <p className="mt-1 text-sm text-[#1f3559]"><span className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8] mr-1.5">Asked</span>{p.summary}</p>
      <div className="mt-1.5">
        <div className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8]">If you Approve, the AI will</div>
        <ol className="mt-0.5 space-y-0.5 text-[12px] text-[#34568a]">
          {willDo.map((t, i) => (
            <li key={i} className="flex gap-1.5"><span className="text-[#8595a8] tabular-nums">{i + 1}.</span><span>{t}</span></li>
          ))}
        </ol>
      </div>
      <button onClick={() => setShowDetails((d) => !d)} className="mt-1.5 text-[11px] text-[#0e8f88] hover:underline">
        {showDetails ? "hide details" : "details"}
      </button>
      {showDetails && (
        <div className="mt-1 space-y-1.5 text-[12px] text-[#697a91]">
          <p className="border-l-2 border-[#d7e0ea] pl-2 whitespace-pre-wrap">&ldquo;{p.client_message}&rdquo;</p>
          {change && plan.length > 0 && <p>{change}</p>}
          {p.notified_at && <p className="text-[11px] text-[#8595a8]">You were texted about this.</p>}
        </div>
      )}
      {linkStep && (
        <div className="mt-2 rounded-lg border border-[#c9dbfb] bg-white px-2.5 py-2 text-[12px]">
          <label className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-[#1f3559]">💳 Square links ($)</span>
            <input value={amountsText} onChange={(e) => onAmounts(e.target.value)} disabled={!!busy || working}
              aria-label="Payment link amounts in dollars, separated by commas"
              className={cn("w-40 px-2 py-1 border rounded-md text-[12px] tabular-nums", editedCents ? "border-[#c9dbfb]" : "border-[#e11d48]")} />
            <span className="text-[#697a91]">for &ldquo;{String(linkStep.label)}&rdquo;</span>
          </label>
          <p className="mt-1 text-[11px] text-[#697a91]">
            {editedCents ? <>Total <b className="text-[#1f3559]">{money(editedCents.reduce((a, b) => a + b, 0))}</b></> : <span className="text-[#e11d48]">Amounts $1–$10,000 each, up to 6, separated by commas</span>}
            {billCents != null && editedCents && (billPaid
              ? <span className="text-[#b91c1c] font-semibold"> · ⚠️ {String(linkStep.bill_owner ?? p.contact_name)}&apos;s {String(linkStep.bill_label ?? "bill")} ({money(billCents)}) is already marked &ldquo;{String(linkStep.bill_status)}&rdquo;</span>
              : editedCents.reduce((a, b) => a + b, 0) === billCents
                ? <span className="text-[#15803d]"> · matches {String(linkStep.bill_owner ?? p.contact_name)}&apos;s {String(linkStep.bill_label ?? "bill")} ({money(billCents)}) ✓</span>
                : <span className="text-[#c2410c]"> · {String(linkStep.bill_owner ?? p.contact_name)}&apos;s {String(linkStep.bill_label ?? "bill")} is {money(billCents)}</span>)}
            {billCents == null && <span className="text-[#8595a8]"> · no bill on file to check against</span>}
            {" · "}one-time links — nothing is charged; they pay when they open them
          </p>
        </div>
      )}
      {linkStep && editedCents && (
        <div className="mt-1 rounded-lg border border-dashed border-[#c9dbfb] bg-white/60 px-3 py-1.5 text-[12px] text-[#34568a]">
          <p className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8]">Links for your reply (copy after Approve)</p>
          {linkLines(editedCents).map((l, i) => <p key={i} className="tabular-nums">{l}</p>)}
          <p className="text-[10px] text-[#8595a8]">The real Square links replace 🔗 when you Approve.</p>
        </div>
      )}
      <div className="flex items-center gap-2 mt-2">
        <button onClick={() => decide("approve")} disabled={!!busy || working || checking || (!!linkStep && (!editedCents || needsMessage))}
          className="px-3 py-1.5 rounded-lg bg-[#15803d] hover:bg-[#166534] text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy === "approve" || working ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {busy === "approve" || working ? "Working…" : "Approve"}
        </button>
        <button onClick={() => decide("deny")} disabled={!!busy || working || checking}
          className="px-3 py-1.5 rounded-lg border border-[#f5c2cf] text-[#e11d48] hover:bg-[#fde8ee] text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy === "deny" ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} Deny
        </button>
      </div>
    </div>
  );
}

/* Schedule a text instead of sending it now (owner, 2026-10-03). GHL holds it
   and sends it at that time; it shows in the chat's "Scheduled" list (and in
   GHL) and can be cancelled until then. Times are the viewer's local time. */
const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const whenText = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

function ScheduleControl({ contactId, contactName, channel, text, disabled, onScheduled, onBusyChange }: {
  contactId: string; contactName: string; channel: string; text: string; disabled?: boolean;
  onScheduled: (s: { id: string | null; scheduledFor: string; cancellable: boolean }) => void;
  // The parent locks its Send while a schedule is in flight (and passes
  // disabled while a Send is) — doing both would text the client twice.
  onBusyChange?: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(() => { const d = new Date(Date.now() + 86_400_000); d.setHours(9, 0, 0, 0); return localInput(d); });
  const [busy, setBusyState] = useState(false);
  const setBusy = (b: boolean) => { setBusyState(b); onBusyChange?.(b); };
  const schedule = async () => {
    if (busy || disabled || !text.trim()) return;
    const t = new Date(at);
    if (isNaN(t.getTime()) || t.getTime() < Date.now() + 60_000) { toast.error("Pick a time at least a minute from now"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/ghl/reply/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, contactName, message: text.trim(), channel, scheduleAt: t.toISOString() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Couldn't schedule it");
      toast.success(`Scheduled for ${whenText(j.scheduledFor)}`);
      setOpen(false);
      onScheduled({ id: j.id ?? null, scheduledFor: j.scheduledFor, cancellable: !!j.cancellable });
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally { setBusy(false); }
  };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} disabled={disabled}
        title="Send it later — GHL holds the text and sends it at the time you pick"
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#c9dbfb] text-[#34568a] hover:bg-[#f7faff] text-xs font-semibold disabled:opacity-50">
        🕒 Schedule
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1.5 flex-wrap">
      <input type="datetime-local" value={at} min={localInput(new Date(Date.now() + 2 * 60_000))} onChange={(e) => setAt(e.target.value)}
        className="px-2 py-1 rounded-lg border border-[#c9dbfb] text-xs text-[#1f3559] bg-white" />
      <button onClick={() => void schedule()} disabled={busy || disabled || !at}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#34568a] hover:bg-[#1f3559] text-white text-xs font-semibold disabled:opacity-60">
        {busy ? <Loader2 size={12} className="animate-spin" /> : "🕒"} Schedule
      </button>
      <button onClick={() => setOpen(false)} className="text-[11px] text-[#8595a8] hover:underline">cancel</button>
    </span>
  );
}

// Texts already scheduled for this contact — shown in the open chat, with Cancel.
type ScheduledMsg = { id: string; message: string; scheduled_for: string; created_by: string; ghl_message_id: string | null };
function ScheduledList({ contactId, refreshKey }: { contactId: string; refreshKey: number }) {
  const [items, setItems] = useState<ScheduledMsg[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/ghl/reply/scheduled?contactId=${encodeURIComponent(contactId)}`);
      const j = await r.json();
      if (r.ok) setItems(j.scheduled ?? []);
    } catch { /* list stays as is */ }
  }, [contactId]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const cancel = async (m: ScheduledMsg) => {
    if (!window.confirm(`Cancel the text scheduled for ${whenText(m.scheduled_for)}?`)) return;
    setBusy(m.id);
    try {
      const r = await fetch("/api/ghl/reply/scheduled", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: m.id }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Couldn't cancel it");
      toast.success("Scheduled text cancelled");
      await load();
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally { setBusy(null); }
  };
  if (!items.length) return null;
  return (
    <div className="mt-2.5 rounded-lg border border-[#c9dbfb] bg-white p-2">
      <p className="text-[11px] font-bold text-[#34568a] mb-1">🕒 Scheduled ({items.length})</p>
      <ul className="space-y-1">
        {items.map((m) => (
          <li key={m.id} className="flex items-start gap-2 text-[12px]">
            <div className="flex-1 min-w-0">
              <span className="font-semibold text-[#1f3559]">{whenText(m.scheduled_for)}</span>
              <span className="text-[#8595a8]"> · by {m.created_by.split("@")[0]}</span>
              <p className="text-[#697a91] whitespace-pre-wrap break-words">{m.message}</p>
            </div>
            <button onClick={() => void cancel(m)} disabled={busy === m.id}
              className="shrink-0 text-[11px] text-[#e11d48] hover:underline disabled:opacity-50">
              {busy === m.id ? "…" : "Cancel"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DraftCard({ d, busy, onEdit }: { d: Draft; busy?: boolean; onEdit?: (d: Draft, note: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editNote, setEditNote] = useState("");
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent">("idle");
  const [scheduled, setScheduled] = useState<{ id: string | null; scheduledFor: string; cancellable: boolean } | null>(null);
  const [unscheduling, setUnscheduling] = useState(false);
  const [schedBusy, setSchedBusy] = useState(false);
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
    if (!d.contactId || sendState !== "idle" || schedBusy || !text.trim()) return;
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
  }, [d, sendState, schedBusy, text]);
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
    : [
        vi.samplesUsed > 0 ? `Written in ${vi.name}'s voice · ${vi.samplesUsed} real ${vi.samplesUsed === 1 ? "reply" : "replies"}` : "No real replies found — plain style",
        vi.learnedFrom ? `learned from ${vi.learnedFrom} past edit${vi.learnedFrom === 1 ? "" : "s"}` : "",
        vi.knowsClient ? `remembers ${d.contactName.split(" ")[0]}'s history` : "",
        d.inviteCall ? "📞 call invite on" : "",
      ].filter(Boolean).join(" · ");
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
        {canSend && scheduled ? (
          <span className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#eef6ff] border border-[#c9dbfb] text-xs font-semibold text-[#185fa5]">
            🕒 Scheduled · {whenText(scheduled.scheduledFor)}
            {scheduled.id && scheduled.cancellable && (
              <button disabled={unscheduling} onClick={async () => {
                  if (!window.confirm("Cancel this scheduled text?")) return;
                  setUnscheduling(true);
                  try {
                    const r = await fetch("/api/ghl/reply/scheduled", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: scheduled.id }) });
                    const j = await r.json();
                    if (!r.ok) throw new Error(j.error || "Couldn't cancel it");
                    toast.success("Scheduled text cancelled");
                    setScheduled(null);
                  } catch (e) { toast.error(`${e}`.replace("Error: ", "")); }
                  finally { setUnscheduling(false); }
                }}
                className="text-[11px] font-medium text-[#e11d48] hover:underline disabled:opacity-50">{unscheduling ? "…" : "cancel"}</button>
            )}
          </span>
        ) : canSend && (
          <>
            <button onClick={sendDraft} disabled={sendState !== "idle" || schedBusy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-semibold disabled:opacity-60">
              {sendState === "sending" ? <Loader2 size={12} className="animate-spin" /> : sendState === "sent" ? <Check size={12} /> : <Send size={12} />}
              {sendState === "sent" ? "Sent ✓" : `Send to ${d.contactName}`}
            </button>
            {sendState === "idle" && d.contactId && (
              <ScheduleControl contactId={d.contactId} contactName={d.contactName} channel={d.channel} text={text}
                disabled={sendState !== "idle"} onScheduled={setScheduled} onBusyChange={setSchedBusy} />
            )}
          </>
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
        <span className="text-[10px] text-[#8595a8]">{canSend ? "nothing sends until you click Send or Schedule" : noSendReason}</span>
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
