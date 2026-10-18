"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Check, X, Search, ChevronDown, ChevronRight, Plus, Trash2, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUser } from "@/lib/hooks/useUser";

// Payment Check (owner 2026-10-18): each month of the Financing sheet matched
// against Square + dashboard charges. Laid out like the sheet itself — one
// line per client (owner: "it looks a bit too much", same day) — with a
// "Found" column showing what actually got charged and ✓ / ✗ to confirm.
// The Financing sheet is only read — nothing here writes to it.

type Category = "declined" | "amount" | "unrecorded" | "norecord" | "late" | "match" | "scheduled" | "later" | "upfront" | "pps_none" | "noamount" | "inactive";
type Evidence = { kind: string; text: string; amountCents?: number; at?: string; receiptUrl?: string | null };
type Field = "usd" | "sheetStatus" | "billing" | "payDay" | "notes";
type SheetFields = { usd: number | null; sheetStatus: string; billing: string; payDay: string; notes: string };
type Row = SheetFields & { ownerKey: string; name: string; paidCents: number; evidence: Evidence[]; category: Category; suggested: "paid" | "not_paid" | null; sheet?: SheetFields; edited?: Field[]; added?: boolean };
type Decision = { owner_key: string; decision: "paid" | "not_paid" };
type MonthTab = { month: string; tab: string; label: string };
type Payload = {
  months: MonthTab[]; month: string; tab: string; rows: Row[]; squareChecked: boolean; warnings: string[];
  builtAt: string; decisions: Decision[]; autoconfirm: boolean; agreement: { agreed: number; total: number };
  coaches: Record<string, string>; shares: Record<string, number>;
  removed: Row[]; options: { sheetStatus: string[]; billing: string[] };
};

const REVIEW: Category[] = ["declined", "amount", "unrecorded", "norecord", "late"];
type Filter = "all" | "check" | "paid" | "unpaid" | "off" | "removed";
const FILTERS: Array<{ key: Filter; label: string; test: (r: Row) => boolean }> = [
  { key: "all", label: "All", test: () => true },
  { key: "check", label: "Needs check", test: (r) => REVIEW.includes(r.category) },
  { key: "paid", label: "Paid", test: (r) => ["match", "amount", "unrecorded", "upfront"].includes(r.category) },
  { key: "unpaid", label: "Not paid yet", test: (r) => ["late", "declined", "norecord", "scheduled", "later", "pps_none"].includes(r.category) },
  { key: "off", label: "Not billing", test: (r) => ["inactive", "noamount"].includes(r.category) },
];

const short = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const usDay = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "America/Los_Angeles" }) : "");

/** One short "what we found" cell. The full trail sits in the tooltip. */
function found(r: Row): { text: string; cls: string } {
  const paid = r.evidence.filter((e) => ["square", "dashboard", "pps"].includes(e.kind));
  const last = paid.map((e) => e.at ?? "").sort().pop();
  if (r.category === "declined") return { text: "Card declined", cls: "text-[#e11d48]" };
  if (paid.length) {
    const t = `✓ ${short(r.paidCents / 100)}${last ? ` · ${usDay(last)}` : ""}`;
    return { text: r.category === "amount" ? `${t} (sheet ${short(r.usd ?? 0)})` : t, cls: r.category === "amount" ? "text-[#d97706]" : "text-[#15803d]" };
  }
  if (r.evidence.some((e) => e.kind === "plan")) return { text: "✓ Prepaid plan", cls: "text-[#15803d]" };
  const sched = r.evidence.find((e) => e.kind === "scheduled");
  if (sched) return { text: sched.text.replace(/^(Square renews|Dashboard charges)/, "Charges"), cls: "text-[#0e8f88]" };
  if (r.category === "norecord" || r.category === "late") return { text: "No payment found", cls: "text-[#e11d48]" };
  return { text: "—", cls: "text-[#a6b3c4]" };
}

function statusCls(s: string) {
  const u = s.toLowerCase();
  if (u.startsWith("paid")) return "bg-[#e6f7ee] text-[#15803d]";
  if (u === "pps" || u === "ppa") return "bg-[#efe9fb] text-[#6d28d9]";
  if (u.includes("paused")) return "bg-[#fde8ee] text-[#e11d48]";
  if (u.includes("grace") || u.includes("pending")) return "bg-[#fff7ec] text-[#d97706]";
  return "bg-[#f1f5f9] text-[#64748b]";
}

export default function PaymentCheckPage() {
  const { role, loading: roleLoading } = useUser();
  const router = useRouter();
  useEffect(() => { if (!roleLoading && role !== "admin") router.replace("/clients"); }, [roleLoading, role, router]);

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<"payments" | "coaches">("payments");

  const [adding, setAdding] = useState<string | null>(null);
  const load = useCallback(async (m: string | null, refresh = false, silent = false) => {
    if (refresh) setRefreshing(true); else if (!silent) setLoading(true);
    if (!silent) setError(null);
    try {
      const params = new URLSearchParams();
      if (m) params.set("month", m);
      if (refresh) params.set("refresh", "1");
      const r = await fetch(`/api/payment-check?${params}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't load this month");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { if (role === "admin") load(null); }, [role, load]);

  // Edits are saved on the dashboard only — the Financing sheet is never written.
  const post = useCallback(async (body: Record<string, unknown>, key: string) => {
    if (!data) return false;
    setBusy(key);
    try {
      const r = await fetch("/api/payment-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: data.month, ...body }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't save");
      await load(data.month, false, true);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(null); }
  }, [data, load]);
  const edit = useCallback((r: Row, field: Field, value: string | null) =>
    post({ action: "edit", ownerKey: r.ownerKey, clientName: r.name, field, value }, `e:${r.ownerKey}:${field}`), [post]);

  const decided = useMemo(() => new Map((data?.decisions ?? []).map((d) => [d.owner_key, d.decision])), [data]);

  const decide = useCallback(async (rows: Row[], decision: "paid" | "not_paid" | null, key: string) => {
    if (!data) return;
    setBusy(key);
    try {
      const r = await fetch("/api/payment-check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "decide", month: data.month, items: rows.map((x) => ({ ownerKey: x.ownerKey, clientName: x.name, decision, suggested: x.suggested })) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't save");
      const keys = new Set(rows.map((x) => x.ownerKey));
      setData((d) => d && ({ ...d, decisions: [...d.decisions.filter((x) => !keys.has(x.owner_key)), ...(decision ? rows.map((x) => ({ owner_key: x.ownerKey, decision })) : [])] }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }, [data]);

  const setAuto = useCallback(async (enabled: boolean) => {
    setBusy("auto");
    try {
      const r = await fetch("/api/payment-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "autoconfirm", enabled }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't save");
      setData((d) => d && ({ ...d, autoconfirm: enabled }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }, []);

  const counts = useMemo(() => ({
    ...Object.fromEntries(FILTERS.map((f) => [f.key, (data?.rows ?? []).filter(f.test).length])),
    removed: data?.removed?.length ?? 0,
  }) as Record<Filter, number>, [data]);
  const rows = useMemo(() => {
    const match = (r: Row) => !q || r.name.toLowerCase().includes(q.toLowerCase());
    if (filter === "removed") return (data?.removed ?? []).filter(match);
    const f = FILTERS.find((x) => x.key === filter)!;
    return (data?.rows ?? []).filter((r) => f.test(r) && match(r));
  }, [data, filter, q]);
  const openMatches = useMemo(() => (data && !data.autoconfirm ? data.rows.filter((r) => r.category === "match" && !decided.has(r.ownerKey)) : []), [data, decided]);
  const left = (data?.rows ?? []).filter((r) => (REVIEW.includes(r.category) || (!data?.autoconfirm && r.category === "match")) && !decided.has(r.ownerKey)).length;
  const collected = (data?.rows ?? []).reduce((s, r) => s + r.paidCents, 0) / 100;

  if (roleLoading || role !== "admin") return null;

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold text-[#1f3559] mr-2">Payment Check</h1>
        <span className="inline-flex rounded-lg border border-[#d7e0ea] bg-white p-0.5">
          {(["payments", "coaches"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={cn("h-7 rounded-md px-3 text-sm font-semibold", view === v ? "bg-[#1f3559] text-white" : "text-[#1f3559]")}>
              {v === "payments" ? "Payments" : "Coach share"}
            </button>
          ))}
        </span>
        <select id="pc-month" value={data?.month ?? ""} disabled={loading || refreshing || !data} onChange={(e) => load(e.target.value)}
          className="h-8 rounded-lg border border-[#d7e0ea] bg-white px-2 text-sm font-semibold text-[#1f3559]">
          {(data?.months ?? []).map((m) => <option key={m.month} value={m.month}>{m.label}</option>)}
        </select>
        <button onClick={() => load(data?.month ?? null, true)} disabled={loading || refreshing || !data} title="Re-check payments now"
          className="h-8 inline-flex items-center gap-1 rounded-lg border border-[#d7e0ea] bg-white px-2.5 text-sm font-semibold text-[#1f3559] hover:border-[#0e8f88] disabled:opacity-60">
          {refreshing || loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} {refreshing ? "Checking…" : "Refresh"}
        </button>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-2.5 text-[#a6b3c4]" />
          <input id="pc-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client"
            className="h-8 w-44 rounded-lg border border-[#d7e0ea] bg-white pl-7 pr-2 text-sm" />
        </div>
        {data && (
          <span className="ml-auto flex flex-wrap items-center gap-3 text-sm text-[#64748b]">
            <span><b className="text-[#e11d48]">{left}</b> left to check</span>
            <span><b className="text-[#1f3559]">{short(collected)}</b> collected</span>
            <label className="inline-flex items-center gap-1.5 cursor-pointer" title={data.agreement.total ? `You agreed with the suggestion ${data.agreement.agreed} of ${data.agreement.total} times` : "When on, matching payments confirm themselves"}>
              {busy === "auto" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                <input id="pc-auto" type="checkbox" checked={data.autoconfirm} onChange={(e) => setAuto(e.target.checked)} className="accent-[#0e8f88]" />}
              Auto-confirm matches
            </label>
          </span>
        )}
      </div>

      {error && <div className="rounded-lg border border-[#f5c2cf] bg-[#fde8ee] px-3 py-2 text-sm text-[#e11d48]">{error}</div>}
      {data?.warnings.map((w) => <div key={w} className="rounded-lg border border-[#fcd9a8] bg-[#fff7ec] px-3 py-1.5 text-sm text-[#b45309]">{w}</div>)}

      {data && view === "coaches" && (
        <CoachShare data={data} decided={decided} q={q}
          onShares={(shares) => setData((d) => d && ({ ...d, shares }))} onError={setError} />
      )}

      {data && view === "payments" && (
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={cn("h-7 rounded-full px-3 text-xs font-semibold border", filter === f.key ? "bg-[#1f3559] border-[#1f3559] text-white" : "bg-white border-[#d7e0ea] text-[#1f3559] hover:border-[#1f3559]")}>
              {f.label} <span className="opacity-70">{counts[f.key]}</span>
            </button>
          ))}
          {counts.removed > 0 && (
            <button onClick={() => setFilter("removed")}
              className={cn("h-7 rounded-full px-3 text-xs font-semibold border", filter === "removed" ? "bg-[#1f3559] border-[#1f3559] text-white" : "bg-white border-[#d7e0ea] text-[#64748b] hover:border-[#1f3559]")}>
              Removed <span className="opacity-70">{counts.removed}</span>
            </button>
          )}
          {adding === null ? (
            <button onClick={() => setAdding("")} className="h-7 inline-flex items-center gap-1 rounded-full border border-dashed border-[#0e8f88] px-3 text-xs font-semibold text-[#0e8f88]">
              <Plus className="w-3.5 h-3.5" /> Add client
            </button>
          ) : (
            <form className="inline-flex items-center gap-1" onSubmit={async (e) => {
              e.preventDefault();
              if (await post({ action: "add", name: adding }, "add")) setAdding(null);
            }}>
              <input id="pc-add" autoFocus value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Client full name"
                onKeyDown={(e) => { if (e.key === "Escape") setAdding(null); }}
                className="h-7 w-48 rounded-full border border-[#0e8f88] px-3 text-xs" />
              <button type="submit" disabled={busy === "add" || !adding.trim()} className="h-7 inline-flex items-center gap-1 rounded-full bg-[#0e8f88] px-3 text-xs font-semibold text-white disabled:opacity-60">
                {busy === "add" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add
              </button>
              <button type="button" onClick={() => setAdding(null)} className="text-xs text-[#64748b] px-1">Cancel</button>
            </form>
          )}
          {openMatches.length > 0 && (
            <button onClick={() => decide(openMatches, "paid", "all")} disabled={!!busy}
              className="ml-auto h-7 inline-flex items-center gap-1 rounded-full bg-[#15803d] px-3 text-xs font-semibold text-white disabled:opacity-60">
              {busy === "all" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Confirm all {openMatches.length} matches
            </button>
          )}
        </div>
      )}

      {loading && !data && <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#64748b]"><Loader2 className="w-4 h-4 animate-spin" /> Matching payments… the first load of a month can take a minute.</div>}

      {data && view === "payments" && (
        <div className="rounded-xl border border-[#d7e0ea] bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#f6f9fc] text-left text-[11px] uppercase tracking-wide text-[#64748b]">
              <tr>
                <th className="px-3 py-2 font-semibold">Client</th>
                <th className="px-3 py-2 font-semibold">Notes</th>
                <th className="px-3 py-2 font-semibold text-right">USD</th>
                <th className="px-3 py-2 font-semibold">Day</th>
                <th className="px-3 py-2 font-semibold">Payment status</th>
                <th className="px-3 py-2 font-semibold">Billing</th>
                <th className="px-3 py-2 font-semibold">Found</th>
                <th className="px-3 py-2 font-semibold text-right">OK?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#eef2f6]">
              {rows.map((r) => {
                const f = found(r);
                const d = decided.get(r.ownerKey);
                const check = REVIEW.includes(r.category) && !d;
                return (
                  <tr key={r.ownerKey} className={cn("hover:bg-[#f9fbfd]", check && "bg-[#fffaf0]")}>
                    <td className="px-3 py-1.5 font-medium text-[#1f3559] whitespace-nowrap">
                      {r.name}{r.added && <span className="ml-1.5 rounded bg-[#e6f7f5] px-1 text-[10px] font-bold text-[#0e8f88]" title="Added on the dashboard, not on the sheet">NEW</span>}
                    </td>
                    <td className="px-1.5 py-1 max-w-[320px]"><EditText r={r} field="notes" busy={busy} onSave={edit} className="text-[#64748b]" /></td>
                    <td className="px-1.5 py-1 text-right"><EditText r={r} field="usd" busy={busy} onSave={edit} className="tabular-nums text-[#1f3559] text-right" /></td>
                    <td className="px-1.5 py-1"><EditText r={r} field="payDay" busy={busy} onSave={edit} className="text-[#64748b]" /></td>
                    <td className="px-1.5 py-1"><EditSelect r={r} field="sheetStatus" options={data.options.sheetStatus} busy={busy} onSave={edit} chip /></td>
                    <td className="px-1.5 py-1"><EditSelect r={r} field="billing" options={data.options.billing} busy={busy} onSave={edit} /></td>
                    <td className={cn("px-3 py-1.5 whitespace-nowrap font-medium", f.cls)} title={r.evidence.map((e) => e.text).join("\n") || "Nothing found in Square or the dashboard"}>{f.text}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                      {filter === "removed" ? (
                        <button onClick={() => post({ action: "restore", ownerKey: r.ownerKey, clientName: r.name }, `rm:${r.ownerKey}`)} disabled={!!busy}
                          className="inline-flex items-center gap-1 rounded-md border border-[#d7e0ea] px-2 py-1 text-xs font-semibold text-[#1f3559]">
                          {busy === `rm:${r.ownerKey}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />} Restore
                        </button>
                      ) : d ? (
                        <button onClick={() => decide([r], null, `u:${r.ownerKey}`)} disabled={!!busy} title="Click to undo"
                          className={cn("rounded px-1.5 py-0.5 text-xs font-bold", d === "paid" ? "bg-[#e6f7ee] text-[#15803d]" : "bg-[#fde8ee] text-[#e11d48]")}>
                          {busy === `u:${r.ownerKey}` ? <Loader2 className="w-3 h-3 animate-spin inline" /> : d === "paid" ? "Paid ✓" : "Not paid"}
                        </button>
                      ) : data.autoconfirm && r.category === "match" ? (
                        <span className="text-xs font-semibold text-[#15803d]">Auto ✓</span>
                      ) : r.suggested ? (
                        <span className="inline-flex gap-1">
                          <button onClick={() => decide([r], "paid", `y:${r.ownerKey}`)} disabled={!!busy} title="Yes, paid"
                            className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-[#86efac] text-[#15803d] hover:bg-[#e6f7ee] disabled:opacity-50">
                            {busy === `y:${r.ownerKey}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => decide([r], "not_paid", `n:${r.ownerKey}`)} disabled={!!busy} title="Not paid"
                            className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-[#f5c2cf] text-[#e11d48] hover:bg-[#fde8ee] disabled:opacity-50">
                            {busy === `n:${r.ownerKey}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                          </button>
                        </span>
                      ) : null}
                      {filter !== "removed" && (
                        <button onClick={() => post({ action: "remove", ownerKey: r.ownerKey, clientName: r.name }, `rm:${r.ownerKey}`)} disabled={!!busy}
                          title="Remove from this month (sheet is not changed)" className="w-6 h-6 inline-flex items-center justify-center rounded text-[#cbd5e1] hover:text-[#e11d48]">
                          {busy === `rm:${r.ownerKey}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={8} className="px-3 py-6 text-center text-[#94a3b8]">No clients here.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {data && <p className="text-xs text-[#94a3b8]">Sheet tab {data.tab} · checked {new Date(data.builtAt).toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })} · hover “Found” for details · highlighted rows need a look · click any cell to edit — a teal dot means it was changed here (your sheet stays as it is)</p>}
    </div>
  );
}

/* Coach share — admin review only (owner 2026-10-18: "don't make any payment
   to anyone… only for me"). Each coach's clients come from the Clients Master
   "Assigned" column; the share counts only money the owner confirmed (or that
   auto-confirmed), after refunds and chargebacks. Nothing here pays anyone. */
function CoachShare({ data, decided, q, onShares, onError }: {
  data: Payload; decided: Map<string, "paid" | "not_paid">; q: string;
  onShares: (s: Record<string, number>) => void; onError: (e: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const groups = useMemo(() => {
    const by = new Map<string, Array<{ r: Row; confirmed: number; waiting: number }>>();
    for (const r of data.rows) {
      if (q && !r.name.toLowerCase().includes(q.toLowerCase())) continue;
      const coach = data.coaches[r.ownerKey] ?? "Unassigned";
      const d = decided.get(r.ownerKey);
      const ok = d === "paid" || (!d && data.autoconfirm && r.category === "match");
      const confirmed = ok ? Math.max(0, r.paidCents) : 0;
      const waiting = !d && !ok && r.suggested === "paid" ? Math.max(0, r.paidCents) : 0;
      by.set(coach, [...(by.get(coach) ?? []), { r, confirmed, waiting }]);
    }
    return [...by.entries()].map(([coach, items]) => ({
      coach, items,
      confirmed: items.reduce((s, i) => s + i.confirmed, 0),
      waiting: items.reduce((s, i) => s + i.waiting, 0),
      paying: items.filter((i) => i.confirmed > 0).length,
    })).sort((a, b) => (a.coach === "Unassigned" ? 1 : b.coach === "Unassigned" ? -1 : b.confirmed - a.confirmed));
  }, [data, decided, q]);

  const save = async (coach: string) => {
    const raw = (draft[coach] ?? "").trim();
    const percent = raw === "" ? null : Number(raw);
    if (percent != null && (!isFinite(percent) || percent < 0 || percent > 100)) { onError("Enter a percent between 0 and 100"); return; }
    if ((data.shares[coach] ?? null) === percent) return;
    setSaving(coach);
    try {
      const r = await fetch("/api/payment-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "share", coach, percent }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't save");
      onShares(j.shares);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setSaving(null); }
  };

  const total = groups.reduce((s, g) => s + (g.coach === "Unassigned" ? 0 : g.confirmed * (data.shares[g.coach] ?? 0) / 100), 0);

  return (
    <div className="space-y-2">
      <p className="text-sm text-[#64748b]">Review only, visible to admins. Nothing is paid to coaches. Counts payments you confirmed{data.autoconfirm ? " or that auto-confirmed" : ""}, after refunds and chargebacks.</p>
      <div className="rounded-xl border border-[#d7e0ea] bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#f6f9fc] text-left text-[11px] uppercase tracking-wide text-[#64748b]">
            <tr>
              <th className="px-3 py-2 font-semibold">Coach</th>
              <th className="px-3 py-2 font-semibold text-right">Clients</th>
              <th className="px-3 py-2 font-semibold text-right">Paying</th>
              <th className="px-3 py-2 font-semibold text-right">Confirmed</th>
              <th className="px-3 py-2 font-semibold text-right">Waiting your OK</th>
              <th className="px-3 py-2 font-semibold text-right">Share %</th>
              <th className="px-3 py-2 font-semibold text-right">Share $</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#eef2f6]">
            {groups.map((g) => {
              const pct = data.shares[g.coach];
              const isOpen = open === g.coach;
              return [
                <tr key={g.coach} className="hover:bg-[#f9fbfd] cursor-pointer" onClick={() => setOpen(isOpen ? null : g.coach)}>
                  <td className="px-3 py-2 font-semibold text-[#1f3559] whitespace-nowrap">
                    {isOpen ? <ChevronDown className="w-3.5 h-3.5 inline mr-1" /> : <ChevronRight className="w-3.5 h-3.5 inline mr-1" />}{g.coach}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{g.items.length}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{g.paying}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-[#15803d]">{short(g.confirmed / 100)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#d97706]">{g.waiting ? short(g.waiting / 100) : ""}</td>
                  <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    {g.coach === "Unassigned" ? "" : (
                      <span className="inline-flex items-center gap-1">
                        {saving === g.coach && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#0e8f88]" />}
                        <input id={`share-${g.coach}`} inputMode="decimal" placeholder="—"
                          value={draft[g.coach] ?? (pct != null ? String(pct) : "")}
                          onChange={(e) => setDraft((d) => ({ ...d, [g.coach]: e.target.value }))}
                          onBlur={() => save(g.coach)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          className="w-14 h-7 rounded-md border border-[#d7e0ea] px-1.5 text-right tabular-nums" />%
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-[#1f3559]">{g.coach !== "Unassigned" && pct != null ? short(g.confirmed * pct / 10000) : ""}</td>
                </tr>,
                isOpen && (
                  <tr key={`${g.coach}-detail`}>
                    <td colSpan={7} className="bg-[#fbfcfe] px-3 py-1">
                      <table className="w-full text-xs">
                        <tbody className="divide-y divide-[#eef2f6]">
                          {g.items.map(({ r, confirmed, waiting }) => (
                            <tr key={r.ownerKey}>
                              <td className="py-1 pl-5 text-[#1f3559] font-medium whitespace-nowrap">{r.name}</td>
                              <td className="py-1">{r.sheetStatus && <span className={cn("rounded px-1.5 py-0.5 font-semibold", statusCls(r.sheetStatus))}>{r.sheetStatus}</span>}</td>
                              <td className={cn("py-1 whitespace-nowrap", found(r).cls)} title={r.evidence.map((e) => e.text).join("\n")}>{found(r).text}</td>
                              <td className="py-1 text-right tabular-nums whitespace-nowrap">
                                {confirmed ? <span className="text-[#15803d] font-semibold">{short(confirmed / 100)}</span>
                                  : waiting ? <span className="text-[#d97706]">{short(waiting / 100)} waiting</span> : <span className="text-[#a6b3c4]">—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
          <tfoot>
            <tr className="bg-[#f6f9fc] font-semibold text-[#1f3559]">
              <td className="px-3 py-2" colSpan={6}>Total share this month (assigned coaches)</td>
              <td className="px-3 py-2 text-right tabular-nums">{short(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/* Inline editors. Changes are saved on the dashboard only; a teal dot marks a
   changed cell and its tooltip shows the sheet's own value. */
function sheetValue(r: Row, field: Field): string {
  const v = r.sheet ? r.sheet[field] : r[field];
  return field === "usd" ? (v ? short(Number(v)) : "blank") : String(v || "blank");
}

function EditedDot({ r, field, onSave }: { r: Row; field: Field; onSave: (r: Row, f: Field, v: string | null) => void }) {
  if (!r.edited?.includes(field)) return null;
  return (
    <button onClick={(e) => { e.stopPropagation(); onSave(r, field, null); }} title={`Changed here · sheet says ${sheetValue(r, field)} · click to go back to the sheet value`}
      className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-[#0e8f88] align-middle hover:ring-2 hover:ring-[#0e8f88]/30" />
  );
}

function EditText({ r, field, busy, onSave, className }: {
  r: Row; field: "notes" | "usd" | "payDay"; busy: string | null; className?: string;
  onSave: (r: Row, f: Field, v: string | null) => void;
}) {
  const shown = field === "usd" ? (r.usd ? short(r.usd) : "") : String(r[field] ?? "");
  const raw = field === "usd" ? (r.usd != null ? String(r.usd) : "") : String(r[field] ?? "");
  const [val, setVal] = useState<string | null>(null);
  const saving = busy === `e:${r.ownerKey}:${field}`;
  const commit = () => {
    if (val !== null && val.trim() !== raw.trim()) onSave(r, field, val.trim());
    setVal(null);
  };
  if (val !== null) {
    return (
      <input id={`pc-${field}-${r.ownerKey}`} autoFocus value={val} onChange={(e) => setVal(e.target.value)} onBlur={commit}
        inputMode={field === "notes" ? "text" : "decimal"}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setVal(null); }}
        className={cn("w-full min-w-[60px] h-7 rounded border border-[#0e8f88] bg-white px-1.5 text-sm outline-none", className)} />
    );
  }
  return (
    <div onClick={() => setVal(raw)} title={field === "notes" ? r.notes : "Click to edit"}
      className={cn("min-h-[28px] cursor-text rounded px-1.5 py-1 hover:bg-[#eef6f6] whitespace-nowrap", field === "notes" && "truncate", className)}>
      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin inline text-[#0e8f88]" /> : shown || <span className="text-[#cbd5e1]">—</span>}
      <EditedDot r={r} field={field} onSave={onSave} />
    </div>
  );
}

function EditSelect({ r, field, options, busy, onSave, chip }: {
  r: Row; field: "sheetStatus" | "billing"; options: string[]; busy: string | null; chip?: boolean;
  onSave: (r: Row, f: Field, v: string | null) => void;
}) {
  const value = r[field];
  const saving = busy === `e:${r.ownerKey}:${field}`;
  const list = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <span className="inline-flex items-center whitespace-nowrap">
      <select id={`pc-${field}-${r.ownerKey}`} value={value} disabled={saving}
        onChange={(e) => onSave(r, field, e.target.value === "__sheet" ? null : e.target.value)}
        className={cn("h-7 max-w-[170px] cursor-pointer rounded border border-transparent bg-transparent px-1 text-xs hover:border-[#d7e0ea] focus:border-[#0e8f88] outline-none",
          chip && value ? cn("font-semibold", statusCls(value)) : "text-[#64748b]")}>
        <option value="">—</option>
        {list.map((o) => <option key={o} value={o}>{o}</option>)}
        {r.edited?.includes(field) && <option value="__sheet">↺ Sheet value ({sheetValue(r, field)})</option>}
      </select>
      {saving && <Loader2 className="ml-1 w-3.5 h-3.5 animate-spin text-[#0e8f88]" />}
      <EditedDot r={r} field={field} onSave={onSave} />
    </span>
  );
}
