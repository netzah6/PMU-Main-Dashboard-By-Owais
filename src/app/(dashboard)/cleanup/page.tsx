"use client";
import { useEffect, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { Loader2, Search, Trash2, Sparkles, AlertTriangle, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

// Cleanup — wipe an offboarded client's sub-account, rename it into the
// "Clean New Account N" pool (keeps its A2P approval for reuse) and flip the
// client's status in Clients Master from Paused → Offboarded. Admin only.

type Candidate = { id: string; name: string };
type Counts = { contacts: number; customValues: number; customFields: number; calendars: number; users: number; workflows: number; conversations: number; pipelines: number; funnels: number };
type Inspect = { id: string; name: string; counts: Counts; protected: boolean; isPool: boolean };
type SheetClient = { business: string; owner: string; status: string; rowNumber: number } | null;
type StepResult = { found: number; deleted: number; failed: number; error?: string };
type LogRow = { location_id: string; old_name: string; pool_name: string | null; client_business: string | null; sheet_status_change: string | null; cleaned_at: string; cleaned_by: string | null };
type PoolRow = {
  location_id: string; pool_name: string; status: string;
  used_as: string | null; used_at: string | null; a2p: string;
  workflows: number | null; dirty: number | null;
  clean_checked_at: string | null; clean_note: string | null;
};

type Readiness = "ready" | "partial" | "dirty" | "unknown";

// Green only when the account is genuinely empty AND A2P-approved, because the
// chip is what the team acts on — anything less has to look different.
function readinessOf(p: PoolRow): Readiness {
  if (p.clean_checked_at == null || p.workflows == null || p.dirty == null) return "unknown";
  if (p.dirty > 0) return "dirty";
  if (p.workflows > 0) return "partial";
  return p.a2p === "approved" ? "ready" : "partial";
}

const READINESS: Record<Readiness, { label: string; chip: string; text: string }> = {
  ready:   { label: "Ready to use", chip: "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd] hover:bg-[#d7efdf]", text: "text-[#15803d]" },
  partial: { label: "Nearly ready", chip: "bg-[#fff3e6] text-[#c2410c] border-[#fdba74] hover:bg-[#ffe8d1]", text: "text-[#c2410c]" },
  dirty:   { label: "Not clean",    chip: "bg-[#fef2f2] text-[#b91c1c] border-[#fca5a5] hover:bg-[#fee2e2]", text: "text-[#b91c1c]" },
  unknown: { label: "Not checked",  chip: "bg-[#f1f5f9] text-[#697a91] border-[#e2e8f0] hover:bg-[#e8eef5]", text: "text-[#697a91]" },
};

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// One line of the bulk list, from the typed name through to its final result.
type BulkRow = {
  typed: string;
  id?: string;
  name?: string;
  sheetStatus?: string;
  owner?: string; // client's full name from Clients Master
  counts?: Counts;
  state: "resolving" | "ready" | "skip" | "cleaning" | "cleaned" | "finalizing" | "done" | "error";
  note?: string;
  poolName?: string;
};

const COUNT_LABELS: Array<{ key: keyof Counts; label: string }> = [
  { key: "contacts", label: "Contacts" },
  { key: "customValues", label: "Custom values" },
  { key: "customFields", label: "Custom fields" },
  { key: "calendars", label: "Calendars" },
  { key: "users", label: "Users (this account only)" },
  { key: "conversations", label: "Conversations" },
  { key: "pipelines", label: "Pipelines" },
  { key: "funnels", label: "Funnels" },
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
  const [cleanNote, setCleanNote] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, StepResult> | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [finalized, setFinalized] = useState<{ oldName: string; poolName: string; sheetChange: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<LogRow[]>([]);
  const [pool, setPool] = useState<{ available: PoolRow[]; used: PoolRow[] } | null>(null);
  const [poolLoading, setPoolLoading] = useState(false);
  const [a2pSaving, setA2pSaving] = useState<string | null>(null);
  const [recheck, setRecheck] = useState<{ done: number; total: number } | null>(null);
  // Bulk mode — paste a list of sub-account names, wipe them one after another.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkRows, setBulkRows] = useState<BulkRow[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState("");

  useEffect(() => {
    if (role !== "admin") return;
    fetch("/api/cleanup?history=1").then((r) => r.json()).then((j) => setHistory(j.history ?? [])).catch(() => {});
  }, [role, finalized, steps]);

  // Pool inventory — re-synced on load and after each finalize, so a clean
  // account claimed for a setup drops out of "available" on its own.
  useEffect(() => {
    if (role !== "admin") return;
    setPoolLoading(true);
    fetch("/api/cleanup?pool=1")
      .then((r) => r.json())
      .then((j) => setPool({ available: j.available ?? [], used: j.used ?? [] }))
      .catch(() => {})
      .finally(() => setPoolLoading(false));
  }, [role, finalized]);

  const poolReadyCount = pool?.available.filter((p) => readinessOf(p) === "ready").length ?? 0;
  const partialCount = pool?.available.filter((p) => readinessOf(p) === "partial").length ?? 0;
  const dirtyCount = pool?.available.filter((p) => readinessOf(p) === "dirty").length ?? 0;
  const uncheckedCount = pool?.available.filter((p) => readinessOf(p) === "unknown").length ?? 0;

  // Optimistic flip so the chip recolors instantly; the row is persisted server-side.
  const toggleA2p = async (row: PoolRow) => {
    const next = row.a2p === "approved" ? "pending" : "approved";
    setA2pSaving(row.location_id);
    setPool((prev) =>
      prev
        ? { ...prev, available: prev.available.map((p) => (p.location_id === row.location_id ? { ...p, a2p: next } : p)) }
        : prev
    );
    try {
      await fetch("/api/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "a2p", locationId: row.location_id, a2p: next }),
      });
    } catch {
      setPool((prev) =>
        prev
          ? { ...prev, available: prev.available.map((p) => (p.location_id === row.location_id ? { ...p, a2p: row.a2p } : p)) }
          : prev
      );
    }
    setA2pSaving(null);
  };

  // Re-inspect every available pool account so the colours reflect what's
  // actually in them right now. Batched — one inspect is ~10 GHL calls, so the
  // whole pool in one request would run past the serverless limit.
  const recheckPool = async () => {
    const ids = (pool?.available ?? []).map((p) => p.location_id);
    if (!ids.length) return;
    setRecheck({ done: 0, total: ids.length });
    const merged = new Map<string, PoolRow>();
    for (let i = 0; i < ids.length; i += 8) {
      const batch = ids.slice(i, i + 8);
      try {
        const j = await fetch("/api/cleanup", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "refreshPool", locationIds: batch }),
        }).then((r) => r.json());
        for (const row of (j.rows ?? []) as PoolRow[]) merged.set(row.location_id, row);
      } catch { /* keep going — a failed batch just stays "not checked" */ }
      setRecheck({ done: Math.min(i + 8, ids.length), total: ids.length });
      setPool((prev) => prev && {
        ...prev,
        available: prev.available.map((p) => merged.get(p.location_id) ?? p),
      });
    }
    setRecheck(null);
    // Re-sync afterwards: an account a teammate claimed mid-check should drop
    // out of "available" rather than linger as a green chip.
    fetch("/api/cleanup?pool=1").then((r) => r.json())
      .then((j) => setPool({ available: j.available ?? [], used: j.used ?? [] })).catch(() => {});
  };

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  // A wipe with hundreds of contacts can outrun the serverless time limit; the
  // platform then answers with an error page instead of JSON. That's a pause,
  // not a failure — everything deleted so far stays deleted — so treat it as
  // "resume needed" rather than surfacing a JSON parse error.
  const cleanOnce = async (
    locationId: string,
    confirmName: string
  ): Promise<{ timedOut: boolean; error?: string; steps?: Record<string, StepResult> }> => {
    try {
      const r = await fetch("/api/cleanup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clean", locationId, confirmName }),
      });
      const text = await r.text();
      try {
        const j = JSON.parse(text);
        return { timedOut: false, error: j.error, steps: j.steps };
      } catch {
        return { timedOut: true };
      }
    } catch {
      return { timedOut: true };
    }
  };

  const apiWipeLeft = (c: Counts) =>
    c.contacts + c.customValues + c.customFields + c.calendars + c.users + c.conversations;

  // Keep passing over an account until the API-deletable side is empty or a
  // pass stops making progress.
  const cleanUntilDone = async (
    locationId: string,
    confirmName: string,
    onPass?: (pass: number, left: number) => void
  ): Promise<{ counts: Counts; steps?: Record<string, StepResult>; error?: string }> => {
    const countsNow = async () =>
      (await fetch(`/api/cleanup?locationId=${locationId}`).then((r) => r.json())).inspect.counts as Counts;
    let last = Infinity;
    let counts: Counts | null = null;
    let steps: Record<string, StepResult> | undefined;
    for (let pass = 1; pass <= 8; pass++) {
      const res = await cleanOnce(locationId, confirmName);
      if (res.error) return { counts: counts ?? (await countsNow()), steps, error: res.error };
      if (res.steps) steps = res.steps;
      counts = await countsNow();
      const left = apiWipeLeft(counts);
      onPass?.(pass, left);
      if (left === 0) break;
      if (left >= last) break; // a pass that changed nothing won't be helped by another
      last = left;
    }
    return { counts: counts!, steps };
  };
  // Everything that must reach zero before an account may join the pool.
  // Automations count: GHL exposes no delete for them (workflows.readonly is
  // the only scope, and their screen is an iframe that ignores automation), so
  // they're cleared by hand — but a pool account with live workflows isn't
  // clean, so pooling stays blocked until they're gone.
  const blockersOf = (c?: Counts) =>
    !c ? 1 : c.contacts + c.customValues + c.customFields + c.calendars + c.users + c.conversations + c.pipelines + c.workflows + (c.funnels > 0 ? c.funnels : 0);

  // Look each typed name up and pull its counts, so nothing is wiped before
  // you can see what it is and whether it's safe to touch.
  const resolveBulk = async () => {
    const names = bulkText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    setBulkRows(names.map((typed) => ({ typed, state: "resolving" as const })));
    setBulkConfirm("");
    for (let i = 0; i < names.length; i++) {
      const typed = names[i];
      try {
        const s = await fetch(`/api/cleanup?q=${encodeURIComponent(typed)}`).then((r) => r.json());
        const cands: Candidate[] = s.candidates ?? [];
        const hit = cands.find((c) => norm(c.name) === norm(typed)) ?? cands[0];
        if (!hit) {
          setBulkRows((prev) => prev!.map((r, idx) => (idx === i ? { ...r, state: "error", note: "no sub-account with that name" } : r)));
          continue;
        }
        const j = await fetch(`/api/cleanup?locationId=${hit.id}`).then((r) => r.json());
        const counts: Counts = j.inspect.counts;
        const sheetStatus: string = j.client?.status ?? "";
        const owner: string = j.client?.owner ?? "";
        const live = sheetStatus.trim().toLowerCase() === "live";
        setBulkRows((prev) =>
          prev!.map((r, idx) =>
            idx === i
              ? {
                  ...r, id: hit.id, name: j.inspect.name, counts, sheetStatus, owner,
                  // Pool accounts are cleanable — being pooled never meant empty.
                  state: j.inspect.protected ? "skip" : live ? "skip" : "ready",
                  note: j.inspect.protected ? "protected account" : live ? "client is LIVE" : j.inspect.isPool ? "pool account — re-clean" : undefined,
                }
              : r
          )
        );
      } catch (e) {
        setBulkRows((prev) => prev!.map((r, idx) => (idx === i ? { ...r, state: "error", note: e instanceof Error ? e.message : "lookup failed" } : r)));
      }
    }
  };

  // Wipe one account at a time — each gets its own request, so a big account
  // can't eat the whole batch's time budget.
  const runBulkClean = async () => {
    if (!bulkRows) return;
    setBulkBusy("clean");
    for (let i = 0; i < bulkRows.length; i++) {
      const row = bulkRows[i];
      if (row.state !== "ready" || !row.id) continue;
      setBulkRows((prev) => prev!.map((r, idx) => (idx === i ? { ...r, state: "cleaning", note: undefined } : r)));
      try {
        const { counts, error } = await cleanUntilDone(row.id, row.name!, (pass, left) =>
          setBulkRows((prev) =>
            prev!.map((r, idx) => (idx === i ? { ...r, note: left > 0 ? `pass ${pass} — ${left} left, resuming…` : undefined } : r))
          )
        );
        if (error) throw new Error(error);
        setBulkRows((prev) => prev!.map((r, idx) => (idx === i ? { ...r, state: "cleaned", counts, note: undefined } : r)));
      } catch (e) {
        setBulkRows((prev) => prev!.map((r, idx) => (idx === i ? { ...r, state: "error", note: e instanceof Error ? e.message : "clean failed" } : r)));
      }
    }
    setBulkBusy(null);
  };

  const runBulkFinalize = async () => {
    if (!bulkRows) return;
    setBulkBusy("finalize");
    for (let i = 0; i < bulkRows.length; i++) {
      const row = bulkRows[i];
      if (row.state !== "cleaned" || !row.id || blockersOf(row.counts) > 0) continue;
      setBulkRows((prev) => prev!.map((r, idx) => (idx === i ? { ...r, state: "finalizing" } : r)));
      try {
        const res = await fetch("/api/cleanup", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "finalize", locationId: row.id }),
        }).then((r) => r.json());
        if (res.error) throw new Error(res.error);
        setBulkRows((prev) => prev!.map((r, idx) => (idx === i ? { ...r, state: "done", poolName: res.poolName, note: res.sheetChange } : r)));
      } catch (e) {
        setBulkRows((prev) => prev!.map((r, idx) => (idx === i ? { ...r, state: "error", note: e instanceof Error ? e.message : "finalize failed" } : r)));
      }
    }
    setBulkBusy(null);
    setFinalized({ oldName: "", poolName: "", sheetChange: "" }); // refresh pool + history
  };

  const readyCount = bulkRows?.filter((r) => r.state === "ready").length ?? 0;
  const finalizableCount = bulkRows?.filter((r) => r.state === "cleaned" && blockersOf(r.counts) === 0).length ?? 0;

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
    setCleaning(true); setError(null); setCleanNote(null);
    try {
      const { counts, steps: s, error: err } = await cleanUntilDone(inspect.id, confirmName, (pass, left) =>
        setCleanNote(left > 0 ? `Pass ${pass} done — ${left} records left, resuming…` : null)
      );
      if (err) throw new Error(err);
      setCleanNote(null);
      setSteps(s ?? null);
      setInspect({ ...inspect, counts });
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

      {/* Pool inventory */}
      <div className="rounded-xl border border-[#e2e8f0] bg-white p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-[#15803d]">
              {poolLoading && !pool ? "…" : poolReadyCount}
            </span>
            <span className="text-sm font-semibold text-[#1e2b3d]">ready to use</span>
            {poolLoading && pool && <Loader2 size={12} className="animate-spin text-[#9aa8bc]" />}
          </div>
          <div className="flex items-center gap-3 text-xs text-[#697a91]">
            {pool && partialCount > 0 && <span className="text-[#c2410c]">{partialCount} nearly ready</span>}
            {pool && dirtyCount > 0 && <span className="text-[#b91c1c]">{dirtyCount} not clean</span>}
            {pool && uncheckedCount > 0 && <span>{uncheckedCount} not checked</span>}
            <span>{pool?.available.length ?? 0} in pool</span>
            {pool && pool.used.length > 0 && <span>{pool.used.length} used</span>}
            <button
              onClick={recheckPool}
              disabled={!!recheck || !pool?.available.length}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2] disabled:opacity-50"
            >
              {recheck
                ? <><Loader2 size={11} className="animate-spin" /> {recheck.done}/{recheck.total}</>
                : <>Re-check</>}
            </button>
          </div>
        </div>

        {pool && pool.available.length > 0 && (
          <>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {pool.available.map((p) => {
                const state = readinessOf(p);
                const s = READINESS[state];
                return (
                  <button
                    key={p.location_id}
                    onClick={() => toggleA2p(p)}
                    disabled={a2pSaving === p.location_id}
                    title={`${s.label}${p.clean_note ? ` — ${p.clean_note}` : ""}${
                      p.a2p === "approved" ? " · A2P approved" : " · A2P not approved"
                    }${p.clean_checked_at ? ` · checked ${ago(p.clean_checked_at)}` : " · never checked"}\nClick to toggle A2P.`}
                    className={cn(
                      "px-2 py-1 rounded-md text-[11px] font-medium border transition-colors disabled:opacity-50",
                      s.chip
                    )}
                  >
                    {p.pool_name}
                    {state === "partial" && p.workflows ? ` · ${p.workflows}⚙` : ""}
                    {state === "dirty" ? " · ⚠" : ""}
                  </button>
                );
              })}
            </div>
            {/* Anything not green needs a reason next to it, not just a colour. */}
            {pool.available.some((p) => readinessOf(p) !== "ready") && (
              <div className="mt-2 space-y-0.5">
                {pool.available.filter((p) => readinessOf(p) !== "ready").slice(0, 8).map((p) => (
                  <p key={p.location_id} className="text-[11px] text-[#697a91]">
                    <b className={READINESS[readinessOf(p)].text}>{p.pool_name}</b> —{" "}
                    {readinessOf(p) === "unknown"
                      ? "never checked — hit Re-check to see what's in it"
                      : readinessOf(p) === "dirty"
                        ? `still has data: ${p.clean_note}`
                        : p.workflows
                          ? `${p.workflows} automations left — delete them in GHL, then Re-check`
                          : "A2P not approved yet"}
                  </p>
                ))}
                {pool.available.filter((p) => readinessOf(p) !== "ready").length > 8 && (
                  <p className="text-[11px] text-[#9aa8bc]">…and {pool.available.filter((p) => readinessOf(p) !== "ready").length - 8} more</p>
                )}
              </div>
            )}
            <p className="text-[11px] text-[#9aa8bc] mt-2">
              🟢 empty + A2P approved — safe to use · 🟠 nearly there (automations left, or A2P not approved) ·
              🔴 still has data · ⚪ not checked yet. Click a chip to toggle A2P; use Re-check to refresh what&apos;s inside.
            </p>
          </>
        )}
        {pool && pool.available.length === 0 && !poolLoading && (
          <p className="text-xs text-[#d97706] mt-2">
            ⚠ No clean accounts left — clean an offboarded sub-account (below) or pre-provision more from the Onboarding tab.
          </p>
        )}

        {pool && pool.used.length > 0 && (
          <details className="mt-3">
            <summary className="text-xs text-[#697a91] cursor-pointer select-none">
              Recently claimed for setups
            </summary>
            <div className="mt-2 space-y-1">
              {pool.used.slice(0, 12).map((p) => (
                <div key={p.location_id} className="text-xs text-[#697a91] flex flex-wrap gap-x-1.5">
                  <span className="text-[#9aa8bc] line-through">{p.pool_name}</span>
                  <span>→</span>
                  <span className="font-medium text-[#1e2b3d]">{p.used_as}</span>
                  {p.used_at && (
                    <span className="text-[#9aa8bc] ml-auto">
                      {new Date(p.used_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* Bulk cleanup */}
      <div className="rounded-xl border border-[#e2e8f0] bg-white">
        <button onClick={() => setBulkOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-[#1e2b3d]">
          <span>📋 Clean several accounts at once</span>
          <span className="text-xs text-[#697a91]">{bulkOpen ? "hide" : "show"}</span>
        </button>

        {bulkOpen && (
          <div className="px-4 pb-4 space-y-3">
            <p className="text-xs text-[#697a91]">
              One sub-account name per line. Each is looked up and shown with what&apos;s inside before anything is deleted —
              LIVE clients, pool accounts and the protected account are skipped automatically.
            </p>
            <textarea
              value={bulkText} onChange={(e) => setBulkText(e.target.value)} rows={4}
              placeholder={"Business name 1\nBusiness name 2\nBusiness name 3"}
              className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] text-sm font-mono focus:outline-none focus:border-[#15B7AE]"
            />
            <button onClick={resolveBulk} disabled={!bulkText.trim() || !!bulkBusy}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[#15B7AE] text-white hover:bg-[#0e8f88] disabled:opacity-50">
              <Search size={14} /> Look them up
            </button>

            {bulkRows && (
              <div className="rounded-lg border border-[#e2e8f0] divide-y divide-[#f1f5f9]">
                {bulkRows.map((r, i) => {
                  const left = r.counts ? blockersOf(r.counts) : null;
                  return (
                    <div key={i} className="px-3 py-2 text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-[#1e2b3d]">{r.name ?? r.typed}</span>
                      {r.owner && <span className="text-xs text-[#697a91]">— {r.owner}</span>}
                      {r.state === "resolving" && <Loader2 size={13} className="animate-spin text-[#9aa8bc]" />}
                      {r.state === "cleaning" && <span className="text-xs text-[#d97706] inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> wiping…</span>}
                      {r.state === "finalizing" && <span className="text-xs text-[#d97706] inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> finalizing…</span>}
                      {r.state === "ready" && r.counts && (
                        <span className="text-xs text-[#697a91]">
                          {r.counts.contacts} contacts · {r.counts.workflows} automations · {r.counts.pipelines} pipelines
                          {r.sheetStatus ? ` · sheet: ${r.sheetStatus}` : ""}
                        </span>
                      )}
                      {r.state === "cleaned" && (
                        left === 0
                          ? <span className="text-xs text-[#15803d]">wiped ✓ ready to pool</span>
                          : <span className="text-xs text-[#d97706]">
                              wiped — blocked from pool by: {r.counts!.pipelines > 0 ? `${r.counts!.pipelines} pipeline ` : ""}
                              {r.counts!.funnels > 0 ? `${r.counts!.funnels} funnels ` : ""}
                              {r.counts!.workflows > 0 && (
                                <a
                                  href={`https://app.gohighlevel.com/v2/location/${r.id}/automation/workflows`}
                                  target="_blank" rel="noopener noreferrer" className="underline font-semibold"
                                >
                                  {r.counts!.workflows} automations ↗
                                </a>
                              )}
                            </span>
                      )}
                      {r.state === "done" && <span className="text-xs text-[#15803d]">→ {r.poolName} ✓</span>}
                      {r.state === "skip" && <span className="text-xs text-[#9aa8bc]">skipped — {r.note}</span>}
                      {r.state === "error" && <span className="text-xs text-[#e11d48]">{r.note}</span>}
                      {r.state === "done" && r.note && <span className="w-full text-[11px] text-[#697a91]">{r.note}</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {readyCount > 0 && !bulkBusy && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs text-[#697a91]">Type <b>CLEAN</b> to wipe {readyCount} account{readyCount > 1 ? "s" : ""}:</span>
                <input value={bulkConfirm} onChange={(e) => setBulkConfirm(e.target.value)} placeholder="CLEAN"
                  className="px-3 py-1.5 w-28 rounded-lg border border-[#e2e8f0] text-sm focus:outline-none focus:border-[#e11d48]" />
                <button onClick={runBulkClean} disabled={bulkConfirm.trim().toUpperCase() !== "CLEAN"}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold bg-[#e11d48] text-white hover:bg-[#be123c] disabled:opacity-40">
                  <Trash2 size={14} /> Clean {readyCount}
                </button>
              </div>
            )}

            {finalizableCount > 0 && !bulkBusy && (
              <button onClick={runBulkFinalize}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[#15B7AE] text-white hover:bg-[#0e8f88]">
                <Sparkles size={14} /> Rename {finalizableCount} to pool + mark Offboarded
              </button>
            )}
          </div>
        )}
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
            <div className="flex items-center gap-2 p-3 rounded-lg bg-[#e6f7f5] border border-[#a7e3df] text-sm text-[#0e8f88]">
              <Sparkles size={15} />
              In the clean pool — it can still be re-cleaned. Pre-provisioned accounts
              were never wiped, so many still carry template values, fields and automations.
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
                <div className="text-lg font-bold text-[#1e2b3d]">
                  {inspect.counts[key] < 0 ? "?" : inspect.counts[key]}
                </div>
                <div className="text-[10px] text-[#697a91] leading-tight">{label}</div>
              </div>
            ))}
          </div>
          {(inspect.counts.workflows > 0 || inspect.counts.funnels !== 0) && (
            <div className="text-xs text-[#d97706] space-y-1">
              <p className="font-semibold">⚠ GHL&apos;s API can&apos;t delete these — they need the GHL UI:</p>
              {inspect.counts.workflows > 0 && (
                <p>
                  • <b>{inspect.counts.workflows} automation{inspect.counts.workflows > 1 ? "s" : ""}</b> —{" "}
                  <a
                    href={`https://app.gohighlevel.com/v2/location/${inspect.id}/automation/workflows`}
                    target="_blank" rel="noopener noreferrer"
                    className="underline font-semibold hover:text-[#b45309]"
                  >
                    open this account&apos;s Workflows ↗
                  </a>{" "}
                  — select all folders → Delete → type &quot;Delete&quot;, then select all remaining workflows → Delete
                  again. <b>Pooling stays blocked until this reaches 0</b> (GHL exposes no API for automations, and
                  their screen refuses browser automation, so this one is by hand).
                </p>
              )}
              {inspect.counts.funnels !== 0 && (
                <p>
                  • <b>
                    {inspect.counts.funnels < 0
                      ? "Funnels (count unavailable)"
                      : `${inspect.counts.funnels} funnel${inspect.counts.funnels > 1 ? "s" : ""}`}
                  </b>{" "}
                  — Sites → Funnels: ⋮ on each funnel → Delete. Ask Claude and it can do these in the browser.
                </p>
              )}
            </div>
          )}

          {/* Clean */}
          {!inspect.protected && statusLower !== "live" && !steps && (
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
              {cleanNote && (
                <p className="text-xs text-[#697a91] flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> {cleanNote}
                </p>
              )}
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
                old reviews, ask Claude to clear them in the browser. Same for automations, pipelines and funnels.
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
