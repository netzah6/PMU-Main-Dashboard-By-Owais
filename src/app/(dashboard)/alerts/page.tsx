"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AlertRow } from "@/lib/alerts";

// Admin-only Alerts board — the CEO's notification center. Crons file alerts
// for: compliance opt-out footers going to leads, upset/churn-risk clients,
// and Make.com scenarios that are off or piling up failed runs.

const TYPE_META: Record<string, { label: string; icon: string; chip: string }> = {
  compliance_text: { label: "Bot-looking texts", icon: "🤖", chip: "bg-rose-50 text-rose-700 border-rose-200" },
  upset_client: { label: "Upset client", icon: "🔥", chip: "bg-orange-50 text-orange-700 border-orange-200" },
  make_scenario: { label: "Make.com automation", icon: "⚙️", chip: "bg-amber-50 text-amber-800 border-amber-200" },
};

function typeMeta(t: string) {
  return TYPE_META[t] ?? { label: t, icon: "⚠️", chip: "bg-slate-50 text-slate-700 border-slate-200" };
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function AlertCard({ a, onAction, busy }: { a: AlertRow; onAction: (id: string, action: "resolve" | "reopen") => void; busy: boolean }) {
  const m = typeMeta(a.type);
  const [expanded, setExpanded] = useState(false);
  const open = a.status === "open";
  return (
    <div className={cn("rounded-xl border bg-white p-3 sm:p-4", open ? "border-[#e4ebf2]" : "border-[#eef2f6] opacity-70")}>
      <div className="flex items-start gap-2 flex-wrap">
        <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border whitespace-nowrap", m.chip)}>
          {m.icon} {m.label}
        </span>
        {a.severity === "high" && open && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-red-50 text-red-700 border-red-200">HIGH</span>
        )}
        <span className="text-[11px] text-[#8595a8] ml-auto whitespace-nowrap">
          {open ? ago(a.created_at) : `resolved ${a.resolved_at ? ago(a.resolved_at) : ""}${a.resolved_by ? ` by ${a.resolved_by.split("@")[0]}` : ""}`}
        </span>
      </div>
      <div className="mt-2 text-sm font-semibold text-[#1c2f4a]">{a.title}</div>
      {a.detail && (
        <div className={cn("mt-1 text-[13px] text-[#5a6b82] whitespace-pre-wrap", !expanded && "line-clamp-3")}>
          {a.detail}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        {a.detail && a.detail.length > 160 && (
          <button onClick={() => setExpanded((v) => !v)} className="text-xs font-semibold text-[#34568a] hover:text-[#0e8f88]">
            {expanded ? "Less" : "More"}
          </button>
        )}
        <button
          onClick={() => onAction(a.id, open ? "resolve" : "reopen")}
          disabled={busy}
          className={cn(
            "ml-auto px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50",
            open
              ? "bg-[#15B7AE] text-white border-[#15B7AE] hover:bg-[#0e8f88]"
              : "bg-white text-[#34568a] border-[#d7e0ea] hover:border-[#15B7AE]"
          )}
        >
          {open ? "Resolve" : "Reopen"}
        </button>
      </div>
    </div>
  );
}

export default function AlertsPage() {
  const { role, loading: roleLoading } = useUser();
  const [open, setOpen] = useState<AlertRow[]>([]);
  const [resolved, setResolved] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const r = await fetch("/api/alerts");
      if (r.ok) {
        const j = (await r.json()) as { open: AlertRow[]; resolved: AlertRow[] };
        setOpen(j.open ?? []);
        setResolved(j.resolved ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (role === "admin") load(); }, [role, load]);

  // Fresh alerts without anyone touching anything — same pattern as the AI tab.
  useEffect(() => {
    if (role !== "admin") return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load({ silent: true });
    }, 60_000);
    return () => clearInterval(t);
  }, [role, load]);

  const onAction = async (id: string, action: "resolve" | "reopen") => {
    setBusyId(id);
    try {
      await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      await load({ silent: true });
    } finally {
      setBusyId(null);
    }
  };

  const types = useMemo(() => Array.from(new Set(open.map((a) => a.type))), [open]);
  const listed = filter === "all" ? open : open.filter((a) => a.type === filter);

  if (roleLoading) return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-[#15B7AE]" /></div>;
  if (role !== "admin") return <div className="p-8 text-sm text-[#697a91]">Admins only.</div>;

  return (
    <div className="p-3 sm:p-5 max-w-3xl mx-auto w-full">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-bold text-[#1c2f4a]">🚨 Alerts</h1>
        <span className={cn(
          "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold",
          open.length ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"
        )}>
          {open.length ? `${open.length} open` : "all clear"}
        </span>
        <button onClick={() => load()} title="Refresh" className="ml-auto p-1.5 rounded-lg border border-[#d7e0ea] text-[#34568a] hover:border-[#15B7AE]">
          <RefreshCw size={14} className={cn(loading && "animate-spin")} />
        </button>
      </div>
      <p className="mt-1 text-xs text-[#8595a8]">
        Auto-checks every few minutes: bot-looking &quot;Reply STOP&quot; texts to leads, clients who sound like they want to leave, and Make.com automations that stopped running.
      </p>

      {types.length > 1 && (
        <div className="mt-3 flex gap-1.5 flex-wrap">
          {["all", ...types].map((t) => (
            <button key={t} onClick={() => setFilter(t)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-semibold border",
                filter === t ? "bg-[#15B7AE] text-white border-[#15B7AE]" : "bg-white text-[#34568a] border-[#d7e0ea]"
              )}>
              {t === "all" ? `All (${open.length})` : `${typeMeta(t).icon} ${typeMeta(t).label} (${open.filter((a) => a.type === t).length})`}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 space-y-2">
        {loading && !open.length ? (
          <div className="flex justify-center p-8"><Loader2 className="animate-spin text-[#15B7AE]" /></div>
        ) : listed.length ? (
          listed.map((a) => <AlertCard key={a.id} a={a} onAction={onAction} busy={busyId === a.id} />)
        ) : (
          <div className="rounded-xl border border-dashed border-[#d7e0ea] p-8 text-center text-sm text-[#8595a8]">
            ✅ Nothing on fire. New alerts show up here on their own.
          </div>
        )}
      </div>

      {resolved.length > 0 && (
        <div className="mt-6">
          <button onClick={() => setShowResolved((v) => !v)} className="text-xs font-semibold text-[#8595a8] hover:text-[#34568a]">
            {showResolved ? "▾" : "▸"} Resolved ({resolved.length})
          </button>
          {showResolved && (
            <div className="mt-2 space-y-2">
              {resolved.map((a) => <AlertCard key={a.id} a={a} onAction={onAction} busy={busyId === a.id} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
