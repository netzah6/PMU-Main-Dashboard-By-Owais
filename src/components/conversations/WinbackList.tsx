"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/* 🔁 Win-back (owner, 2026-10-10): only the former clients we're trying to
   bring back — the "Follow Up" rows of the "Follow up To PPS" sheet, tagged
   win-back-2026 in PMU Bookings On Demand. Clicking a person opens the normal
   composer: the AI drafts with the offer the owner approved, nothing goes
   out until he sends it. */

export type WinbackConv = {
  id: string;
  contactId: string | null;
  contactName: string;
  lastMessageBody: string;
  lastMessageDirection?: string | null;
  lastMessageDate: string | null;
  unreadCount: number;
  channel: string;
  assignedTo: string | null;
  assignedToName: string;
};
type Person = {
  sheetRow: number; ownerName: string; business: string | null; lastPaid: string | null;
  offer: "pps" | "monthly" | null; outcome: "won" | "lost" | null;
  contactId: string | null; matchNote: string | null; tagged: boolean; conv: WinbackConv | null;
  review: { verdict: "ok" | "tense" | "bad" | "opted_out" | "no_chat" | null; note: string | null; quote: string | null } | null;
};
const REVIEW_CHIP: Record<string, { label: string; cls: string }> = {
  bad: { label: "🚩 Ended badly", cls: "bg-[#fde8ee] text-[#e11d48]" },
  opted_out: { label: "⛔ Asked us to stop", cls: "bg-[#fde8ee] text-[#e11d48]" },
  tense: { label: "⚠ Unhappy", cls: "bg-[#fff4e0] text-[#b45309]" },
};
const flagged = (p: Person) => !!p.review?.verdict && p.review.verdict in REVIEW_CHIP;
type Filter = "check" | "reply" | "waiting" | "new" | "done" | "missing" | "all";

const OFFER_CHIP: Record<string, { label: string; cls: string; title: string }> = {
  pps: { label: "💸 PPS", cls: "bg-[#e6f7f5] text-[#0e8f88]", title: "$50 deposit + $60 per show" },
  monthly: { label: "📅 Monthly", cls: "bg-[#e3eefb] text-[#185fa5]", title: "Normal monthly program" },
  none: { label: "No offer yet", cls: "bg-[#f1f5f9] text-[#8595a8]", title: "Pick PPS or Normal in the sheet's Program column — until then the AI won't pitch anything" },
};

function stateOf(p: Person): Exclude<Filter, "all" | "check"> {
  if (p.outcome) return "done";
  if (!p.contactId) return "missing";
  // Only the 100 most recent chats are checked — a fresh reply always lands
  // there; "new" (Quiet) = not texted yet or nothing recent.
  if (!p.conv) return "new";
  return p.conv.lastMessageDirection === "inbound" ? "reply" : "waiting";
}

const ago = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export function WinbackList({ activeId, disabled, onOpen }: {
  activeId: string | null;
  disabled?: boolean;
  onOpen: (c: WinbackConv) => void;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("reply");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await fetch("/api/winback");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load the win-back list");
      setPeople(j.people ?? []);
      setErr(null);
    } catch (e) {
      if (!silent) setErr(`${e}`.replace("Error: ", ""));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(true); }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await fetch("/api/winback/sync", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Sync failed");
      toast.success(
        `Synced ${j.followUp} Follow Up clients · tagged ${j.tagged}${j.untagged ? ` · untagged ${j.untagged}` : ""}${j.notFound ? ` · ${j.notFound} not found in GHL` : ""}`
        + (j.remaining > 0 ? ` · ${j.remaining} left — click Sync again` : ""),
      );
      await load(true);
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""), { duration: 15_000 });
    } finally {
      setSyncing(false);
    }
  };

  // Read-only: the AI reads each person's history with us and flags bad endings.
  const review = async () => {
    setReviewing(true);
    try {
      const r = await fetch("/api/winback/review", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Review failed");
      toast.success(
        `Reviewed ${j.reviewed} chats · ${j.flagged} flagged to check${j.notFound ? ` · ${j.notFound} not found in GHL` : ""}`
        + (j.remaining > 0 ? ` · ${j.remaining} left — click Review again` : " · all done"),
        { duration: 10_000 },
      );
      await load(true);
      setFilter("check");
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""), { duration: 15_000 });
    } finally {
      setReviewing(false);
    }
  };

  const setOutcome = async (p: Person, outcome: "won" | "lost" | null) => {
    setPeople((list) => list?.map((x) => (x.sheetRow === p.sheetRow ? { ...x, outcome } : x)) ?? null);
    const r = await fetch("/api/winback", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sheetRow: p.sheetRow, outcome }) }).catch(() => null);
    if (!r?.ok) { toast.error("Couldn't save — try again"); load(true); }
  };

  const open = async (p: Person) => {
    if (p.conv) return onOpen({ ...p.conv, contactName: p.ownerName });
    if (!p.contactId) return;
    setOpening(p.sheetRow);
    try {
      const r = await fetch(`/api/winback?contactId=${encodeURIComponent(p.contactId)}`);
      const j = await r.json();
      if (j.conversation) onOpen({ ...j.conversation, contactName: p.ownerName });
      else toast(`${p.ownerName} hasn't been texted yet — no chat to open`);
    } catch {
      toast.error("Couldn't open the chat");
    } finally {
      setOpening(null);
    }
  };

  const counts = (people ?? []).reduce<Record<string, number>>((m, p) => { const s = stateOf(p); m[s] = (m[s] ?? 0) + 1; if (flagged(p)) m.check = (m.check ?? 0) + 1; return m; }, {});
  const shown = (people ?? [])
    .filter((p) => filter === "all" || (filter === "check" ? flagged(p) : stateOf(p) === filter))
    .sort((a, b) => (b.conv?.lastMessageDate ?? "").localeCompare(a.conv?.lastMessageDate ?? "") || a.sheetRow - b.sheetRow);
  const tabs: Array<[Filter, string]> = [["check", "🚩 Check"], ["reply", "💬 Replied"], ["waiting", "⏳ Waiting"], ["new", "Quiet"], ["done", "Done"], ["missing", "Not in GHL"], ["all", "All"]];

  return (
    <>
      <div className="px-3 py-1.5 border-b border-[#eef3f8] flex items-center gap-1 flex-wrap">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={cn("px-1.5 py-0.5 rounded-full text-[10px] font-semibold border",
              filter === k ? "bg-[#15B7AE] text-white border-[#15B7AE]" : "bg-white text-[#697a91] border-[#e4ebf2] hover:bg-[#f7fdfc]")}>
            {label}{k !== "all" && counts[k] ? ` ${counts[k]}` : k === "all" && people ? ` ${people.length}` : ""}
          </button>
        ))}
        <button onClick={review} disabled={reviewing || syncing} title="AI reads each Follow Up client's history with us and flags anyone who left on bad terms (no tags, no messages)"
          className="ml-auto px-1.5 py-0.5 rounded text-[10px] font-semibold text-[#185fa5] hover:bg-[#e3eefb] flex items-center gap-1 disabled:opacity-60">
          {reviewing ? <Loader2 size={11} className="animate-spin" /> : "🔎"} {reviewing ? "Reviewing…" : "Review chats"}
        </button>
        <button onClick={sync} disabled={syncing || reviewing} title="Pull the Follow Up list from the sheet and tag them in GHL (no messages are sent)"
          className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-[#0e8f88] hover:bg-[#e6f7f5] flex items-center gap-1 disabled:opacity-60">
          <RefreshCw size={11} className={syncing || loading ? "animate-spin" : ""} /> {syncing ? "Syncing…" : "Sync from sheet"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {err ? (
          <p className="p-3 text-xs text-[#e11d48]">{err}</p>
        ) : people === null ? (
          <p className="p-3 text-xs text-[#8595a8] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Loading…</p>
        ) : people.length === 0 ? (
          <p className="p-3 text-xs text-[#8595a8]">No one yet — click <b>🔎 Review chats</b> first (reads the Follow Up list and flags bad endings, no tags), then <b>Sync from sheet</b> to tag them.</p>
        ) : shown.length === 0 ? (
          <p className="p-3 text-xs text-[#8595a8]">Nobody here right now.</p>
        ) : shown.map((p) => {
          const st = stateOf(p);
          const chip = OFFER_CHIP[p.offer ?? "none"];
          const clickable = !!p.contactId && !disabled;
          return (
            <div key={p.sheetRow} className={cn("border-b border-[#f1f5f9]", p.conv && activeId === p.conv.id && "bg-[#f0fbfa]")}>
              <button onClick={() => open(p)} disabled={!clickable}
                className="w-full text-left px-3 pt-2.5 pb-1 hover:bg-[#f7fdfc] transition-colors disabled:hover:bg-transparent disabled:cursor-default">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-bold text-[#1f3559] truncate">
                    {p.ownerName}
                    {opening === p.sheetRow && <Loader2 size={11} className="inline ml-1 animate-spin text-[#15B7AE]" />}
                  </span>
                  <span className="shrink-0 text-[10px] text-[#8595a8]">{ago(p.conv?.lastMessageDate ?? null)}</span>
                </div>
                {p.business && <p className="text-[11px] text-[#697a91] truncate">{p.business}</p>}
                {p.conv?.lastMessageBody && (
                  <p className={cn("text-[11px] truncate mt-0.5", st === "reply" ? "text-[#1f3559] font-semibold" : "text-[#8595a8]")}>
                    {st === "reply" ? "↩ " : "You: "}{p.conv.lastMessageBody}
                  </p>
                )}
                {p.review && flagged(p) && (
                  <div className="mt-1 rounded-md bg-[#fff8f9] border border-[#fbd5df] px-2 py-1">
                    <span className={cn("px-1.5 rounded text-[9px] font-bold", REVIEW_CHIP[p.review.verdict!].cls)}>{REVIEW_CHIP[p.review.verdict!].label}</span>
                    <p className="text-[11px] text-[#1f3559] mt-0.5">{p.review.note}</p>
                    {p.review.quote && <p className="text-[11px] italic text-[#697a91]">“{p.review.quote}”</p>}
                  </div>
                )}
                {st === "missing" && <p className="text-[10px] text-[#e11d48] mt-0.5">{p.matchNote ?? "Not matched yet — run Sync"}</p>}
              </button>
              <div className="px-3 pb-2 flex items-center gap-1.5">
                <span title={chip.title} className={cn("px-1.5 rounded text-[9px] font-bold", chip.cls)}>{chip.label}</span>
                {st === "reply" && <span className="px-1 rounded-full bg-[#e11d48] text-white text-[9px] font-bold">needs reply</span>}
                {st === "new" && <span title="Not texted yet, or no messages among the 100 most recent chats" className="text-[9px] text-[#8595a8]">no recent messages</span>}
                <select value={p.outcome ?? ""} onChange={(e) => setOutcome(p, (e.target.value || null) as "won" | "lost" | null)}
                  className="ml-auto text-[10px] border border-[#e4ebf2] rounded px-1 py-0.5 bg-white text-[#1f3559]">
                  <option value="">In progress</option>
                  <option value="won">🎉 Came back</option>
                  <option value="lost">✖ Not now</option>
                </select>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
