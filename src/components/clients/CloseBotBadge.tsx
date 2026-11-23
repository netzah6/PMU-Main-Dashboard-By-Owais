"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";

/* "CloseBot" box on the client profile (owner, 11/11/2026): connected to an
   agent's job flow or not, from the daily CloseBot check. One word on the
   chip; the detail (agent, tags, why not, when checked) behind a click. */
type State = "on" | "off" | "no_flow" | "disconnected" | "no_source" | "no_account";
type Task = { id: string; status: string; result: string | null; at: string };
type Info = { at: string | null; client: { state: State; source: string | null; agents: string[]; tags: string[]; located?: boolean } | null; task?: Task | null };

const WHY: Record<State, string> = {
  on: "Connected to an agent",
  off: "The agent's job flow is switched off",
  no_flow: "The source has no agent connected (0 job flows)",
  disconnected: "The CloseBot source is disconnected",
  no_source: "No CloseBot source for this sub-account",
  no_account: "The dashboard can't tell which GoHighLevel sub-account is theirs",
};
const usDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
const STYLE = {
  green: "bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df] hover:bg-[#d4f1ee]",
  red: "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf] hover:bg-[#fbd9e2]",
  yellow: "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8] hover:bg-[#ffefd9]",
  gray: "bg-[#f1f5f9] text-[#64748b] border-[#d7e0ea] hover:bg-[#e8eef4]",
};

export function CloseBotBadge({ owner, business, version, status }: { owner: string; business: string; version: string; status: string }) {
  const [info, setInfo] = useState<Info | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [tick, setTick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tick === 0) setInfo(undefined);
    if (!owner && !business) { setInfo(null); return; }
    let cancelled = false;
    fetch(`/api/closebot/client-status?owner=${encodeURIComponent(owner)}&business=${encodeURIComponent(business)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setInfo(j as Info | null); })
      .catch(() => { if (!cancelled) setInfo(null); });
    return () => { cancelled = true; };
  }, [owner, business, tick]);

  // While the Mac Mini works on a connect task, re-read every 20 seconds.
  const busy = info?.task ? ["queued_browser", "running"].includes(info.task.status) : false;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [busy]);

  const connect = async () => {
    setSending(true);
    try {
      const r = await fetch("/api/closebot/connect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, business, ownerName: owner, businessName: business, version }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not send");
      toast.success(j.reused ? "Already sent to the Mac Mini" : "Sent to the Mac Mini — it will connect CloseBot");
      setTick((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send");
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (info === undefined) return null;
  const v3 = version.toLowerCase().replace(/[^a-z0-9.]/g, "") === "v3";
  const live = status.trim().toLowerCase() === "live";
  const c = info?.client ?? null;
  const on = c?.state === "on";
  const unknown = c?.state === "no_account";
  const label = !c ? "Not checked" : on ? "Connected" : unknown ? "Unknown" : "Not connected";
  // Red only where it matters: a Live V3 client with no bot. On for a non-V3 client = yellow.
  const tone = !c ? "gray" : on ? (v3 ? "green" : "yellow") : v3 && live ? (unknown ? "yellow" : "red") : "gray";
  const old = info?.at ? Date.now() - Date.parse(info.at) > 2 * 86_400_000 : false;
  const task = info?.task ?? null;
  // A task newer than the last daily check is the latest word on this client.
  const fresh = task && (!info?.at || Date.parse(task.at) > Date.parse(info.at));
  const canConnect = v3 && !!c && !on && !unknown && c.located !== false;
  const stuck = task?.result?.match(/CLOSEBOT: STUCK — ([^\n]*)/)?.[1];
  const taskLine = !task || !fresh ? null
    : busy ? (task.status === "running" ? "The Mac Mini is connecting CloseBot now…" : "Waiting for the Mac Mini…")
    : task.status === "done" ? "The Mac Mini finished connecting. It turns green after the next daily check."
    : `The Mac Mini could not finish${stuck ? `: ${stuck}` : ""}.`;

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border transition-colors cursor-pointer ${STYLE[tone]}`}>
        CloseBot: <strong className="ml-1">{fresh && busy ? "Connecting…" : label}</strong>
        <ChevronDown size={12} className={`ml-1 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-2 z-30 w-72 max-w-[calc(100vw-32px)] bg-white border border-[#e4ebf2] rounded-xl p-3 text-left text-xs text-[#34568a] space-y-1.5"
          style={{ boxShadow: "var(--shadow-md)" }}>
          {!c ? (
            <p>{info?.at ? "This client was not in the last CloseBot check." : "The CloseBot check has not run yet."}</p>
          ) : on ? (
            <>
              <p><span className="text-[#697a91]">Agent:</span> {c.agents.join(", ")}</p>
              {c.tags.length > 0 && <p><span className="text-[#697a91]">Tags:</span> {c.tags.join(", ")}</p>}
              {c.source && <p><span className="text-[#697a91]">Source:</span> {c.source}</p>}
              {!v3 && <p className="text-[#d97706]">Not a V3 client, but the AI is on.</p>}
            </>
          ) : (
            <>
              <p>{WHY[c.state]}.</p>
              {c.source && <p><span className="text-[#697a91]">Source:</span> {c.source}</p>}
              {!v3 && c.state === "no_source" && <p className="text-[#697a91]">Normal for a client who is not V3.</p>}
            </>
          )}
          {taskLine && <p className={`font-medium ${busy || task?.status === "done" ? "text-[#0e8f88]" : "text-[#e11d48]"}`}>{taskLine}</p>}
          {canConnect && !(fresh && (busy || task?.status === "done")) && (
            <button type="button" onClick={connect} disabled={sending}
              className="w-full mt-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#0e8f88] hover:bg-[#0b7570] disabled:opacity-60 text-white font-medium px-3 py-1.5">
              {sending && <Loader2 size={12} className="animate-spin" />}
              {sending ? "Sending…" : fresh ? "Try again" : "Connect to CloseBot"}
            </button>
          )}
          {info?.at && (
            <p className={`pt-1.5 border-t border-[#eef3f8] ${old ? "text-[#d97706]" : "text-[#697a91]"}`}>
              Checked {usDate(info.at)}{old ? " — the daily check is late" : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
