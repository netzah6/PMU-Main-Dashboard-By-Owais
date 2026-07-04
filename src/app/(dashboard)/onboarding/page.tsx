"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, ChevronLeft, ChevronRight, Trash2, ExternalLink, Check } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ONBOARDING_STEPS, SECTION_ORDER, FORM_FIELDS, type OnboardingStep } from "@/lib/onboarding-steps";

interface Onboarding {
  id: string;
  created_at: string;
  created_by: string | null;
  status: string;
  form: Record<string, string>;
  checklist: Record<string, { done: boolean; by: string; at: string }>;
}

function stepsFor(o: Onboarding): OnboardingStep[] {
  const isV3 = String(o.form.version ?? "").toLowerCase().includes("v3") && !String(o.form.version ?? "").toLowerCase().includes("v2.3");
  return ONBOARDING_STEPS.filter((s) => !s.v3Only || isV3);
}
function progress(o: Onboarding): { done: number; total: number } {
  const steps = stepsFor(o).filter((s) => s.section !== "Later");
  return { done: steps.filter((s) => o.checklist[s.key]?.done).length, total: steps.length };
}

export default function OnboardingPage() {
  const [list, setList] = useState<Onboarding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/onboarding");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setList(json.onboardings ?? []);
    } catch (e) {
      setError(`${e}`.replace("Error: ", ""));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = useCallback(async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ form }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Create failed");
      setList((l) => [json.onboarding, ...l]);
      setShowForm(false);
      setForm({});
      setOpenId(json.onboarding.id);
      toast.success(`Onboarding started for ${json.onboarding.form.business_name}`);
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally {
      setCreating(false);
    }
  }, [form]);

  const toggleStep = useCallback(async (o: Onboarding, stepKey: string, done: boolean) => {
    // optimistic
    setList((l) => l.map((x) => x.id === o.id
      ? { ...x, checklist: done
          ? { ...x.checklist, [stepKey]: { done: true, by: "you", at: new Date().toISOString() } }
          : Object.fromEntries(Object.entries(x.checklist).filter(([k]) => k !== stepKey)) }
      : x));
    try {
      const res = await fetch(`/api/onboarding/${o.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepKey, done }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setList((l) => l.map((x) => (x.id === o.id ? json.onboarding : x)));
    } catch (e) {
      toast.error(`Couldn't save: ${e}`);
      load();
    }
  }, [load]);

  const setStatus = useCallback(async (o: Onboarding, status: string) => {
    setList((l) => l.map((x) => (x.id === o.id ? { ...x, status } : x)));
    try {
      const res = await fetch(`/api/onboarding/${o.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Save failed");
      toast.success(status === "done" ? "Onboarding marked complete 🎉" : "Status updated");
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
      load();
    }
  }, [load]);

  const remove = useCallback(async (o: Onboarding) => {
    if (!window.confirm(`Delete the onboarding for ${o.form.business_name}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/onboarding/${o.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error || "Delete failed");
      setList((l) => l.filter((x) => x.id !== o.id));
      setOpenId(null);
      toast.success("Deleted");
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    }
  }, []);

  const open = useMemo(() => list.find((o) => o.id === openId) ?? null, [list, openId]);

  // ── Detail view ──────────────────────────────────────────────────────────
  if (open) {
    const steps = stepsFor(open);
    const pr = progress(open);
    const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
    return (
      <div className="p-4 sm:p-6 space-y-4 max-w-4xl">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <button onClick={() => setOpenId(null)} className="flex items-center gap-1 text-xs text-[#0e8f88] hover:underline mb-1">
              <ChevronLeft size={13} /> All onboardings
            </button>
            <h1 className="text-xl font-bold text-[#1f3559] truncate">{open.form.business_name}</h1>
            <p className="text-sm text-[#697a91]">{open.form.owner_name} · {open.form.version || "—"} · started {new Date(open.created_at).toLocaleDateString()}{open.created_by ? ` by ${open.created_by.split("@")[0]}` : ""}</p>
          </div>
          <div className="flex items-center gap-2">
            {open.status !== "done" && pct === 100 && (
              <button onClick={() => setStatus(open, "done")}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white">
                <Check size={13} /> Mark Complete
              </button>
            )}
            {open.status === "done" && <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-[#e6f7ee] text-[#15803d] border border-[#86efac]">✓ Complete</span>}
            <button onClick={() => remove(open)} title="Delete onboarding"
              className="p-2 rounded-lg text-[#94a3b8] hover:text-[#e11d48] hover:bg-[#fde8ee]"><Trash2 size={15} /></button>
          </div>
        </div>

        {/* Progress */}
        <div className="rounded-xl border border-[#e4ebf2] bg-white p-3">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="font-semibold text-[#34568a]">{pr.done} of {pr.total} steps done</span>
            <span className="font-bold text-[#0e8f88]">{pct}%</span>
          </div>
          <div className="h-2.5 rounded-full bg-[#f1f5f9] overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: pct === 100 ? "#15803d" : "#15B7AE" }} />
          </div>
        </div>

        {/* Client details */}
        <details className="rounded-xl border border-[#e4ebf2] bg-white">
          <summary className="px-4 py-2.5 text-sm font-semibold text-[#34568a] cursor-pointer">Client details (from the form)</summary>
          <div className="px-4 pb-3 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2">
            {FORM_FIELDS.filter((f) => (open.form[f.key] ?? "").trim()).map((f) => (
              <div key={f.key} className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-[#8595a8]">{f.label}</p>
                <p className="text-sm text-[#1f3559] break-words">{open.form[f.key]}</p>
              </div>
            ))}
          </div>
        </details>

        {/* Checklist by section */}
        {SECTION_ORDER.map((section) => {
          const secSteps = steps.filter((s) => s.section === section);
          if (!secSteps.length) return null;
          const secDone = secSteps.filter((s) => open.checklist[s.key]?.done).length;
          return (
            <div key={section} className="rounded-xl border border-[#e4ebf2] bg-white overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 bg-[#f8fafc] border-b border-[#eef3f8]">
                <h2 className="text-sm font-bold text-[#1f3559]">{section}</h2>
                <span className={cn("text-xs font-semibold", secDone === secSteps.length ? "text-[#15803d]" : "text-[#8595a8]")}>{secDone}/{secSteps.length}</span>
              </div>
              <ul className="divide-y divide-[#f1f5f9]">
                {secSteps.map((s) => {
                  const state = open.checklist[s.key];
                  return (
                    <li key={s.key} className="flex items-start gap-2.5 px-4 py-2">
                      <button onClick={() => toggleStep(open, s.key, !state?.done)}
                        className={cn("mt-0.5 shrink-0 w-5 h-5 rounded-md border flex items-center justify-center transition-colors",
                          state?.done ? "bg-[#15B7AE] border-[#15B7AE] text-white" : "border-[#cbd5e1] hover:border-[#15B7AE] text-transparent")}>
                        <Check size={12} />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className={cn("text-sm", state?.done ? "text-[#8595a8] line-through" : "text-[#1f3559]")}>
                          {s.label}
                          {s.auto && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-[#eef2ff] text-[#4f46e5]" title="Will be automated once the agency API token is connected">auto soon</span>}
                        </p>
                        {state?.done && <p className="text-[10px] text-[#a6b3c4]">✓ {state.by.split("@")[0]} · {new Date(state.at).toLocaleDateString()}</p>}
                      </div>
                      {s.loom && (
                        <a href={s.loom} target="_blank" rel="noopener noreferrer" title="Watch the how-to video"
                          className="shrink-0 flex items-center gap-1 text-[11px] font-semibold text-[#0e8f88] hover:underline">
                          <ExternalLink size={11} /> Loom
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    );
  }

  // ── List + create form ──────────────────────────────────────────────────
  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-4xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1f3559]">Client Onboarding</h1>
          <p className="text-sm text-[#697a91]">New-client setup checklist · replaces the onboarding spreadsheet</p>
        </div>
        <button onClick={() => setShowForm((s) => !s)}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white">
          <Plus size={14} /> New Client
        </button>
      </div>

      {showForm && (
        <div className="rounded-xl border border-[#a7e3df] bg-[#f7fdfc] p-4 space-y-3">
          <h2 className="text-sm font-bold text-[#1f3559]">New client details</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {FORM_FIELDS.map((f) => (
              <div key={f.key} className={cn(f.long && "sm:col-span-2")}>
                <label className="block text-[11px] font-medium text-[#697a91] mb-0.5">{f.label}{f.required && <span className="text-[#e11d48]"> *</span>}</label>
                {f.key === "version" ? (
                  <select value={form.version ?? ""} onChange={(e) => setForm((v) => ({ ...v, version: e.target.value }))}
                    className="w-full px-3 py-2 bg-white border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]">
                    <option value="">Select…</option>
                    <option value="(V3)">(V3)</option>
                    <option value="(V2.3)">(V2.3)</option>
                  </select>
                ) : f.long ? (
                  <textarea rows={2} value={form[f.key] ?? ""} onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
                    className="w-full px-3 py-2 bg-white border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE] resize-y" />
                ) : (
                  <input type="text" value={form[f.key] ?? ""} onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
                    className="w-full px-3 py-2 bg-white border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={create} disabled={creating || !String(form.business_name ?? "").trim() || !String(form.owner_name ?? "").trim() || !String(form.version ?? "").trim()}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white disabled:opacity-50">
              {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Start Onboarding
            </button>
            <button onClick={() => setShowForm(false)} className="px-3 py-2 text-xs font-semibold rounded-lg text-[#697a91] hover:bg-[#f1f5f9]">Cancel</button>
          </div>
        </div>
      )}

      {error ? (
        <div className="px-4 py-3 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-sm"><strong>Error:</strong> {error}</div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-12 justify-center"><Loader2 size={15} className="animate-spin" /> Loading…</div>
      ) : list.length === 0 ? (
        <div className="py-12 text-center text-[#8595a8]">No onboardings yet — click <strong>New Client</strong> to start one.</div>
      ) : (
        <div className="space-y-2">
          {list.map((o) => {
            const pr = progress(o);
            const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
            return (
              <button key={o.id} onClick={() => setOpenId(o.id)}
                className="w-full text-left rounded-xl border border-[#e4ebf2] bg-white p-3.5 hover:border-[#15B7AE] transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-[#1f3559] truncate">{o.form.business_name}</span>
                      <span className="text-xs text-[#697a91]">{o.form.owner_name}</span>
                      {o.form.version && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#eef2ff] text-[#4f46e5]">{o.form.version}</span>}
                      {o.status === "done" && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#e6f7ee] text-[#15803d]">✓ COMPLETE</span>}
                    </div>
                    <p className="text-[11px] text-[#8595a8] mt-0.5">Started {new Date(o.created_at).toLocaleDateString()}{o.created_by ? ` by ${o.created_by.split("@")[0]}` : ""}</p>
                  </div>
                  <div className="shrink-0 flex items-center gap-3">
                    <div className="w-28 hidden sm:block">
                      <div className="h-2 rounded-full bg-[#f1f5f9] overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct === 100 ? "#15803d" : "#15B7AE" }} />
                      </div>
                    </div>
                    <span className={cn("text-sm font-bold", pct === 100 ? "text-[#15803d]" : "text-[#0e8f88]")}>{pct}%</span>
                    <ChevronRight size={16} className="text-[#94a3b8]" />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
