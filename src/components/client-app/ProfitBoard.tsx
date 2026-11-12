"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Loader2, Plus, X } from "lucide-react";
import { monthName, profitFor, shiftMonth, type ProfitData } from "@/lib/client-app-profit-math";

/* Profit screen: one big number for the month, then the three things behind
   it — what a client is worth, who came in, what she spent. Every button
   shows it is working; what she types appears at once and is then saved. */

const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const num = (s: string) => { const n = Number(s.replace(/[$,\s]/g, "")); return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null; };
const shortDay = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? "UTC" : "America/New_York" });
};
const INPUT = "w-full rounded-xl border border-[#d7e0ea] bg-white px-3 py-2.5 text-[16px] text-[#1c2b3a] outline-none placeholder:text-[#9aa8b8] focus:border-[#15B7AE]";

export function ProfitBoard({ token, data }: { token: string; data: ProfitData }) {
  const router = useRouter();
  const [d, setD] = useState(data);
  useEffect(() => setD(data), [data]); // the saved version, after each refresh
  const [month, setMonth] = useState(data.thisMonth);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const m = useMemo(() => profitFor(d, month), [d, month]);

  /* Save one change: show it at once, send it, then reload the saved numbers.
     If the save fails the screen goes back to what is really saved. */
  const save = async (key: string, body: Record<string, unknown>, next: ProfitData) => {
    setBusy(key); setErr(null); setD(next);
    try {
      const r = await fetch("/api/client-app/profit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, ...body }) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || "That didn't save. Please try again.");
      router.refresh();
      return true;
    } catch (e) {
      setD(data);
      setErr(e instanceof Error ? e.message : "That didn't save. Please try again.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  // ── What a client is worth ────────────────────────────────────────────────
  const [session, setSession] = useState(d.session != null ? String(d.session) : "");
  const [touchup, setTouchup] = useState(d.touchup ? String(d.touchup) : "");
  const [editPrice, setEditPrice] = useState(d.session == null);
  const sN = num(session), tN = touchup.trim() === "" ? 0 : num(touchup);
  const savePrices = async () => {
    if (sN == null || tN == null) { setErr("Type the price as a number, like 450"); return; }
    if (await save("prices", { action: "prices", session: sN, touchup: tN }, { ...d, session: sN, touchup: tN })) setEditPrice(false);
  };

  // ── One client's own amount ───────────────────────────────────────────────
  const [editRef, setEditRef] = useState<string | null>(null);
  const [amt, setAmt] = useState("");
  const saveAmount = async (ref: string, value: number | null) => {
    const amounts = { ...d.amounts };
    if (value == null) delete amounts[ref]; else amounts[ref] = value;
    if (await save(`amt:${ref}`, { action: "amount", ref, amount: value ?? "" }, { ...d, amounts })) setEditRef(null);
  };

  // ── Expenses ──────────────────────────────────────────────────────────────
  const [label, setLabel] = useState("");
  const [cost, setCost] = useState("");
  const [kind, setKind] = useState<"monthly" | "once">("monthly");
  const addExpense = async () => {
    const amount = num(cost);
    if (!label.trim()) { setErr("Give the expense a name, like Rent"); return; }
    if (amount == null || amount <= 0) { setErr("Type the amount as a number, like 120"); return; }
    const temp = { id: `new-${Date.now()}`, label: label.trim(), amount, kind, month, endMonth: null };
    if (await save("add", { action: "expense_add", label, amount, kind, month }, { ...d, expenses: [...d.expenses, temp] })) { setLabel(""); setCost(""); }
  };
  const stopExpense = (id: string) => {
    const e = d.expenses.find((x) => x.id === id);
    if (!e) return;
    const keepPast = e.kind === "monthly" && e.month < month;
    const expenses = keepPast ? d.expenses.map((x) => (x.id === id ? { ...x, endMonth: month } : x)) : d.expenses.filter((x) => x.id !== id);
    void save(`stop:${id}`, { action: "expense_stop", id, month }, { ...d, expenses });
  };

  const hasPrice = d.session != null;
  return (
    <div className="space-y-3">
      {/* Month */}
      <div className="flex items-center justify-between rounded-2xl border border-[#e4ebf2] bg-white px-2 py-1.5">
        <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month" className="rounded-full p-2 text-[#52627a] active:opacity-70"><ChevronLeft size={20} /></button>
        <p className="text-sm font-extrabold text-[#1c2b3a]">{monthName(month, true)}</p>
        <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= d.thisMonth} aria-label="Next month" className="rounded-full p-2 text-[#52627a] active:opacity-70 disabled:opacity-25"><ChevronRight size={20} /></button>
      </div>

      {/* The number */}
      <section className="rounded-2xl border border-[#c7edd4] bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#15803d]">Your profit</p>
        {hasPrice ? (
          <>
            <p className={`text-4xl font-extrabold ${m.profit < 0 ? "text-[#be123c]" : "text-[#1c2b3a]"}`}>{usd(m.profit)}</p>
            <p className="text-sm text-[#7b8a9c]">{usd(m.revenue)} revenue − {usd(m.spent)} expenses</p>
          </>
        ) : (
          <>
            <p className="text-2xl font-extrabold text-[#1c2b3a]">Add your price</p>
            <p className="text-sm text-[#7b8a9c]">Then we count your profit for you, every month.</p>
          </>
        )}
      </section>

      {err && <p className="rounded-xl bg-[#fde8ee] px-3 py-2 text-center text-xs font-semibold text-[#be123c]">{err}</p>}

      {/* What a client is worth */}
      <section className="rounded-2xl border border-[#e4ebf2] bg-white px-4 py-3">
        {!editPrice ? (
          <button onClick={() => setEditPrice(true)} className="flex w-full items-center gap-2 text-left active:opacity-80">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-[#1c2b3a]">One client is worth {usd(m.worth)}</span>
              <span className="block text-xs text-[#7b8a9c]">{usd(d.session ?? 0)} session{d.touchup ? ` + ${usd(d.touchup)} touch-up` : ""}</span>
            </span>
            <span className="text-xs font-semibold text-[#0e8f88]">Change</span>
          </button>
        ) : (
          <>
            <p className="text-sm font-bold text-[#1c2b3a]">What is one client worth to you?</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-[#52627a]">Session price</span>
                <input value={session} onChange={(e) => setSession(e.target.value)} inputMode="decimal" placeholder="$450" className={INPUT} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-[#52627a]">Touch-up price</span>
                <input value={touchup} onChange={(e) => setTouchup(e.target.value)} inputMode="decimal" placeholder="$150" className={INPUT} />
              </label>
            </div>
            <button onClick={() => void savePrices()} disabled={busy === "prices"}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-[#15B7AE] px-4 py-2.5 text-sm font-bold text-white active:opacity-80 disabled:opacity-70">
              {busy === "prices" ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {busy === "prices" ? "Saving…" : sN != null && tN != null ? `Save · ${usd(sN + tN)} per client` : "Save"}
            </button>
          </>
        )}
      </section>

      {/* Who came in */}
      <section className="rounded-2xl border border-[#e4ebf2] bg-white px-4 py-3">
        <div className="flex items-end">
          <p className="text-sm font-bold text-[#1c2b3a]">Clients this month</p>
          <p className="ml-auto text-sm font-bold text-[#1c2b3a]">{m.clients.length}{hasPrice ? ` · ${usd(m.revenue)}` : ""}</p>
        </div>
        {m.clients.length === 0 ? (
          <p className="py-2 text-sm text-[#7b8a9c]">No clients came in this month yet.</p>
        ) : (
          <ul className="mt-1">
            {m.clients.map((c) => (
              <li key={c.ref} className="border-b border-[#eef3f8] py-2 last:border-0">
                {editRef === c.ref ? (
                  <div>
                    <p className="text-sm font-semibold text-[#1c2b3a]">{c.name}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <input autoFocus value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder={usd(m.worth)} className={INPUT} />
                      <button onClick={() => { const v = num(amt); if (v == null) setErr("Type the amount as a number, like 450"); else void saveAmount(c.ref, v); }} disabled={busy === `amt:${c.ref}`}
                        className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[#15B7AE] px-3.5 py-2.5 text-sm font-bold text-white active:opacity-80 disabled:opacity-70">
                        {busy === `amt:${c.ref}` ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save
                      </button>
                    </div>
                    <div className="mt-1.5 flex gap-4 text-xs font-semibold">
                      {c.own && <button onClick={() => void saveAmount(c.ref, null)} className="text-[#0e8f88]">Use my usual {usd(m.worth)}</button>}
                      <button onClick={() => setEditRef(null)} className="text-[#8595a8]">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setEditRef(c.ref); setAmt(c.own ? String(c.amount) : ""); setErr(null); }} className="flex w-full items-center gap-2 text-left active:opacity-80">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[#1c2b3a]">{c.name}</span>
                      <span className="block text-xs text-[#7b8a9c]">{shortDay(c.date)}{c.own ? " · your amount" : ""}</span>
                    </span>
                    <span className="text-sm font-bold text-[#1c2b3a]">{hasPrice || c.own ? usd(c.amount) : "—"}</span>
                    <span className="text-xs font-semibold text-[#0e8f88]">Edit</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* What she spent */}
      <section className="rounded-2xl border border-[#e4ebf2] bg-white px-4 py-3">
        <div className="flex items-end">
          <p className="text-sm font-bold text-[#1c2b3a]">Expenses</p>
          <p className="ml-auto text-sm font-bold text-[#1c2b3a]">{usd(m.spent)}</p>
        </div>
        {m.expenses.length > 0 && (
          <ul className="mt-1">
            {m.expenses.map((e) => (
              <li key={e.id} className="flex items-center gap-2 border-b border-[#eef3f8] py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[#1c2b3a]">{e.label}</span>
                  <span className="block text-xs text-[#7b8a9c]">{e.kind === "monthly" ? "Every month" : "One time"}</span>
                </span>
                <span className="text-sm font-bold text-[#1c2b3a]">{usd(e.amount)}</span>
                <button onClick={() => stopExpense(e.id)} disabled={busy === `stop:${e.id}`}
                  aria-label={e.kind === "monthly" && e.month < month ? `Stop ${e.label} from this month` : `Remove ${e.label}`}
                  className="rounded-full p-1.5 text-[#9aa8b8] active:opacity-70 disabled:opacity-50">
                  {busy === `stop:${e.id}` ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2.5 grid grid-cols-[1fr_6.5rem] gap-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="Rent, supplies, ads…" className={INPUT} />
          <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="$120" className={INPUT} />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex flex-1 rounded-xl bg-[#eef3f8] p-1 text-xs font-bold">
            {(["monthly", "once"] as const).map((k) => (
              <button key={k} onClick={() => setKind(k)} className={`flex-1 rounded-lg py-2 ${kind === k ? "bg-white text-[#0e8f88] shadow-sm" : "text-[#7b8a9c]"}`}>
                {k === "monthly" ? "Every month" : "One time"}
              </button>
            ))}
          </div>
          <button onClick={() => void addExpense()} disabled={busy === "add"}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[#15B7AE] px-4 py-2.5 text-sm font-bold text-white active:opacity-80 disabled:opacity-70">
            {busy === "add" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add
          </button>
        </div>
      </section>
    </div>
  );
}
