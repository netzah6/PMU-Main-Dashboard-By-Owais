"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Loader2, Plus, X } from "lucide-react";
import {
  KIND_LABEL, clientsToAdd, monthName, profitFor, shiftMonth,
  type ExpenseKind, type ProfitData, type ProfitExpense,
} from "@/lib/client-app-profit-math";

/* Profit, in the owner's order (11/12/2026):
     1. Her clients — what EACH one paid her, all of them → Submit
     2. Her costs — rent (monthly or per client), equipment, supplies…
     3. Her profit, month by month
   The profit is never shown before steps 1 and 2 are done. Every button
   shows it is working; what she types appears at once and is then saved. */

const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const num = (s: string) => { const n = Number(s.replace(/[$,\s]/g, "")); return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null; };
const shortDay = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? "UTC" : "America/New_York" });
};
const INPUT = "w-full rounded-xl border border-[#d7e0ea] bg-white px-3 py-2.5 text-[16px] text-[#1c2b3a] outline-none placeholder:text-[#9aa8b8] focus:border-[#15B7AE]";
const CARD = "rounded-2xl border border-[#e4ebf2] bg-white px-4 py-3";
const MAIN_BTN = "flex w-full items-center justify-center gap-2 rounded-xl bg-[#15B7AE] px-4 py-3 text-sm font-bold text-white active:opacity-80 disabled:opacity-50";
// Costs a permanent-makeup artist usually has — one tap fills the name in.
const IDEAS = ["Rent", "Supplies", "Equipment", "Insurance", "Numbing cream", "Software", "Ads"];

type Save = (key: string, body: Record<string, unknown>, next?: ProfitData) => Promise<boolean>;

function Steps({ step }: { step: 1 | 2 }) {
  return (
    <div className="flex items-center gap-2 px-1">
      {(["Your clients", "Your costs", "Your profit"] as const).map((t, i) => (
        <div key={t} className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={`h-1.5 rounded-full ${i + 1 <= step ? "bg-[#15B7AE]" : "bg-[#dbe4ee]"}`} />
          <span className={`truncate text-[11px] font-bold ${i + 1 === step ? "text-[#0e8f88]" : "text-[#9aa8b8]"}`}>{i + 1}. {t}</span>
        </div>
      ))}
    </div>
  );
}

/* Add a cost: name, amount, how often. */
/* `month` = where a repeating cost starts; `onceMonth` = the month a one-time cost belongs to. */
function AddCost({ month: startMonth, onceMonth, busy, save, d, setErr }: { month: string; onceMonth: string; busy: string | null; save: Save; d: ProfitData; setErr: (s: string | null) => void }) {
  const [label, setLabel] = useState("");
  const [cost, setCost] = useState("");
  const [kind, setKind] = useState<ExpenseKind>("monthly");
  const add = async () => {
    const amount = num(cost);
    if (!label.trim()) { setErr("Give the cost a name, like Rent"); return; }
    if (amount == null || amount <= 0) { setErr("Type the amount as a number, like 120"); return; }
    const month = kind === "once" ? onceMonth : startMonth;
    const temp: ProfitExpense = { id: `new-${Date.now()}`, label: label.trim(), amount, kind, month, endMonth: null };
    if (await save("add", { action: "expense_add", label, amount, kind, month }, { ...d, expenses: [...d.expenses, temp] })) { setLabel(""); setCost(""); }
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {IDEAS.map((t) => (
          <button key={t} onClick={() => setLabel(t)} className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${label === t ? "border-[#15B7AE] bg-[#e6f7f5] text-[#0e8f88]" : "border-[#d7e0ea] bg-white text-[#52627a]"}`}>{t}</button>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-[1fr_6.5rem] gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="Name — like Rent" className={INPUT} />
        <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="$120" className={INPUT} />
      </div>
      <div className="mt-2 flex rounded-xl bg-[#eef3f8] p-1 text-xs font-bold">
        {(["monthly", "per_client", "once"] as const).map((k) => (
          <button key={k} onClick={() => setKind(k)} className={`flex-1 rounded-lg py-2 ${kind === k ? "bg-white text-[#0e8f88] shadow-sm" : "text-[#7b8a9c]"}`}>{KIND_LABEL[k]}</button>
        ))}
      </div>
      <p className="mt-1 px-1 text-[11px] text-[#8595a8]">
        {kind === "per_client" ? "Counted once for every client that month — for rent you pay per appointment." : kind === "monthly" ? "Counted every month." : "Counted this month only."}
      </p>
      <button onClick={() => void add()} disabled={busy === "add"} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#15B7AE] bg-white px-4 py-2.5 text-sm font-bold text-[#0e8f88] active:opacity-80 disabled:opacity-60">
        {busy === "add" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} {busy === "add" ? "Adding…" : "Add this cost"}
      </button>
    </div>
  );
}

export function ProfitBoard({ token, data }: { token: string; data: ProfitData }) {
  const router = useRouter();
  const [d, setD] = useState(data);
  useEffect(() => setD(data), [data]); // the saved version, after each refresh
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [back, setBack] = useState(false); // step 2 → look at step 1 again

  /* Save one change: show it at once, send it, then reload the saved numbers.
     If the save fails the screen goes back to what is really saved. */
  const save: Save = async (key, body, next) => {
    setBusy(key); setErr(null);
    if (next) setD(next);
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
  const stopExpense = (id: string, month: string) => {
    const e = d.expenses.find((x) => x.id === id);
    if (!e) return;
    const keepPast = e.kind !== "once" && e.month < month;
    const expenses = keepPast ? d.expenses.map((x) => (x.id === id ? { ...x, endMonth: month } : x)) : d.expenses.filter((x) => x.id !== id);
    void save(`stop:${id}`, { action: "expense_stop", id, month }, { ...d, expenses });
  };
  const Err = err ? <p className="rounded-xl bg-[#fde8ee] px-3 py-2 text-center text-xs font-semibold text-[#be123c]">{err}</p> : null;

  // ── Step 1 · her clients, what each one paid ──────────────────────────────
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(data.clients.map((c) => [c.ref, data.amounts[c.ref] != null ? String(data.amounts[c.ref]) : ""])));
  const [session, setSession] = useState(data.session != null ? String(data.session) : "");
  const [touchup, setTouchup] = useState(data.touchup ? String(data.touchup) : "");
  const usual = (num(session) ?? 0) + (num(touchup) ?? 0);
  const filled = d.clients.filter((c) => num(vals[c.ref] ?? "") != null).length;
  const submitClients = async () => {
    const amounts: Record<string, number> = {};
    for (const c of d.clients) { const v = num(vals[c.ref] ?? ""); if (v != null) amounts[c.ref] = v; }
    if (await save("submit", { action: "clients_submit", amounts, session: num(session) ?? "", touchup: num(touchup) ?? "" }, { ...d, amounts, step: d.step === 1 ? 2 : d.step })) {
      setBack(false);
      window.scrollTo({ top: 0 });
    }
  };

  if (d.step === 1 || back) {
    let lastMonth = "";
    return (
      <div className="space-y-3">
        <Steps step={1} />
        <section className={CARD}>
          <p className="text-base font-extrabold text-[#1c2b3a]">What did each client pay you?</p>
          <p className="text-sm text-[#7b8a9c]">These are the clients who came in through us. Add the full amount for each one, touch-up included.</p>
        </section>

        {d.clients.length > 0 && (
          <section className={CARD}>
            <p className="text-sm font-bold text-[#1c2b3a]">Faster: your usual price</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-[#52627a]">Session</span>
                <input value={session} onChange={(e) => setSession(e.target.value)} inputMode="decimal" placeholder="$450" className={INPUT} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-[#52627a]">Touch-up</span>
                <input value={touchup} onChange={(e) => setTouchup(e.target.value)} inputMode="decimal" placeholder="$150" className={INPUT} />
              </label>
            </div>
            <button disabled={usual <= 0}
              onClick={() => setVals((v) => Object.fromEntries(d.clients.map((c) => [c.ref, (v[c.ref] ?? "").trim() === "" ? String(usual) : v[c.ref]])))}
              className="mt-2 w-full rounded-xl border border-[#15B7AE] bg-white px-4 py-2.5 text-sm font-bold text-[#0e8f88] active:opacity-80 disabled:opacity-40">
              {usual > 0 ? `Fill the empty ones with ${usd(usual)}` : "Fill the empty ones"}
            </button>
            <p className="mt-1 text-center text-[11px] text-[#8595a8]">Then change any client who paid a different amount.</p>
          </section>
        )}

        <section className={CARD}>
          <div className="flex items-end">
            <p className="text-sm font-bold text-[#1c2b3a]">Your clients</p>
            <p className="ml-auto text-sm font-bold text-[#1c2b3a]">{filled} of {d.clients.length} done</p>
          </div>
          {d.clients.length === 0 ? (
            <p className="py-2 text-sm text-[#7b8a9c]">No clients came in yet. They will show here as soon as they do.</p>
          ) : (
            <ul className="mt-1">
              {d.clients.map((c) => {
                const head = c.month && c.month !== lastMonth ? monthName(c.month, true) : "";
                lastMonth = c.month ?? lastMonth;
                return (
                  <li key={c.ref}>
                    {head && <p className="pt-2 text-[11px] font-bold uppercase tracking-wide text-[#8595a8]">{head}</p>}
                    <label className="flex items-center gap-2 border-b border-[#eef3f8] py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-[#1c2b3a]">{c.name}</span>
                        <span className="block text-xs text-[#7b8a9c]">{shortDay(c.date)}</span>
                      </span>
                      <input value={vals[c.ref] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [c.ref]: e.target.value }))} inputMode="decimal" placeholder="$"
                        aria-label={`Amount for ${c.name}`} className={`${INPUT} w-28 text-right ${num(vals[c.ref] ?? "") == null ? "" : "border-[#bfe9e5] bg-[#f6fdfc]"}`} />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {Err}
        <div className="sticky z-[6] -mx-3 border-t border-[#e4ebf2] bg-[#f3f7fb]/95 px-3 py-2 backdrop-blur" style={{ bottom: "calc(env(safe-area-inset-bottom) + 68px)" }}>
          <button onClick={() => void submitClients()} disabled={busy === "submit" || filled < d.clients.length} className={MAIN_BTN}>
            {busy === "submit" ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
            {busy === "submit" ? "Saving…" : filled < d.clients.length ? `${d.clients.length - filled} more to add` : "Submit · next: your costs"}
          </button>
        </div>
      </div>
    );
  }

  // ── Step 2 · her costs ────────────────────────────────────────────────────
  if (d.step === 2) {
    return (
      <div className="space-y-3">
        <Steps step={2} />
        <section className={CARD}>
          <p className="text-base font-extrabold text-[#1c2b3a]">Now add your costs</p>
          <p className="text-sm text-[#7b8a9c]">Rent, supplies, equipment — what you pay to do the work. You can change them any time.</p>
        </section>
        <section className={CARD}>
          {d.expenses.length > 0 && (
            <ul className="mb-3">
              {d.expenses.map((e) => (
                <li key={e.id} className="flex items-center gap-2 border-b border-[#eef3f8] py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-[#1c2b3a]">{e.label}</span>
                    <span className="block text-xs text-[#7b8a9c]">{KIND_LABEL[e.kind]}</span>
                  </span>
                  <span className="text-sm font-bold text-[#1c2b3a]">{usd(e.amount)}</span>
                  <button onClick={() => stopExpense(e.id, e.month)} disabled={busy === `stop:${e.id}`} aria-label={`Remove ${e.label}`} className="rounded-full p-1.5 text-[#9aa8b8] active:opacity-70 disabled:opacity-50">
                    {busy === `stop:${e.id}` ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* Costs added here count from her first month with us, so the past months are right too. */}
          <AddCost month={d.firstMonth} onceMonth={d.thisMonth} busy={busy} save={save} d={d} setErr={setErr} />
        </section>
        {Err}
        <button onClick={() => void save("done", { action: "setup_done" }, { ...d, step: 3 })} disabled={busy === "done"} className={MAIN_BTN}>
          {busy === "done" ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          {busy === "done" ? "Opening…" : d.expenses.length ? "See my profit" : "No costs to add — see my profit"}
        </button>
        <button onClick={() => { setBack(true); setErr(null); }} className="block w-full py-1 text-center text-xs font-semibold text-[#8595a8]">‹ Back to my clients</button>
      </div>
    );
  }

  // ── Step 3 · the profit ───────────────────────────────────────────────────
  return <Board d={d} busy={busy} save={save} stopExpense={stopExpense} setErr={setErr} Err={Err} />;
}

function Board({ d, busy, save, stopExpense, setErr, Err }: {
  d: ProfitData; busy: string | null; save: Save; stopExpense: (id: string, month: string) => void; setErr: (s: string | null) => void; Err: React.ReactNode;
}) {
  const [month, setMonth] = useState(d.thisMonth);
  const m = useMemo(() => profitFor(d, month), [d, month]);
  const waiting = clientsToAdd(d);
  const [editRef, setEditRef] = useState<string | null>(null);
  const [amt, setAmt] = useState("");
  const usual = (d.session ?? 0) + (d.touchup ?? 0);
  const saveAmount = async (ref: string) => {
    const v = num(amt);
    if (v == null) { setErr("Type the amount as a number, like 450"); return; }
    if (await save(`amt:${ref}`, { action: "amount", ref, amount: v }, { ...d, amounts: { ...d.amounts, [ref]: v } })) setEditRef(null);
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-2xl border border-[#e4ebf2] bg-white px-2 py-1.5">
        <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month" className="rounded-full p-2 text-[#52627a] active:opacity-70"><ChevronLeft size={20} /></button>
        <p className="text-sm font-extrabold text-[#1c2b3a]">{monthName(month, true)}</p>
        <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= d.thisMonth} aria-label="Next month" className="rounded-full p-2 text-[#52627a] active:opacity-70 disabled:opacity-25"><ChevronRight size={20} /></button>
      </div>

      <section className="rounded-2xl border border-[#c7edd4] bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#15803d]">Your profit</p>
        <p className={`text-4xl font-extrabold ${m.profit < 0 ? "text-[#be123c]" : "text-[#1c2b3a]"}`}>{usd(m.profit)}</p>
        <p className="text-sm text-[#7b8a9c]">{usd(m.revenue)} from clients − {usd(m.spent)} costs</p>
      </section>

      {waiting > 0 && (
        <p className="rounded-2xl border border-[#fcd9a8] bg-[#fffaf2] px-4 py-3 text-sm font-semibold text-[#92400e]">
          {waiting} new client{waiting === 1 ? "" : "s"} to add{m.toAdd > 0 && m.toAdd < waiting ? ` (${m.toAdd} this month)` : m.toAdd === 0 ? " — in another month" : ""}. Tap &ldquo;Add&rdquo; next to the name.
        </p>
      )}
      {Err}

      <section className={CARD}>
        <div className="flex items-end">
          <p className="text-sm font-bold text-[#1c2b3a]">Clients this month</p>
          <p className="ml-auto text-sm font-bold text-[#1c2b3a]">{m.clients.length} · {usd(m.revenue)}</p>
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
                      <input autoFocus value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder={usual > 0 ? usd(usual) : "$"} className={INPUT} />
                      <button onClick={() => void saveAmount(c.ref)} disabled={busy === `amt:${c.ref}`}
                        className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[#15B7AE] px-3.5 py-2.5 text-sm font-bold text-white active:opacity-80 disabled:opacity-70">
                        {busy === `amt:${c.ref}` ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save
                      </button>
                    </div>
                    <button onClick={() => setEditRef(null)} className="mt-1.5 text-xs font-semibold text-[#8595a8]">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => { setEditRef(c.ref); setAmt(c.amount != null ? String(c.amount) : usual > 0 ? String(usual) : ""); setErr(null); }} className="flex w-full items-center gap-2 text-left active:opacity-80">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[#1c2b3a]">{c.name}</span>
                      <span className="block text-xs text-[#7b8a9c]">{shortDay(c.date)}</span>
                    </span>
                    {c.amount != null
                      ? <><span className="text-sm font-bold text-[#1c2b3a]">{usd(c.amount)}</span><span className="text-xs font-semibold text-[#0e8f88]">Edit</span></>
                      : <span className="rounded-full bg-[#fff4e5] px-2.5 py-1 text-xs font-bold text-[#b45309]">Add</span>}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={CARD}>
        <div className="flex items-end">
          <p className="text-sm font-bold text-[#1c2b3a]">Costs</p>
          <p className="ml-auto text-sm font-bold text-[#1c2b3a]">{usd(m.spent)}</p>
        </div>
        {m.expenses.length > 0 && (
          <ul className="mt-1">
            {m.expenses.map((e) => (
              <li key={e.id} className="flex items-center gap-2 border-b border-[#eef3f8] py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[#1c2b3a]">{e.label}</span>
                  <span className="block text-xs text-[#7b8a9c]">{e.kind === "per_client" ? `${usd(e.amount)} × ${m.clients.length} client${m.clients.length === 1 ? "" : "s"}` : KIND_LABEL[e.kind]}</span>
                </span>
                <span className="text-sm font-bold text-[#1c2b3a]">{usd(e.cost)}</span>
                <button onClick={() => stopExpense(e.id, month)} disabled={busy === `stop:${e.id}`}
                  aria-label={e.kind !== "once" && e.month < month ? `Stop ${e.label} from this month` : `Remove ${e.label}`}
                  className="rounded-full p-1.5 text-[#9aa8b8] active:opacity-70 disabled:opacity-50">
                  {busy === `stop:${e.id}` ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}
                </button>
              </li>
            ))}
          </ul>
        )}
        <details className="mt-2">
          <summary className="cursor-pointer list-none text-sm font-bold text-[#0e8f88]">+ Add a cost</summary>
          <div className="mt-2"><AddCost month={month} onceMonth={month} busy={busy} save={save} d={d} setErr={setErr} /></div>
        </details>
      </section>
    </div>
  );
}
