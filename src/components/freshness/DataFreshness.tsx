"use client";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { RefreshCw, Loader2 } from "lucide-react";
import { useUser } from "@/lib/hooks/useUser";

// When each tab of the Facebook Campaign Stats workbook last synced. Green
// when a tab is from TODAY (Pacific), red when it is from any past day — and
// a stale tab is called out on its own line above the pills so it cannot hide
// behind the others. The old version read only the 7-day tab, so a stalled
// 14- or 30-day sync showed a green badge (that is how Aug 20-25 slipped by).
//
// Refresh now runs the same sync the 5/6 AM cron runs, on demand.

const TABS: Array<{ key: string; label: string }> = [
  { key: "cpl_7days", label: "7 Days CPL" },
  { key: "cpl_14days", label: "14 Days CPL" },
  { key: "cpl_30days", label: "30 Days CPL" },
  { key: "campaign_spent", label: "Spend" },
];

const TZ = "America/Los_Angeles";
const dayOf = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TZ });
const timeOf = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const dateOf = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });

export function DataFreshness({ onRefreshed }: { onRefreshed?: () => void } = {}) {
  const { role } = useUser();
  const [rows, setRows] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await createClient().from("data_freshness").select("key, synced_at");
    const m: Record<string, string | null> = {};
    for (const r of (data ?? []) as Array<{ key: string; synced_at: string | null }>) m[r.key] = r.synced_at;
    setRows(m);
  }, []);
  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/cron/sync-cpl");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const bad = (j.results ?? []).filter((x: { status?: string }) => x.status !== "ok");
      setMsg(bad.length ? `⚠ ${bad.length} tab${bad.length === 1 ? "" : "s"} failed to sync` : "All four tabs re-pulled from the sheet.");
      await load();
      onRefreshed?.();
    } catch (e) { setMsg(`Refresh failed: ${e instanceof Error ? e.message : "unknown"}`); }
    finally { setBusy(false); }
  };

  if (!Object.keys(rows).length) return null;
  const today = dayOf(new Date());
  const status = TABS.map((t) => {
    const at = rows[t.key] ? new Date(rows[t.key]!) : null;
    return { ...t, at, fresh: !!at && dayOf(at) === today };
  });
  const stale = status.filter((s) => !s.fresh);

  return (
    <div className="flex flex-col gap-1.5">
      {/* A stale tab gets its own red line, first — that is the whole point. */}
      {stale.length > 0 && (
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold border bg-[#fde8ee] text-[#be123c] border-[#f5c2cf] w-fit">
          ⚠ Not refreshed today:{" "}
          {stale.map((s) => `${s.label}${s.at ? ` (last ${dateOf(s.at)} ${timeOf(s.at)})` : " (never)"}`).join(" · ")}
        </div>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        {status.map((s) => (
          <span key={s.key}
            title={s.at ? `${s.label} — last synced ${dateOf(s.at)} at ${timeOf(s.at)} Pacific` : `${s.label} — never synced`}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border ${
              s.fresh ? "bg-[#e6f7ee] text-[#15803d] border-[#86efac]" : "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${s.fresh ? "bg-[#22c55e]" : "bg-[#e11d48]"}`} />
            {s.label} {s.at ? (s.fresh ? timeOf(s.at) : dateOf(s.at)) : "—"}
          </span>
        ))}
        {role === "admin" && (
          <button onClick={refresh} disabled={busy} title="Pull all four tabs from the Google Sheet right now (about 10 seconds)"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border border-[#d7e0ea] bg-white text-[#34568a] hover:bg-[#f6f9fc] disabled:opacity-60">
            {busy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} {busy ? "Pulling…" : "Refresh now"}
          </button>
        )}
        {msg && <span className="text-[11px] text-[#697a91]">{msg}</span>}
      </div>
    </div>
  );
}
