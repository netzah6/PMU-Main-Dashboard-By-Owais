"use client";
import { useState, useMemo, useEffect, useCallback } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { useUser } from "@/lib/hooks/useUser";
import { sortNewestFirst, cn } from "@/lib/utils";
import { Search, Copy, X, Loader2, Check, Ban, RefreshCw, RotateCcw } from "lucide-react";

type Row = Record<string, unknown>;
interface Refund {
  id: string; deposit_key: string; business: string | null; contact_name: string | null; email: string | null;
  amount: string | null; product_id: string | null; deposit_date: string | null; reason: string | null;
  status: string; requested_by: string | null; requested_at: string; decided_by: string | null;
  fanbasis_transaction_id: string | null; error: string | null;
}

// Deposit date lives in `Date`/`f` — mixed ISO timestamps and DD/MM/YYYY.
function parseDepositDate(f: string): Date | null {
  if (!f) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(f)) { const d = new Date(f); return isNaN(d.getTime()) ? null : d; }
  const m = f.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) { const day = +m[1], mon = +m[2], yr = +m[3]; if (mon >= 1 && mon <= 12) return new Date(yr, mon - 1, day); }
  return null;
}
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (key: string) => { const [y, m] = key.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }); };
const dateStr = (r: Row) => String(r["Date"] ?? r["f"] ?? r["date"] ?? "");
const depDate = (r: Row) => parseDepositDate(dateStr(r));
const contactKey = (r: Row) => String(r["Email"] ?? "").trim().toLowerCase() || String(r["Full Name"] ?? "").trim().toLowerCase();
const fmtDate = (f: string) => { const d = parseDepositDate(f); return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : f; };

// Identity shared with the server (product|email|amount|date) — used to line a
// deposit row up with its refund record without hashing on the client.
const rkey = (product: unknown, email: unknown, amount: unknown, date: unknown) =>
  [product, email, amount, date].map((s) => String(s ?? "").trim().toLowerCase()).join("|");

const STATUS: Record<string, { label: string; cls: string }> = {
  pending:  { label: "Pending approval", cls: "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]" },
  refunded: { label: "Refunded",         cls: "bg-[#e6f7ee] text-[#15803d] border-[#86efac]" },
  denied:   { label: "Denied",           cls: "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]" },
  failed:   { label: "Failed",           cls: "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]" },
};

export default function DepositsPage() {
  const { data, loading, error } = useTableData<Row>({ table: "deposits" });
  const { role } = useUser();
  const canRequest = role === "admin" || role === "editor";
  const [search, setSearch] = useState("");
  const [month, setMonth] = useState("All");
  const [dupOpen, setDupOpen] = useState(false);

  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [requestFor, setRequestFor] = useState<Row | null>(null);
  const [reason, setReason] = useState("");
  const [banner, setBanner] = useState<string | null>(null);

  const loadRefunds = useCallback(async () => {
    try { const r = await fetch("/api/refunds"); if (r.ok) setRefunds(((await r.json()).refunds ?? []) as Refund[]); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadRefunds(); }, [loadRefunds]);

  const refundByKey = useMemo(() => {
    const m = new Map<string, Refund>();
    for (const rf of refunds) m.set(rkey(rf.product_id, rf.email, rf.amount, rf.deposit_date), rf);
    return m;
  }, [refunds]);
  const queue = useMemo(() => refunds.filter((r) => r.status === "pending" || r.status === "failed"), [refunds]);

  const months = useMemo(() => {
    const set = new Set<string>();
    data.forEach((r) => { const d = depDate(r); if (d) set.add(monthKey(d)); });
    return Array.from(set).sort().reverse();
  }, [data]);

  const filtered = useMemo(() => sortNewestFirst(data.filter((r) => {
    const hay = `${r["Business Name"] ?? r.client_name ?? ""} ${r["Full Name"] ?? ""} ${r["Email"] ?? ""}`.toLowerCase();
    if (search && !hay.includes(search.toLowerCase())) return false;
    if (month !== "All") { const d = depDate(r); if (!d || monthKey(d) !== month) return false; }
    return true;
  })), [data, search, month]);

  const dups = useMemo(() => {
    const map = new Map<string, { business: string; name: string; email: string; dates: string[] }>();
    data.forEach((r) => {
      const c = contactKey(r); if (!c) return;
      const biz = String(r["Business Name"] ?? "").trim(); if (!biz) return;
      const key = biz.toLowerCase() + "|" + c;
      const e = map.get(key) ?? { business: biz, name: String(r["Full Name"] ?? ""), email: String(r["Email"] ?? ""), dates: [] };
      e.dates.push(dateStr(r));
      map.set(key, e);
    });
    return Array.from(map.values()).filter((d) => d.dates.length > 1).sort((a, b) => b.dates.length - a.dates.length);
  }, [data]);

  async function submitRequest() {
    if (!requestFor) return;
    const r = requestFor;
    setBusy((b) => new Set(b).add("request"));
    try {
      const res = await fetch("/api/refunds/request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business: String(r["Business Name"] ?? ""), contact_name: String(r["Full Name"] ?? ""),
          email: String(r["Email"] ?? ""), amount: String(r["Amount"] ?? ""),
          product_id: String(r["Product ID"] ?? ""), deposit_date: dateStr(r), reason,
        }),
      });
      const j = await res.json();
      if (!res.ok) { setBanner(j.error || "Request failed"); return; }
      setRequestFor(null); setReason(""); setBanner(null); await loadRefunds();
    } finally { setBusy((b) => { const n = new Set(b); n.delete("request"); return n; }); }
  }

  async function decide(id: string, decision: "approve" | "deny") {
    setBusy((b) => new Set(b).add(id));
    try {
      const res = await fetch("/api/refunds/decide", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      const j = await res.json();
      if (!res.ok || j.error) setBanner(j.error || "Action failed");
      else setBanner(null);
      await loadRefunds();
    } finally { setBusy((b) => { const n = new Set(b); n.delete(id); return n; }); }
  }

  const money = (a: unknown) => { const s = String(a ?? ""); return s ? (s.startsWith("$") ? s : "$" + s) : "—"; };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-lg font-semibold text-[#1f3559]">Deposits</h1>
        <div className="flex items-center gap-2">
          <button onClick={loadRefunds} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]"><RefreshCw size={12} /> Refunds</button>
          {role === "admin" && (
            <div className="bg-white rounded-lg px-4 py-2 border border-[#e4ebf2] text-right">
              <p className="text-xs text-[#697a91]">Total deposits{month !== "All" ? ` · ${monthLabel(month)}` : ""}</p>
              <p className="text-[#0e8f88] font-bold text-lg">{filtered.length.toLocaleString()}</p>
            </div>
          )}
        </div>
      </div>

      {banner && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#fde8ee] border border-[#f5c2cf] text-[#e11d48] text-sm">
          <span>{banner}</span>
          <button onClick={() => setBanner(null)}><X size={14} /></button>
        </div>
      )}

      {/* Admin approval queue */}
      {role === "admin" && queue.length > 0 && (
        <div className="rounded-xl border border-[#fcd9a8] bg-[#fffdf7] p-3">
          <h2 className="text-sm font-bold text-[#1f3559] mb-2">Refund requests to review ({queue.length})</h2>
          <div className="space-y-1.5">
            {queue.map((rf) => (
              <div key={rf.id} className="flex items-center gap-3 flex-wrap rounded-lg border border-[#f0e4cf] bg-white px-3 py-2">
                <div className="min-w-[180px] flex-1">
                  <div className="text-sm font-semibold text-[#1f3559]">{rf.contact_name || rf.email || "—"} · <span className="text-[#0e8f88]">{money(rf.amount)}</span></div>
                  <div className="text-[11px] text-[#8595a8]">{rf.business || "—"}{rf.email ? ` · ${rf.email}` : ""}</div>
                  <div className="text-[11px] text-[#697a91]">requested by {rf.requested_by || "—"}{rf.reason ? ` · “${rf.reason}”` : ""}</div>
                  {rf.status === "failed" && rf.error && <div className="text-[11px] text-[#e11d48] mt-0.5">Last attempt failed: {rf.error}</div>}
                </div>
                <button disabled={busy.has(rf.id)} onClick={() => decide(rf.id, "approve")}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#e6f7ee] hover:bg-[#d5f0e0] text-[#15803d] border border-[#86efac]">
                  {busy.has(rf.id) ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  {rf.status === "failed" ? "Retry refund" : "Approve & refund"}
                </button>
                <button disabled={busy.has(rf.id)} onClick={() => decide(rf.id, "deny")}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-white hover:bg-[#fde8ee] text-[#e11d48] border border-[#f5c2cf]">
                  <Ban size={12} /> Deny
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input type="text" placeholder="Search client, name, or email…" value={search} onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <select value={month} onChange={(e) => setMonth(e.target.value)}
          className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
          <option value="All">All months</option>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>

        <div className="relative">
          <button onClick={() => setDupOpen((o) => !o)}
            className={cn("flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition-colors",
              dups.length ? "bg-[#fff4ed] border-[#fbcfae] text-[#c2410c] hover:bg-[#ffe9da]" : "bg-white border-[#e4ebf2] text-[#697a91] hover:border-[#cbd5e1]")}>
            <Copy size={14} /> Duplicates
            {dups.length > 0 && <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-[#ea580c] text-white">{dups.length}</span>}
          </button>
          {dupOpen && (
            <div className="absolute left-0 mt-1.5 z-40 w-[calc(100vw-3rem)] sm:w-[440px] max-h-[440px] overflow-auto rounded-xl border border-[#e4ebf2] bg-white p-3 space-y-2" style={{ boxShadow: "0 10px 30px -8px rgba(0,0,0,0.25)" }}>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[#1f3559]">Duplicate deposits ({dups.length})</h3>
                <button onClick={() => setDupOpen(false)} className="text-[#94a3b8] hover:text-[#1e2a3a]"><X size={15} /></button>
              </div>
              {dups.length === 0 ? <p className="text-xs text-[#8595a8] py-3 text-center">No duplicate deposits 🎉</p> : (
                <ul className="space-y-1.5">
                  {dups.map((d, i) => (
                    <li key={i} className="rounded-lg border border-[#eef3f8] bg-[#fafcfe] px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-[#1f3559] truncate">{d.name || d.email || "—"}</span>
                        <span className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-[#fde8d6] text-[#c2410c]">{d.dates.length}×</span>
                      </div>
                      <div className="text-[11px] text-[#697a91] truncate">{d.business}{d.email ? ` · ${d.email}` : ""}</div>
                      <div className="text-[10px] text-[#8595a8] mt-0.5">{d.dates.map(fmtDate).join(" · ")}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Deposits table with a Refund column */}
      <div className="rounded-xl border border-[#e4ebf2] bg-white overflow-auto">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-[#697a91] py-12 justify-center"><Loader2 size={15} className="animate-spin" /> Loading deposits…</div>
        ) : error ? (
          <div className="py-10 text-center text-[#e11d48] text-sm">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-[#8595a8]">No deposits match.</div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[#e4ebf2] bg-[#f8fafc]">
                {["Business", "Contact", "Amount", "Date", "Source", "Refund"].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-[#697a91] whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const key = rkey(r["Product ID"], r["Email"], r["Amount"], dateStr(r));
                const rf = refundByKey.get(key);
                return (
                  <tr key={i} className={cn("border-b border-[#eef3f8]", i % 2 ? "bg-[#fafcfe]" : "bg-white")}>
                    <td className="px-3 py-2 text-[#1f3559]">{String(r["Business Name"] ?? r.client_name ?? "—")}</td>
                    <td className="px-3 py-2">
                      <div className="text-[#1f3559]">{String(r["Full Name"] ?? "—")}</div>
                      {r["Email"] ? <div className="text-[11px] text-[#8595a8]">{String(r["Email"])}</div> : null}
                    </td>
                    <td className="px-3 py-2 font-semibold text-[#0e8f88] whitespace-nowrap">{money(r["Amount"])}</td>
                    <td className="px-3 py-2 text-[#697a91] whitespace-nowrap">{fmtDate(dateStr(r))}</td>
                    <td className="px-3 py-2 text-[#697a91]">{String(r["Source"] ?? "—")}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {rf ? (
                        <div className="flex items-center gap-1.5">
                          <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold border", (STATUS[rf.status] ?? STATUS.denied).cls)}>{(STATUS[rf.status] ?? STATUS.denied).label}</span>
                          {(rf.status === "denied") && canRequest && (
                            <button onClick={() => setRequestFor(r)} className="text-[#8595a8] hover:text-[#0e8f88]" title="Request again"><RotateCcw size={12} /></button>
                          )}
                        </div>
                      ) : canRequest ? (
                        <button onClick={() => setRequestFor(r)}
                          className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-white text-[#e11d48] border border-[#f5c2cf] hover:bg-[#fde8ee]">Refund</button>
                      ) : <span className="text-[#a6b3c4]">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Request confirmation modal */}
      {requestFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setRequestFor(null)}>
          <div className="bg-white rounded-xl border border-[#e4ebf2] w-full max-w-md p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-[#1f3559]">Request deposit refund</h3>
            <div className="rounded-lg bg-[#f8fafc] border border-[#eef3f8] px-3 py-2 text-sm">
              <div className="font-semibold text-[#1f3559]">{String(requestFor["Full Name"] ?? "—")} · <span className="text-[#0e8f88]">{money(requestFor["Amount"])}</span></div>
              <div className="text-[12px] text-[#697a91]">{String(requestFor["Business Name"] ?? "—")}{requestFor["Email"] ? ` · ${String(requestFor["Email"])}` : ""}</div>
            </div>
            <p className="text-xs text-[#697a91]">This sends an approval request. {role === "admin" ? "As an admin you can approve it in the queue above." : "Nicolas will review and approve it."} The refund runs on Fanbasis only after approval.</p>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)"
              className="w-full px-3 py-2 text-sm rounded-lg border border-[#e4ebf2] focus:outline-none focus:border-[#15B7AE]" />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setRequestFor(null); setReason(""); }} className="px-3 py-1.5 text-sm rounded-lg text-[#697a91] hover:bg-[#f1f5f9]">Cancel</button>
              <button onClick={submitRequest} disabled={busy.has("request")}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold rounded-lg bg-[#e11d48] hover:bg-[#c81a40] text-white">
                {busy.has("request") ? <Loader2 size={13} className="animate-spin" /> : null} Send refund request
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
