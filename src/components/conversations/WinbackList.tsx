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
  // Text sequence (owner, 2026-10-19): day-0 text → day-3 nudge → day-7 email → day-14 close-out.
  batchNo: number | null; step: number; nextDueAt: string | null; lastSentAt: string | null;
  repliedAt: string | null; stoppedReason: "replied" | "opted_out" | "failed" | "finished" | "current_client" | "human" | null; sendError: string | null;
};
const REVIEW_CHIP: Record<string, { label: string; cls: string }> = {
  bad: { label: "🚩 Ended badly", cls: "bg-[#fde8ee] text-[#e11d48]" },
  opted_out: { label: "⛔ Asked us to stop", cls: "bg-[#fde8ee] text-[#e11d48]" },
  tense: { label: "⚠ Unhappy", cls: "bg-[#fff4e0] text-[#b45309]" },
};
const flagged = (p: Person) => !!p.review?.verdict && p.review.verdict in REVIEW_CHIP;
type Filter = "check" | "reply" | "waiting" | "new" | "batch" | "done" | "missing" | "all";

// What the batch preview returns (POST /api/winback/batch, dryRun).
type BatchPreview = {
  dryRun: boolean; batchNo: number | null; dayZeroText: string; eligible: number;
  picked: Array<{ sheetRow: number; name: string; business: string | null; lastPaid: string | null; offer: "pps" | "monthly" | null; first: string; text: string }>;
  skipped: Array<{ sheetRow: number; name: string; why: string }>;
};

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const STOP_LABEL: Record<string, string> = {
  opted_out: "Stopped: opted out", failed: "Stopped: send failed", current_client: "Stopped: current client", human: "Stopped: teammate took over",
};
/* One chip per person: where the sequence stands. */
function seqChip(p: Person): { label: string; cls: string; title: string } | null {
  if (p.repliedAt || p.stoppedReason === "replied") return { label: "Replied ✓", cls: "bg-[#e6f7f5] text-[#0e8f88]", title: `Wrote back${p.repliedAt ? ` ${shortDate(p.repliedAt)}` : ""} — the sequence stopped, answer from the chat` };
  if (p.stoppedReason === "finished") return { label: "Finished", cls: "bg-[#f1f5f9] text-[#697a91]", title: p.sendError ?? "All 4 touches went out with no reply — tagged win-back-no-reply" };
  // A teammate wrote to her by hand — the sequence stepped aside; nothing is wrong.
  if (p.stoppedReason === "human") return { label: STOP_LABEL.human, cls: "bg-[#f1f5f9] text-[#697a91]", title: p.sendError ?? "A teammate wrote to her after the batch started — carry on from the chat" };
  if (p.stoppedReason) return { label: STOP_LABEL[p.stoppedReason] ?? `Stopped: ${p.stoppedReason}`, cls: "bg-[#fde8ee] text-[#e11d48]", title: p.sendError ?? "" };
  if (p.batchNo == null) return null;
  const due = p.nextDueAt ? Date.parse(p.nextDueAt) : NaN;
  const next = !p.nextDueAt ? "" : due <= Date.now() ? " · sending soon" : ` · next ${shortDate(p.nextDueAt)}`;
  return { label: `Step ${p.step}/4${next}`, cls: "bg-[#e3eefb] text-[#185fa5]", title: `Batch ${p.batchNo}${p.lastSentAt ? ` · last sent ${shortDate(p.lastSentAt)}` : ""}${p.sendError ? ` · ${p.sendError}` : ""}` };
}

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
  const [batchSize, setBatchSize] = useState(20);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);

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

  /* "▶ Start next batch": a preview first (dry run — nothing is written or
     sent), then the owner confirms and the real call stamps the batch on
     exactly the rows he saw (re-checked; anyone who changed in between is
     reported, not replaced). The day-0 texts go out from the cron within
     15 minutes, 9am–7pm their time. */
  const previewBatch = async () => {
    setPreviewing(true);
    try {
      const r = await fetch("/api/winback/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size: batchSize, dryRun: true }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Couldn't build the batch");
      setPreview(j as BatchPreview);
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""), { duration: 15_000 });
    } finally {
      setPreviewing(false);
    }
  };
  const confirmBatch = async () => {
    if (!preview) return;
    setStarting(true);
    try {
      const sheetRows = preview.picked.map((p) => p.sheetRow);
      const r = await fetch("/api/winback/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sheetRows, dryRun: false }) });
      const j = (await r.json()) as BatchPreview & { error?: string };
      if (!r.ok) throw new Error(j.error || "Couldn't start the batch");
      const missing = sheetRows.length - j.picked.length;
      toast.success(
        `Batch ${j.batchNo} started · ${j.picked.length} people — the first text goes out within 15 minutes (9am–7pm their time)`
        + (missing > 0 ? ` · ${missing} from the preview changed meanwhile and were left out: ${j.skipped.filter((s) => sheetRows.includes(s.sheetRow)).map((s) => `${s.name} (${s.why})`).join("; ")}` : ""),
        { duration: missing > 0 ? 20_000 : 10_000 },
      );
      setPreview(null);
      await load(true);
      setFilter("batch");
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""), { duration: 15_000 });
    } finally {
      setStarting(false);
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

  const inBatch = (p: Person) => p.batchNo != null;
  const counts = (people ?? []).reduce<Record<string, number>>((m, p) => { const s = stateOf(p); m[s] = (m[s] ?? 0) + 1; if (flagged(p)) m.check = (m.check ?? 0) + 1; if (inBatch(p)) m.batch = (m.batch ?? 0) + 1; return m; }, {});
  const shown = (people ?? [])
    .filter((p) => filter === "all" || (filter === "check" ? flagged(p) : filter === "batch" ? inBatch(p) : stateOf(p) === filter))
    .sort((a, b) => (b.conv?.lastMessageDate ?? "").localeCompare(a.conv?.lastMessageDate ?? "") || a.sheetRow - b.sheetRow);
  const tabs: Array<[Filter, string]> = [["check", "🚩 Check"], ["reply", "💬 Replied"], ["waiting", "⏳ Waiting"], ["new", "Quiet"], ["batch", "📨 Batch"], ["done", "Done"], ["missing", "Not in GHL"], ["all", "All"]];
  const busy = syncing || reviewing || previewing || starting;

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
        <button onClick={review} disabled={busy} title="AI reads each Follow Up client's history with us and flags anyone who left on bad terms (no tags, no messages)"
          className="ml-auto px-1.5 py-0.5 rounded text-[10px] font-semibold text-[#185fa5] hover:bg-[#e3eefb] flex items-center gap-1 disabled:opacity-60">
          {reviewing ? <Loader2 size={11} className="animate-spin" /> : "🔎"} {reviewing ? "Reviewing…" : "Review chats"}
        </button>
        <button onClick={sync} disabled={busy} title="Pull the Follow Up list from the sheet and tag them in GHL (no messages are sent)"
          className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-[#0e8f88] hover:bg-[#e6f7f5] flex items-center gap-1 disabled:opacity-60">
          <RefreshCw size={11} className={syncing || loading ? "animate-spin" : ""} /> {syncing ? "Syncing…" : "Sync from sheet"}
        </button>
        <span className="flex items-center gap-1 text-[10px] text-[#697a91]" title="How many people to start today (newest leavers first, max 50)">
          <input type="number" min={1} max={50} value={batchSize} disabled={busy || !!preview}
            onChange={(e) => setBatchSize(Math.min(50, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
            className="w-10 text-[10px] border border-[#e4ebf2] rounded px-1 py-0.5 bg-white text-[#1f3559]" />
          <button onClick={previewBatch} disabled={busy || disabled || !!preview}
            title="Preview who gets today's first text — nothing is sent until you confirm"
            className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#15B7AE] text-white hover:bg-[#0e8f88] flex items-center gap-1 disabled:opacity-60">
            {previewing ? <Loader2 size={11} className="animate-spin" /> : "▶"} {previewing ? "Checking…" : "Start next batch"}
          </button>
        </span>
      </div>
      {preview && (
        <div className="m-2 rounded-lg border border-[#15B7AE] bg-[#f0fbfa] p-2.5 text-[11px] text-[#1f3559] max-h-[55%] overflow-y-auto">
          <p className="font-bold text-[12px]">Batch preview — {preview.picked.length} {preview.picked.length === 1 ? "person" : "people"} would get the first text</p>
          <p className="mt-1 rounded bg-white border border-[#e4ebf2] px-2 py-1 italic text-[#697a91]">“{preview.dayZeroText}”</p>
          {preview.picked.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5">
              {preview.picked.map((p) => (
                <li key={p.sheetRow} className="flex items-center gap-1.5" title={p.text}>
                  <span className="font-semibold truncate">{p.name}</span>
                  <span className="text-[#8595a8] truncate">{p.business ? `· ${p.business}` : ""}{p.lastPaid ? ` · last paid ${p.lastPaid}` : ""}</span>
                  <span className={cn("ml-auto shrink-0 px-1.5 rounded text-[9px] font-bold", OFFER_CHIP[p.offer ?? "none"].cls)}>{OFFER_CHIP[p.offer ?? "none"].label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-[#8595a8]">Nobody left to start — {preview.eligible} eligible before the current-client check.</p>
          )}
          {preview.skipped.length > 0 && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[#b45309] font-semibold" title="Current clients, no phone / DND, or people we're already talking to (those stay in the pool for a later batch)">{preview.skipped.length} skipped this time</summary>
              <ul className="mt-0.5 space-y-0.5 text-[#697a91]">
                {preview.skipped.map((s) => <li key={s.sheetRow}><b className="text-[#1f3559]">{s.name}</b> — {s.why}</li>)}
              </ul>
            </details>
          )}
          <p className="mt-1.5 text-[10px] text-[#8595a8]">Then: day-3 nudge → day-7 email → day-14 close-out, sent 9am–7pm their time. A reply stops it — you answer from the chat.</p>
          <div className="mt-2 flex items-center gap-1.5">
            <button onClick={confirmBatch} disabled={starting || preview.picked.length === 0}
              className="px-2 py-1 rounded text-[11px] font-bold bg-[#15B7AE] text-white hover:bg-[#0e8f88] flex items-center gap-1 disabled:opacity-60">
              {starting && <Loader2 size={11} className="animate-spin" />} {starting ? "Starting…" : `Send to ${preview.picked.length}`}
            </button>
            <button onClick={() => setPreview(null)} disabled={starting}
              className="px-2 py-1 rounded text-[11px] font-semibold text-[#697a91] hover:bg-white border border-[#e4ebf2] disabled:opacity-60">
              Cancel
            </button>
          </div>
        </div>
      )}
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
          const seq = seqChip(p);
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
                {seq && <span title={seq.title} className={cn("px-1.5 rounded text-[9px] font-bold", seq.cls)}>{seq.label}</span>}
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
