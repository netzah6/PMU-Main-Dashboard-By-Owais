"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Check, X, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUser } from "@/lib/hooks/useUser";

// Payment Check (owner 2026-10-18): each month of the Financing sheet matched
// against Square + dashboard charges. Laid out like the sheet itself — one
// line per client (owner: "it looks a bit too much", same day) — with a
// "Found" column showing what actually got charged and ✓ / ✗ to confirm.
// The Financing sheet is only read — nothing here writes to it.

type Category = "declined" | "amount" | "unrecorded" | "norecord" | "late" | "match" | "scheduled" | "later" | "upfront" | "pps_none" | "noamount" | "inactive";
type Evidence = { kind: string; text: string; amountCents?: number; at?: string; receiptUrl?: string | null };
type Row = { ownerKey: string; name: string; usd: number | null; sheetStatus: string; billing: string; payDay: string; notes: string; paidCents: number; evidence: Evidence[]; category: Category; suggested: "paid" | "not_paid" | null };
type Decision = { owner_key: string; decision: "paid" | "not_paid" };
type MonthTab = { month: string; tab: string; label: string };
type Payload = {
  months: MonthTab[]; month: string; tab: string; rows: Row[]; squareChecked: boolean; warnings: string[];
  builtAt: string; decisions: Decision[]; autoconfirm: boolean; agreement: { agreed: number; total: number };
};

const REVIEW: Category[] = ["declined", "amount", "unrecorded", "norecord", "late"];
type Filter = "all" | "check" | "paid" | "unpaid" | "off";
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

  const load = useCallback(async (m: string | null, refresh = false) => {
    if (refresh) setRefreshing(true); else setLoading(true);
    setError(null);
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

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, (data?.rows ?? []).filter(f.test).length])) as Record<Filter, number>, [data]);
  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    return (data?.rows ?? []).filter((r) => f.test(r) && (!q || r.name.toLowerCase().includes(q.toLowerCase())));
  }, [data, filter, q]);
  const openMatches = useMemo(() => (data && !data.autoconfirm ? data.rows.filter((r) => r.category === "match" && !decided.has(r.ownerKey)) : []), [data, decided]);
  const left = (data?.rows ?? []).filter((r) => (REVIEW.includes(r.category) || (!data?.autoconfirm && r.category === "match")) && !decided.has(r.ownerKey)).length;
  const collected = (data?.rows ?? []).reduce((s, r) => s + r.paidCents, 0) / 100;

  if (roleLoading || role !== "admin") return null;

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold text-[#1f3559] mr-2">Payment Check</h1>
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

      {data && (
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={cn("h-7 rounded-full px-3 text-xs font-semibold border", filter === f.key ? "bg-[#1f3559] border-[#1f3559] text-white" : "bg-white border-[#d7e0ea] text-[#1f3559] hover:border-[#1f3559]")}>
              {f.label} <span className="opacity-70">{counts[f.key]}</span>
            </button>
          ))}
          {openMatches.length > 0 && (
            <button onClick={() => decide(openMatches, "paid", "all")} disabled={!!busy}
              className="ml-auto h-7 inline-flex items-center gap-1 rounded-full bg-[#15803d] px-3 text-xs font-semibold text-white disabled:opacity-60">
              {busy === "all" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Confirm all {openMatches.length} matches
            </button>
          )}
        </div>
      )}

      {loading && !data && <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#64748b]"><Loader2 className="w-4 h-4 animate-spin" /> Matching payments… the first load of a month can take a minute.</div>}

      {data && (
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
                    <td className="px-3 py-1.5 font-medium text-[#1f3559] whitespace-nowrap">{r.name}</td>
                    <td className="px-3 py-1.5 text-[#64748b] max-w-[320px] truncate" title={r.notes}>{r.notes}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[#1f3559]">{r.usd ? short(r.usd) : ""}</td>
                    <td className="px-3 py-1.5 text-[#64748b] whitespace-nowrap">{r.payDay}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.sheetStatus && <span className={cn("rounded px-1.5 py-0.5 text-xs font-semibold", statusCls(r.sheetStatus))}>{r.sheetStatus}</span>}</td>
                    <td className="px-3 py-1.5 text-[#64748b] whitespace-nowrap">{r.billing}</td>
                    <td className={cn("px-3 py-1.5 whitespace-nowrap font-medium", f.cls)} title={r.evidence.map((e) => e.text).join("\n") || "Nothing found in Square or the dashboard"}>{f.text}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      {d ? (
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
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={8} className="px-3 py-6 text-center text-[#94a3b8]">No clients here.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {data && <p className="text-xs text-[#94a3b8]">Sheet tab {data.tab} · checked {new Date(data.builtAt).toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })} · hover “Found” for details · highlighted rows need a look</p>}
    </div>
  );
}
