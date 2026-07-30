"use client";
import { useEffect, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { Loader2, Search, Trash2, Sparkles, AlertTriangle, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

// Cleanup — wipe an offboarded client's sub-account, rename it into the
// "Clean New Account N" pool (keeps its A2P approval for reuse) and flip the
// client's status in Clients Master from Paused → Offboarded. Admin only.

type Candidate = { id: string; name: string };
type Counts = { contacts: number; customValues: number; customFields: number; calendars: number; users: number; workflows: number; conversations: number; pipelines: number };
type Inspect = { id: string; name: string; counts: Counts; protected: boolean; isPool: boolean };
type SheetClient = { business: string; owner: string; status: string; rowNumber: number } | null;
type StepResult = { found: number; deleted: number; failed: number; error?: string };
type LogRow = { location_id: string; old_name: string; pool_name: string | null; client_business: string | null; sheet_status_change: string | null; cleaned_at: string; cleaned_by: string | null };

const COUNT_LABELS: Array<{ key: keyof Counts; label: string }> = [
  { key: "contacts", label: "Contacts" },
  { key: "customValues", label: "Custom values" },
  { key: "customFields", label: "Custom fields" },
  { key: "calendars", label: "Calendars" },
  { key: "users", label: "Users (this account only)" },
  { key: "conversations", label: "Conversations" },
  { key: "pipelines", label: "Pipelines" },
  { key: "workflows", label: "Automations" },
];

const STEP_LABELS: Record<string, string> = {
  contacts: "Contacts",
  customValues: "Custom values",
  customFields: "Custom fields",
  calendars: "Calendars",
  users: "Users",
  pipelines: "Pipelines",
  conversations: "Conversations",
};

export default function CleanupPage() {
  const { role, loading: roleLoading } = useUser();
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [client, setClient] = useState<SheetClient>(null);
  const [inspecting, setInspecting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [cleaning, setCleaning] = useState(false);
  const [steps, setSteps] = useState<Record<string, StepResult> | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [finalized, setFinalized] = useState<{ oldName: string; poolName: string; sheetChange: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<LogRow[]>([]);

  useEffect(() => {
    if (role !== "admin") return;
    fetch("/api/cleanup?history=1").then((r) => r.json()).then((j) => setHistory(j.history ?? [])).catch(() => {});
  }, [role, finalized, steps]);

  if (roleLoading) return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-[#15B7AE]" /></div>;
  if (role !== "admin") return <div className="p-8 text-sm text-[#697a91]">Admins only.</div>;

  const search = async () => {
    setSearching(true); setError(null); setCandidates(null); setInspect(null); setClient(null); setSteps(null); setFinalized(null); setConfirmName("");
    try {
      const j = await fetch(`/api/cleanup?q=${encodeURIComponent(q)}`).then((r) => r.json());
      if (j.error) throw new Error(j.error);
      setCandidates(j.candidates ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "search failed"); }
    setSearching(false);
  };

  const doInspect = async (id: string) => {
    setInspecting(true); setError(null); setInspect(null); setClient(null); setSteps(null); setFinalized(null); setConfirmName("");
    try {
      const j = await fetch(`/api/cleanup?locationId=${id}`).then((r) => r.json());
      if (j.error) throw new Error(j.error);
      setInspect(j.inspect); setClient(j.client ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "inspect failed"); }
    setInspecting(false);
  };

  const doClean = async () => {
    if (!inspect) return;
    setCleaning(true); setError(null);
    try {
      const j = await fetch("/api/cleanup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clean", locationId: inspect.id, confirmName }),
      }).then((r) => r.json());
      if (j.error) throw new Error(j.error);
      setSteps(j.steps);
    } catch (e) { setError(e instanceof Error ? e.message : "clean failed"); }
    setCleaning(false);
  };

  const doFinalize = async () => {
    if (!inspect) return;
    setFinalizing(true); setError(null);
    try {
      const j = await fetch("/api/cleanup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finalize", locationId: inspect.id }),
      }).then((r) => r.json());
      if (j.error) throw new Error(j.error);
      setFinalized(j);
    } catch (e) { setError(e instanceof Error ? e.message : "finalize failed"); }
    setFinalizing(false);
  };

  const status = (client?.status ?? "").trim();
  const statusLower = status.toLowerCase();
  const cleanedAllZero = inspect && inspect.counts.contacts + inspect.counts.customFields + inspect.counts.customValues + inspect.counts.calendars === 0;

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-[#1e2b3d]">🧹 Sub-account Cleanup</h1>
        <p className="text-sm text-[#697a91] mt-1">
          Wipe an offboarded client&apos;s sub-account, rename it into the <b>Clean New Account</b> pool
          (A2P approval carries over) and mark the client <b>Offboarded</b> in Clients Master.
        </p>
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <input
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q.trim() && search()}
          placeholder="Sub-account name…"
          className="flex-1 px-3 py-2 rounded-lg border border-[#e2e8f0] text-sm focus:outline-none focus:border-[#15B7AE]"
        />
        <button onClick={search} disabled={!q.trim() || searching}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[#15B7AE] text-white hover:bg-[#0e8f88] disabled:opacity-50">
          {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Find
        </button>
      </div>

      {error && <div className="p-3 rounded-lg bg-[#fde8ee] border border-[#f5c2cf] text-sm text-[#e11d48]">{error}</div>}

      {candidates && !inspect && !inspecting && (
        <div className="flex flex-wrap gap-2">
          {candidates.length === 0 && <span className="text-sm text-[#697a91]">No sub-account matches that name.</span>}
          {candidates.map((c) => (
            <button key={c.id} onClick={() => doInspect(c.id)}
              className="px-3 py-1.5 rounded-full border border-[#e2e8f0] text-sm text-[#1e2b3d] hover:border-[#15B7AE] hover:text-[#15B7AE]">
              {c.name}
            </button>
          ))}
        </div>
      )}
      {inspecting && <div className="flex items-center gap-2 text-sm text-[#697a91]"><Loader2 size={14} className="animate-spin" /> Inspecting account…</div>}

      {/* Inspect card */}
      {inspect && (
        <div className="rounded-xl border border-[#e2e8f0] bg-white p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-bold text-[#1e2b3d]">{inspect.name}</div>
              <div className="text-[11px] text-[#9aa8bc] font-mono">{inspect.id}</div>
            </div>
            {client ? (
              <div className="text-right text-xs text-[#697a91]">
                <div><b className="text-[#1e2b3d]">{client.business}</b> — {client.owner}</div>
                <div className="mt-1">
                  Sheet status:{" "}
                  <span className={cn("px-2 py-0.5 rounded-full border font-semibold",
                    statusLower === "paused" ? "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]"
                    : statusLower === "live" ? "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]"
                    : "bg-[#f1f5f9] text-[#697a91] border-[#e2e8f0]")}>
                    {status || "—"}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-xs text-[#9aa8bc]">No Clients Master match</div>
            )}
          </div>

          {inspect.protected && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-[#fde8ee] border border-[#f5c2cf] text-sm text-[#e11d48]">
              <AlertTriangle size={15} /> Protected location — can never be cleaned.
            </div>
          )}
          {inspect.isPool && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-[#e7f6ec] border border-[#bfe3cd] text-sm text-[#15803d]">
              <Sparkles size={15} /> Already in the clean pool.
            </div>
          )}
          {statusLower === "live" && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-[#fde8ee] border border-[#f5c2cf] text-sm text-[#e11d48]">
              <AlertTriangle size={15} /> This client is LIVE in Clients Master — cleaning is blocked.
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {COUNT_LABELS.map(({ key, label }) => (
              <div key={key} className={cn("rounded-lg border p-2.5 text-center",
                inspect.counts[key] > 0 ? "border-[#fcd9a8] bg-[#fff7ec]" : "border-[#e2e8f0] bg-[#f8fafc]")}>
                <div className="text-lg font-bold text-[#1e2b3d]">{inspect.counts[key]}</div>
                <div className="text-[10px] text-[#697a91] leading-tight">{label}</div>
              </div>
            ))}
          </div>
          {inspect.counts.workflows > 0 && (
            <p className="text-xs text-[#d97706]">
              ⚠ {inspect.counts.workflows} automation{inspect.counts.workflows > 1 ? "s" : ""} exist — GHL&apos;s API can&apos;t delete
              workflows, so remove them in the GHL UI (Automation tab) or ask Claude to do it in the browser.
            </p>
          )}

          {/* Clean */}
          {!inspect.protected && !inspect.isPool && statusLower !== "live" && !steps && (
            <div className="pt-2 border-t border-[#f1f5f9] space-y-2">
              <p className="text-xs text-[#697a91]">
                Type the sub-account name to confirm — this permanently deletes everything listed above (except automations).
              </p>
              <div className="flex gap-2">
                <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={inspect.name}
                  className="flex-1 px-3 py-2 rounded-lg border border-[#e2e8f0] text-sm focus:outline-none focus:border-[#e11d48]" />
                <button onClick={doClean} disabled={cleaning || confirmName.trim().toLowerCase() !== inspect.name.toLowerCase()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[#e11d48] text-white hover:bg-[#be123c] disabled:opacity-40">
                  {cleaning ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  {cleaning ? "Cleaning…" : "Clean sub-account"}
                </button>
              </div>
            </div>
          )}

          {/* Step results */}
          {steps && (
            <div className="pt-2 border-t border-[#f1f5f9] space-y-1.5">
              {Object.entries(steps).map(([k, s]) => (
                <div key={k} className="flex items-center gap-2 text-sm">
                  {s.failed === 0 && !s.error ? <Check size={14} className="text-[#15803d]" /> : <X size={14} className="text-[#e11d48]" />}
                  <span className="text-[#1e2b3d] font-medium">{STEP_LABELS[k] ?? k}:</span>
                  <span className="text-[#697a91]">
                    {s.deleted}/{s.found} deleted{s.failed > 0 ? `, ${s.failed} failed` : ""}
                  </span>
                  {s.error && <span className="text-xs text-[#e11d48]">{s.error}</span>}
                </div>
              ))}
              <p className="text-[11px] text-[#9aa8bc] pt-1">
                Google-review threads are invisible to the API — if the GHL Conversations &quot;All&quot; tab still shows
                old reviews, ask Claude to clear them in the browser. Same for automations and pipelines.
              </p>
            </div>
          )}

          {/* Finalize */}
          {!inspect.protected && !inspect.isPool && (steps || cleanedAllZero) && !finalized && (
            <div className="pt-2 border-t border-[#f1f5f9]">
              <button onClick={doFinalize} disabled={finalizing}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[#15B7AE] text-white hover:bg-[#0e8f88] disabled:opacity-50">
                {finalizing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {finalizing ? "Finalizing…" : "Rename to pool + mark Offboarded"}
              </button>
            </div>
          )}
          {finalized && (
            <div className="p-3 rounded-lg bg-[#e7f6ec] border border-[#bfe3cd] text-sm text-[#15803d] space-y-1">
              <div><b>{finalized.oldName}</b> → <b>{finalized.poolName}</b> ✓ added to the clean pool</div>
              <div className="text-xs">Clients Master: {finalized.sheetChange}</div>
            </div>
          )}
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className="rounded-xl border border-[#e2e8f0] bg-white overflow-hidden">
          <div className="px-4 py-2.5 text-xs font-bold text-[#697a91] uppercase tracking-wide border-b border-[#f1f5f9]">Cleanup history</div>
          <div className="divide-y divide-[#f1f5f9]">
            {history.map((h) => (
              <div key={h.location_id} className="px-4 py-2.5 text-sm flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium text-[#1e2b3d]">{h.old_name}</span>
                {h.pool_name && <span className="text-[#15B7AE] font-medium">→ {h.pool_name}</span>}
                <span className="text-xs text-[#9aa8bc] ml-auto">
                  {new Date(h.cleaned_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  {h.cleaned_by ? ` · ${h.cleaned_by}` : ""}
                </span>
                {h.sheet_status_change && <span className="w-full text-[11px] text-[#697a91]">{h.sheet_status_change}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
