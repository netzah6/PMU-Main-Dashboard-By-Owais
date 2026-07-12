"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

type Stalled = { ownerKey: string; business: string; lastSuccessAt: string | null; error: string | null };

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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ghl/sync-health")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) { setStalled(j.stalled ?? []); setStaleDays(j.staleDays ?? 2); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (dismissed || stalled.length === 0) return null;

  return (
    <div className="mb-3 rounded-xl border border-[#f5c99b] bg-[#fff7ec] p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="text-[#d97706] shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-[#b45309]">
            {stalled.length} client{stalled.length === 1 ? "" : "s"} haven&apos;t synced from GoHighLevel in over {staleDays} days — new leads won&apos;t appear until reconnected.
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {stalled.map((s) => (
              <li key={s.ownerKey} className="text-[11px] text-[#8a5a12] flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-semibold text-[#7c4a0b]">{s.business}</span>
                <span className="text-[#a1783f]">· last synced {ago(s.lastSuccessAt)}</span>
                {s.error && <span className="text-[#b45309]/70 truncate max-w-full" title={s.error}>· {s.error}</span>}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] text-[#a1783f]">Reconnect the marketplace app on the affected sub-account(s) in GoHighLevel, then the next sync backfills them.</p>
        </div>
        <button onClick={() => setDismissed(true)} title="Dismiss" className="p-0.5 rounded text-[#b98a4a] hover:text-[#7c4a0b] shrink-0"><X size={14} /></button>
      </div>
    </div>
  );
}
