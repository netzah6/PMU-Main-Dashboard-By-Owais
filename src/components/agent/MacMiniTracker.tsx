"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useUser } from "@/lib/hooks/useUser";

/* Mac Mini tracker, for admins (owner, 2026-10-16: "I approve a task, switch
   to another tab, come back to the AI tab and I have no idea what's going on").

   Two places only (owner, same day — "not on every tab"):
   - AI tab (scope "agent"): the tasks you approve there.
   - Onboarding tab (scope "onboarding"): New Client Setup steps and the
     clean-account snapshot loads.

   The Mini works from the server queue, so leaving the page never stops it;
   this pill (bottom-left) is where you SEE it. Click it for the list; a row
   opens its card.

   Alert: when a task this page saw waiting/running comes back done or failed,
   a pop-up shows — and, if you allowed it, a desktop notification (works with
   the dashboard in a background browser tab). */

/** Fire after queueing Mini work so the tracker checks now, not in 20 s. */
export const MINI_REFRESH_EVENT = "pmu:mini-tracker-refresh";

export type TrackerScope = "agent" | "onboarding";

type Row = {
  id: string; conversation_id: string | null; contact_name: string; summary: string; status: string;
  created_at: string; browser_claimed_at: string | null; browser_attempts: number | null; executed_at: string | null;
};
type Data = { worker: { at: string } | null; active: Row[]; finished: Row[] };

const POLL_VISIBLE_MS = 20_000;
const POLL_HIDDEN_MS = 60_000;
const STUCK_MS = 25 * 60_000;   // the worker re-queues a run this old (agent-worker stale rule)
const OFFLINE_MS = 3 * 60_000;  // same threshold as the AI tab's online badge
const seenKey = (scope: TrackerScope) => `pmu.miniTracker.seen.${scope}`;

const memSeen: Partial<Record<TrackerScope, string[]>> = {};
/** null = this browser never used this tracker (first load seeds it). */
function readSeen(scope: TrackerScope): string[] | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(seenKey(scope)) ?? "null");
    if (Array.isArray(v)) return v.map(String);
    if (v === null && !memSeen[scope]) return null;
  } catch { /* blocked storage — memory copy */ }
  return memSeen[scope] ?? [];
}
function writeSeen(scope: TrackerScope, ids: string[]) {
  const keep = ids.slice(-80);
  memSeen[scope] = keep;
  try { window.localStorage.setItem(seenKey(scope), JSON.stringify(keep)); } catch { /* memory copy holds */ }
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

const FINISHED_LABEL: Record<string, string> = { done: "✅ Done", failed: "❌ Failed", needs_teammate: "👤 Needs a teammate" };

// Full loads on purpose: both tabs read their ?p= / ?open= once when they
// mount, so a client-side push while already there would not open the card.
function openCard(r: Row) {
  const conv = r.conversation_id ?? "";
  if (conv.startsWith("setup:")) {
    // setup:<onboarding card id>:<step> → that client's Onboarding card.
    const card = conv.split(":")[1];
    if (card) { window.location.assign(`/onboarding?open=${encodeURIComponent(card)}`); return; }
  }
  if (conv.startsWith("pool:")) { window.location.assign("/onboarding#cleanup"); return; }
  window.location.assign(`/ask?p=${encodeURIComponent(r.id)}`);
}

export function MacMiniTracker({ scope }: { scope: TrackerScope }) {
  const { role, loading } = useUser();
  const enabled = !loading && role === "admin";

  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string[]>([]);
  const [notifyPerm, setNotifyPerm] = useState<string>("unsupported");
  const prevActive = useRef<Set<string> | null>(null);
  const inFlight = useRef(false);
  const firstUse = useRef(false);

  useEffect(() => {
    const s = readSeen(scope);
    if (s) setSeen(s); else firstUse.current = true;
    if (typeof Notification !== "undefined") setNotifyPerm(Notification.permission);
  }, [scope]);

  const alertFinished = useCallback((r: Row) => {
    const head = FINISHED_LABEL[r.status] ?? r.status;
    const text = `${r.contact_name}: ${r.summary}`;
    const show = r.status === "done" ? toast.success : toast.error;
    show(`Mac Mini — ${head}`, { description: text, duration: 30_000, action: { label: "Open", onClick: () => openCard(r) } });
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const n = new Notification(`Mac Mini — ${head}`, { body: text, tag: `mini-${r.id}` });
        n.onclick = () => { window.focus(); openCard(r); };
      }
    } catch { /* some browsers only allow notifications from a service worker */ }
  }, []);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`/api/agent/tracker?scope=${scope}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't load the Mac Mini's tasks");
      const d = json as Data;
      // Alert only on a change this page watched happen — a reload or a first
      // load shows earlier results as "unseen" on the pill instead of a burst.
      const prev = prevActive.current;
      if (prev) for (const r of d.finished) if (prev.has(r.id)) alertFinished(r);
      prevActive.current = new Set(d.active.map((r) => r.id));
      // First time in this browser: everything already finished counts as
      // seen, so the pill doesn't open with "finished 20 tasks".
      if (firstUse.current) {
        firstUse.current = false;
        const ids = d.finished.map((r) => r.id);
        setSeen(ids);
        writeSeen(scope, ids);
      }
      setData(d);
      setErr(null);
    } catch (e) {
      setErr(`${e}`.replace("Error: ", ""));
    } finally {
      inFlight.current = false;
    }
  }, [alertFinished, scope]);

  useEffect(() => {
    if (!enabled) return;
    poll();
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      t = setTimeout(async () => { await poll(); loop(); },
        document.visibilityState === "visible" ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
    };
    loop();
    const onBack = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    window.addEventListener(MINI_REFRESH_EVENT, poll);
    return () => {
      clearTimeout(t);
      window.removeEventListener(MINI_REFRESH_EVENT, poll);
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
    };
  }, [enabled, poll]);

  const markSeen = useCallback(() => {
    if (!data) return;
    const ids = Array.from(new Set([...seen, ...data.finished.map((r) => r.id)]));
    setSeen(ids);
    writeSeen(scope, ids);
  }, [data, seen, scope]);

  const askNotify = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    try { setNotifyPerm(await Notification.requestPermission()); } catch { /* ignored */ }
  }, []);

  if (!enabled || !data) return null;

  const online = !!data.worker && Date.now() - Date.parse(data.worker.at) < OFFLINE_MS;
  const running = data.active.filter((r) => r.status === "running");
  const queued = data.active.filter((r) => r.status === "queued_browser");
  const unseen = data.finished.filter((r) => !seen.includes(r.id));
  const unseenFailed = unseen.filter((r) => r.status !== "done").length;
  const stuck = running.some((r) => r.browser_claimed_at && Date.now() - Date.parse(r.browser_claimed_at) > STUCK_MS);

  // Pill: the one line that matters most right now.
  const warn = (!online && data.active.length > 0) || stuck;
  let pill: React.ReactNode;
  if (running.length) pill = <><Loader2 size={12} className="animate-spin shrink-0" /> Mac Mini working · <b className="truncate">{running[0].contact_name}</b>{queued.length > 0 && <span className="opacity-80"> · {queued.length} waiting</span>}</>;
  else if (queued.length) pill = <>⏳ {queued.length} task{queued.length === 1 ? "" : "s"} waiting for the Mac Mini</>;
  else if (unseen.length) pill = <>{unseenFailed ? "❌" : "✅"} Mac Mini finished {unseen.length} task{unseen.length === 1 ? "" : "s"}{unseenFailed ? ` · ${unseenFailed} need${unseenFailed === 1 ? "s" : ""} you` : ""}</>;
  else pill = <>🖥️ Mac Mini {online ? "idle" : "offline"}</>;

  return (
    <div className="fixed z-40 bottom-4 left-4 max-w-[calc(100vw-2rem)] sm:max-w-[400px] flex flex-col items-start gap-2">
      {open && (
        <div className="w-[min(400px,calc(100vw-2rem))] max-h-[60vh] overflow-y-auto rounded-2xl border border-[#e4ebf2] bg-white shadow-xl p-3 space-y-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-[#1f3559]">🖥️ Mac Mini — {scope === "onboarding" ? "onboarding tasks" : "your tasks"}</span>
            <button onClick={() => { setOpen(false); markSeen(); }} title="Close" className="p-1 rounded text-[#8595a8] hover:text-[#e11d48]"><X size={14} /></button>
          </div>

          <div className={cn("rounded-lg border px-2.5 py-1.5", online ? "border-[#bfe3cd] bg-[#f3fbf6] text-[#15803d]" : "border-[#f5c2cf] bg-[#fffafb] text-[#b91c1c]")}>
            {online ? `Online — checked in ${ago(data.worker!.at, Date.now())} ago` : data.worker ? `OFFLINE — last seen ${ago(data.worker.at, Date.now())} ago. Tasks wait in the queue until it's back.` : "Not connected yet"}
          </div>
          {err && <div className="text-[#c2620a]">⚠ {err} (showing the last list)</div>}

          <Section title={`Working now (${running.length})`}>
            {running.length === 0 ? <Empty>Nothing running.</Empty> : running.map((r) => {
              const long = r.browser_claimed_at && Date.now() - Date.parse(r.browser_claimed_at) > STUCK_MS;
              return (
                <TaskRow key={r.id} r={r} tone="run">
                  <Loader2 size={11} className="inline animate-spin mr-1" />
                  {ago(r.browser_claimed_at, Date.now())}{(r.browser_attempts ?? 1) > 1 ? ` · try ${r.browser_attempts} of 2` : ""}
                  {long && <span className="text-[#c2620a]"> · taking long — it retries on its own after 25 min</span>}
                </TaskRow>
              );
            })}
          </Section>

          {queued.length > 0 && (
            <Section title={`Waiting in line (${queued.length})`}>
              {queued.map((r) => <TaskRow key={r.id} r={r} tone="wait">⏳ approved {ago(r.created_at, Date.now())} ago</TaskRow>)}
            </Section>
          )}

          <Section title="Finished — last 12 hours">
            {data.finished.length === 0 ? <Empty>Nothing finished yet.</Empty> : data.finished.map((r) => (
              <TaskRow key={r.id} r={r} tone={r.status === "done" ? "ok" : "bad"} fresh={!seen.includes(r.id)}>
                {FINISHED_LABEL[r.status] ?? r.status} · {ago(r.executed_at, Date.now())} ago
              </TaskRow>
            ))}
          </Section>

          {notifyPerm === "default" && (
            <button onClick={askNotify} className="w-full rounded-lg border border-[#cdeeed] bg-[#f7fdfc] px-2.5 py-1.5 text-[#0e8f88] font-medium hover:bg-[#e6f7f5]">
              🔔 Also alert me on this computer when a task finishes
            </button>
          )}
          {notifyPerm === "denied" && <p className="text-[11px] text-[#8595a8]">Desktop alerts are blocked in this browser — you still get the pop-up inside the dashboard.</p>}
        </div>
      )}

      <button
        onClick={() => { if (open) markSeen(); setOpen((o) => !o); }}
        title="Mac Mini tasks"
        className={cn("flex items-center gap-1.5 max-w-full rounded-full border px-3 py-1.5 text-xs font-medium shadow-md transition-colors",
          warn ? "bg-[#fff7ec] text-[#9a5b00] border-[#fcd9a8]"
            : running.length || queued.length ? "bg-[#15B7AE] text-white border-[#15B7AE]"
            : unseen.length ? (unseenFailed ? "bg-[#fffafb] text-[#b91c1c] border-[#f5c2cf]" : "bg-[#f3fbf6] text-[#15803d] border-[#bfe3cd]")
            : "bg-white text-[#697a91] border-[#e4ebf2]")}>
        <span className="flex items-center gap-1 min-w-0 truncate">{pill}</span>
        {warn && <span className="shrink-0">· {online ? "taking long" : "Mini offline"}</span>}
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8] mb-1">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[#8595a8]">{children}</p>;
}

function TaskRow({ r, tone, fresh, children }: { r: Row; tone: "run" | "wait" | "ok" | "bad"; fresh?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={() => openCard(r)} title="Open this task's card"
      className={cn("w-full text-left rounded-lg border px-2.5 py-1.5 hover:border-[#15B7AE]",
        tone === "run" ? "border-[#bfe8e5] bg-[#f3fcfb]" : tone === "wait" ? "border-[#fcd9a8] bg-[#fff7ec]"
          : tone === "ok" ? "border-[#eef3f8] bg-white" : "border-[#f5c2cf] bg-[#fffafb]")}>
      <div className="flex items-center gap-1.5">
        {fresh && <span className="w-1.5 h-1.5 rounded-full bg-[#e11d48] shrink-0" title="New" />}
        <span className="font-semibold text-[#1f3559] truncate">{r.contact_name}</span>
      </div>
      <div className="text-[#697a91] truncate">{r.summary}</div>
      <div className="text-[11px] text-[#8595a8] mt-0.5">{children}</div>
    </button>
  );
}
