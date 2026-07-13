"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, X, RefreshCw, Check, BellOff } from "lucide-react";

type Stalled = { ownerKey: string; business: string; lastSuccessAt: string | null; error: string | null };
type ResyncState = "idle" | "running" | "done" | "error";

function ago(iso: string | null): string {
  if (!iso) return "never synced";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days >= 1) return `${days}d ago`;
  const hrs = Math.max(1, Math.floor((Date.now() - Date.parse(iso)) / 3600000));
  return `${hrs}h ago`;
}

// Admin-only warning: lists client sub-accounts whose GoHighLevel sync has
// stalled, so missing leads (like a sub-account the marketplace app lost access
// to) are visible instead of silently absent. Renders nothing for non-admins,
// when nothing is stalled, or once dismissed for the session.
export function SyncHealthBanner() {
  const [stalled, setStalled] = useState<Stalled[]>([]);
  const [staleDays, setStaleDays] = useState(2);
  const [dismissed, setDismissed] = useState(false);
  const [resync, setResync] = useState<Record<string, { state: ResyncState; msg?: string }>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ghl/sync-health")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) { setStalled(j.stalled ?? []); setStaleDays(j.staleDays ?? 2); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Permanently silence an account (e.g. a client we've chosen not to
  // reconnect). Server-side flag — survives reloads; the daily ingest still
  // retries it, so a reconnected account resumes flowing automatically.
  const doIgnore = async (ownerKey: string) => {
    setStalled((list) => list.filter((x) => x.ownerKey !== ownerKey)); // optimistic
    try {
      await fetch("/api/ghl/sync-health/mute", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerKey, muted: true }),
      });
    } catch { /* banner reappears next load if it failed */ }
  };

  const doResync = async (ownerKey: string) => {
    setResync((s) => ({ ...s, [ownerKey]: { state: "running" } }));
    try {
      const res = await fetch("/api/ghl/sync-health/resync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerKey }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Resync failed");
      const n = j.stat?.contacts ?? 0;
      setResync((s) => ({ ...s, [ownerKey]: { state: "done", msg: `pulled ${n} lead${n === 1 ? "" : "s"}` } }));
      // Clear it from the list once it's recovered.
      setTimeout(() => setStalled((list) => list.filter((x) => x.ownerKey !== ownerKey)), 2500);
    } catch (e) {
      setResync((s) => ({ ...s, [ownerKey]: { state: "error", msg: `${e}`.replace("Error: ", "") } }));
    }
  };

  if (dismissed || stalled.length === 0) return null;

  return (
    <div className="mb-3 rounded-xl border border-[#f5c99b] bg-[#fff7ec] p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="text-[#d97706] shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-[#b45309]">
            {stalled.length} client{stalled.length === 1 ? "" : "s"} haven&apos;t synced from GoHighLevel in over {staleDays} days — new leads won&apos;t appear until reconnected.
          </p>
          <ul className="mt-1.5 space-y-1">
            {stalled.map((s) => {
              const r = resync[s.ownerKey] ?? { state: "idle" as ResyncState };
              return (
                <li key={s.ownerKey} className="text-[11px] text-[#8a5a12] flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className="font-semibold text-[#7c4a0b]">{s.business}</span>
                  <span className="text-[#a1783f]">· last synced {ago(s.lastSuccessAt)}</span>
                  {s.error && <span className="text-[#b45309]/70 truncate max-w-[40ch]" title={s.error}>· {s.error}</span>}
                  {r.state === "done" ? (
                    <span className="inline-flex items-center gap-1 text-[#15803d] font-semibold"><Check size={11} /> {r.msg}</span>
                  ) : r.state === "error" ? (
                    <button onClick={() => doResync(s.ownerKey)} className="inline-flex items-center gap-1 text-[#b91c1c] font-semibold hover:underline" title={r.msg}>
                      <RefreshCw size={11} /> retry ({r.msg})
                    </button>
                  ) : (
                    <button onClick={() => doResync(s.ownerKey)} disabled={r.state === "running"}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#e0b877] bg-white text-[#b45309] font-semibold hover:bg-[#fff3e0] disabled:opacity-60">
                      <RefreshCw size={11} className={r.state === "running" ? "animate-spin" : ""} /> {r.state === "running" ? "Resyncing…" : "Resync now"}
                    </button>
                  )}
                  {r.state === "idle" && (
                    <button onClick={() => doIgnore(s.ownerKey)}
                      title="Stop flagging this client (it stays unsynced on purpose). Data resumes automatically if it's ever reconnected."
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#e3d9c8] bg-white text-[#8a5a12] hover:bg-[#faf5ec]">
                      <BellOff size={11} /> Ignore
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[10px] text-[#a1783f]">Reconnect the marketplace app on the affected sub-account in GoHighLevel, then click <strong>Resync now</strong> to backfill every missed lead (or wait for the next daily sync).</p>
        </div>
        <button onClick={() => setDismissed(true)} title="Dismiss" className="p-0.5 rounded text-[#b98a4a] hover:text-[#7c4a0b] shrink-0"><X size={14} /></button>
      </div>
    </div>
  );
}
