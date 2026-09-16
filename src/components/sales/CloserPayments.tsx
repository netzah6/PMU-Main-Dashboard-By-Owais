"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Deal, Installment } from "@/lib/closer-payments";

/* Payment plans of the closer's won deals, month by month from the Financing
   sheet, with a commission request / paid flow per installment. */

const ym = (s: string) => new Date(`${s}-15`).toLocaleString(undefined, { month: "short", year: "2-digit" });
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

export function CloserPayments({ who }: { who: string }) {
  const [data, setData] = useState<{ deals: Deal[]; isAdmin: boolean; me: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try { const r = await fetch("/api/sales/payments"); const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); setData(j); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (d: Deal, i: Installment, action: "request" | "paid" | "unpaid") => {
    const id = `${d.key}|${i.ym}`; setBusy(id);
    try {
      const r = await fetch("/api/sales/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientName: d.name, closer: d.closer, ym: i.ym, amount: i.usd, action }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); } finally { setBusy(null); }
  };

  const markAllPaid = async () => {
    if (!data) return;
    const items = data.deals.filter((d) => who === "ALL" || d.closer.toLowerCase() === who.toLowerCase())
      .flatMap((d) => d.installments.filter((i) => !i.commission?.paidAt).map((i) => ({ clientName: d.name, closer: d.closer, ym: i.ym, amount: i.usd })));
    if (!items.length || !window.confirm(`Mark ${items.length} payment${items.length > 1 ? "s" : ""} as commission paid? Use this once to clear everything already settled.`)) return;
    setBusy("bulk");
    try {
      const r = await fetch("/api/sales/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "paid_bulk", items }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); } finally { setBusy(null); }
  };

  if (err) return <div className="rounded-lg border border-[#f5c2cf] bg-[#fde8ee] px-3 py-2 text-sm text-[#be123c]">{err}</div>;
  if (!data) return <div className="flex items-center gap-2 text-sm text-[#697a91]"><Loader2 size={14} className="animate-spin" /> Reading the financing sheet…</div>;

  const deals = data.deals.filter((d) => who === "ALL" || d.closer.toLowerCase() === who.toLowerCase());
  const pending = deals.flatMap((d) => d.installments.filter((i) => !i.commission?.paidAt).map((i) => ({ d, i })));
  const toRequest = pending.filter((x) => !x.i.commission?.requestedAt).length;
  const requested = pending.filter((x) => x.i.commission?.requestedAt).length;
  const unsigned = deals.filter((d) => !d.agreement.signed).length;

  return (
    <div className="rounded-xl border border-[#e4ebf2] bg-white">
      <button onClick={() => setOpen((o) => !o)} className="w-full px-3 py-2 flex items-center gap-2 flex-wrap text-left">
        <span className="text-sm font-bold text-[#1f3559]">💵 Payment plans &amp; commissions</span>
        <span className="text-[11px] text-[#697a91]">{deals.length} closed deals · last 8 months</span>
        {toRequest > 0 && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#fde8ee] text-[#be123c] border border-[#f5c2cf]">{toRequest} payment{toRequest > 1 ? "s" : ""} went through — commission not requested</span>}
        {unsigned > 0 && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#fff7ec] text-[#9a5b00] border border-[#fcd9a8]">{unsigned} without a signed agreement</span>}
        {requested > 0 && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]">{requested} requested, waiting to be paid</span>}
        <span className="ml-auto text-[#8595a8] text-xs">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="border-t border-[#eef3f8]">
          <div className="px-3 py-1.5 flex items-center gap-2 text-[11px] text-[#8595a8]">
            One line per closed client. Each chip is a month the client actually paid (from the Financing sheet). {data.isAdmin ? "Mark a commission paid once you've sent it." : "When a new payment shows up, click Ask for commission — Nicolas sees it and marks it paid. A request needs a signed agreement in the client's name."}
            <span className="ml-auto inline-flex items-center gap-3">
              {data.isAdmin && pending.length > 0 && (
                <button onClick={markAllPaid} disabled={busy === "bulk"} className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[#d7e0ea] bg-white text-[#34568a] hover:bg-[#f6f9fc] disabled:opacity-60" title="One click to settle everything shown — for the payments you've already paid commission on">
                  {busy === "bulk" ? <Loader2 size={10} className="animate-spin" /> : null} Mark all {pending.length} as paid
                </button>
              )}
              <button onClick={load} disabled={loading} className="inline-flex items-center gap-1 text-[#34568a] hover:underline disabled:opacity-60"><RefreshCw size={10} className={loading ? "animate-spin" : ""} /> Reload</button>
            </span>
          </div>
          {deals.length === 0 ? <p className="px-3 pb-3 text-sm text-[#8595a8]">No closed deals yet.</p> : (
            <ul className="divide-y divide-[#eef3f8] max-h-[55vh] overflow-y-auto">
              {deals.map((d) => (
                <li key={d.key + d.closedAt} className={cn("px-3 py-2 text-[12px] flex items-center gap-2 flex-wrap", d.installments.some((i) => !i.commission?.paidAt) && "bg-[#fffaf5]")}>
                  <span className="font-semibold text-[#1f3559]">{d.name}</span>
                  {who === "ALL" && <span className="text-[#697a91]">· {d.closer}</span>}
                  <span className="text-[#697a91]">· closed {day(d.closedAt)}{d.upfront ? ` · $${d.upfront.toLocaleString()} upfront` : ""}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold border bg-[#f1f5f9] text-[#475569] border-[#e2e8f0]">{d.plan}</span>
                  {d.agreement.signed
                    ? <span className="px-1.5 py-0.5 rounded text-[10px] font-bold border bg-emerald-50 text-emerald-700 border-emerald-200" title={`Signed agreement on file as “${d.agreement.as}”`}>📝 agreement signed</span>
                    : <span className="px-1.5 py-0.5 rounded text-[10px] font-bold border bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]" title="No signed agreement with this name in the Signed Agreements tab or Clients Master — commission can't be requested until the client signs">🔒 no signed agreement</span>}
                  {d.matchedAs && <span className="text-[10px] text-[#8595a8]" title="Matched on the first name — the financing sheet spells it differently">(“{d.matchedAs}” in the sheet)</span>}
                  {!d.inSheet && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold border bg-[#fff7ec] text-[#9a5b00] border-[#fcd9a8]" title="No row with this name in any month tab of the Financing sheet — check the spelling there">⚠ not in the financing sheet</span>}
                  {d.inSheet && d.installments.length === 0 && <span className="text-[10px] text-[#8595a8]">no paid month yet ({d.months[d.months.length - 1].status || "no status"})</span>}
                  <span className="inline-flex gap-1 flex-wrap">
                    {d.installments.map((i) => {
                      const c = i.commission; const id = `${d.key}|${i.ym}`;
                      const state = c?.paidAt ? "paid" : c?.requestedAt ? "requested" : "new";
                      return (
                        <span key={i.ym} className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold",
                          state === "paid" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : state === "requested" ? "bg-amber-50 text-amber-800 border-amber-200" : "bg-rose-50 text-rose-700 border-rose-200")}
                          title={`${i.label} — ${i.status}${i.day ? ` (day ${i.day})` : ""}${c?.requestedAt ? ` · requested ${day(c.requestedAt)}` : ""}${c?.paidAt ? ` · commission paid ${day(c.paidAt)}` : ""}`}>
                          {ym(i.ym)} ${i.usd.toLocaleString()}
                          {state === "paid" && <span>✅ paid</span>}
                          {state === "requested" && <span>⏳ requested {day(c!.requestedAt)}</span>}
                          {state === "new" && !data.isAdmin && d.agreement.signed && (
                            <button onClick={() => act(d, i, "request")} disabled={busy === id} className="ml-1 px-1.5 py-0.5 rounded bg-[#be123c] text-white hover:bg-[#9f1239] disabled:opacity-60">{busy === id ? <Loader2 size={9} className="animate-spin inline" /> : "Ask for commission"}</button>
                          )}
                          {state === "new" && !data.isAdmin && !d.agreement.signed && <span title="Get the agreement signed first">🔒 needs signed agreement</span>}
                          {state === "new" && data.isAdmin && <span>🔔 went through</span>}
                          {state !== "paid" && data.isAdmin && (
                            <button onClick={() => act(d, i, "paid")} disabled={busy === id} className="ml-1 px-1.5 py-0.5 rounded bg-[#15803d] text-white hover:bg-[#166534] disabled:opacity-60">{busy === id ? <Loader2 size={9} className="animate-spin inline" /> : "Mark paid"}</button>
                          )}
                          {state === "paid" && data.isAdmin && (
                            <button onClick={() => act(d, i, "unpaid")} disabled={busy === id} className="ml-1 text-[#8595a8] hover:underline" title="Undo">undo</button>
                          )}
                        </span>
                      );
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
