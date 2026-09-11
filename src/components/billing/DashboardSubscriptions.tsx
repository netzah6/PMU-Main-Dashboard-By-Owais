"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Loader2, Plus, X, Play, Pause, Check, Trash2, ExternalLink, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// Subscriptions billed from here instead of Square, so pausing one never sends
// the client Square's "your subscription is paused" email. Square subscriptions
// that already exist are untouched; this is for clients who have none.
//
// Three deliberate brakes, because this charges real cards:
//   - a new subscription starts as a DRAFT and bills nothing until activated
//   - the scheduled run moves no money while the master switch is off
//   - "Charge now" always asks first, naming the client and the amount

type Sub = {
  id: string; owner_key: string; client_label: string | null; amount_cents: number;
  cadence: "monthly" | "once"; charge_day: number | null; next_charge_on: string;
  status: "draft" | "active" | "paused" | "ended"; note: string | null;
  created_by: string | null; activated_by: string | null;
};
type Charge = {
  id: string; subscription_id: string; owner_key: string; amount_cents: number;
  status: "succeeded" | "failed"; square_payment_id: string | null; receipt_url: string | null;
  error: string | null; charged_by: string | null; period_key: string | null; charged_at: string;
};

const money = (c: number) => `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmt = (d: string | null) => {
  if (!d) return "—";
  const x = new Date(`${d.slice(0, 10)}T12:00:00`);
  return isNaN(x.getTime()) ? d : x.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const TONE: Record<Sub["status"], string> = {
  draft: "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]",
  active: "bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]",
  paused: "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]",
  ended: "bg-[#f6f7f9] text-[#94a3b8] border-[#e2e8f0]",
};

export function DashboardSubscriptions() {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [autocharge, setAutocharge] = useState(false);
  const [clients, setClients] = useState<Array<{ key: string; label: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState({ ownerKey: "", amount: "", cadence: "monthly", nextChargeOn: "", note: "" });
  // Type-to-find replaces the 200-row dropdown: the query is what the admin
  // typed, and the pick is the client they clicked from the matches.
  const [clientQuery, setClientQuery] = useState("");
  const [showMatches, setShowMatches] = useState(false);
  // Which subscription is having its next-charge date changed inline.
  const [dateEdit, setDateEdit] = useState<{ id: string; value: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/subscriptions/manage");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load");
      setSubs(j.subscriptions ?? []); setCharges(j.charges ?? []); setAutocharge(!!j.autocharge);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed to load"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Client picker — live/paused clients from the master sheet.
  useEffect(() => {
    createClient().from("clients_master").select("data").then(({ data }) => {
      const seen = new Map<string, string>();
      for (const r of (data ?? []) as Array<{ data: Record<string, string> }>) {
        const status = String(r.data?.["col_1"] ?? "").toLowerCase();
        if (status !== "live" && status !== "paused") continue;
        const owner = String(r.data?.["Owner Full Name"] ?? "").trim();
        if (!owner) continue;
        const biz = String(r.data?.["Business Name"] ?? "").trim();
        seen.set(owner.toLowerCase(), `${owner}${biz ? ` — ${biz}` : ""}`);
      }
      setClients([...seen.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label)));
    });
  }, []);

  const act = async (body: Record<string, unknown>, tag: string) => {
    setBusy(tag); setErr(null); setMsg(null);
    try {
      const r = await fetch("/api/subscriptions/manage", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Action failed");
      await load();
      return true;
    } catch (e) { setErr(e instanceof Error ? e.message : "Action failed"); return false; }
    finally { setBusy(null); }
  };

  const chargeNow = async (s: Sub) => {
    const who = s.client_label || s.owner_key;
    if (!window.confirm(`Charge ${who} ${money(s.amount_cents)} on their card now?\n\nThis moves real money immediately.`)) return;
    setBusy(`charge:${s.id}`); setErr(null); setMsg(null);
    try {
      const r = await fetch("/api/subscriptions/charge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: s.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Charge failed");
      setMsg(`Charged ${who} ${money(j.amountCents)} on ${j.card}.`);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Charge failed"); }
    finally { setBusy(null); }
  };

  const submit = async () => {
    const ok = await act({ action: "create", ...form, clientLabel: clients.find((c) => c.key === form.ownerKey)?.label ?? "" }, "new");
    if (ok) { setAdding(false); setForm({ ownerKey: "", amount: "", cadence: "monthly", nextChargeOn: "", note: "" }); setClientQuery(""); }
  };

  const clientMatches = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    if (!q) return [];
    return clients.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8);
  }, [clientQuery, clients]);

  const byId = useMemo(() => {
    const m = new Map<string, Charge[]>();
    for (const c of charges) m.set(c.subscription_id, [...(m.get(c.subscription_id) ?? []), c]);
    return m;
  }, [charges]);

  const activeTotal = subs.filter((s) => s.status === "active" && s.cadence === "monthly")
    .reduce((t, s) => t + s.amount_cents, 0);

  return (
    <div className="rounded-xl border border-[#cfe3f7] bg-[#f7fbff] p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-bold text-[#1d4ed8]">Dashboard subscriptions</h2>
        <span className="text-[11px] text-[#5b7aa8]">billed from here, so pausing never emails the client</span>
        {activeTotal > 0 && (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#e6f7ee] text-[#15803d] border border-[#c7edd4]">
            {money(activeTotal)}/mo active
          </span>
        )}
        <button onClick={() => setAdding((a) => !a)}
          className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border border-[#bfdbfe] bg-white text-[#1d4ed8] hover:bg-[#eff6ff]">
          {adding ? <X size={12} /> : <Plus size={12} />} {adding ? "Cancel" : "New subscription"}
        </button>
      </div>

      {/* Master switch. Off means the daily run reports what is due and charges nothing. */}
      <div className={cn("rounded-lg border px-2.5 py-1.5 flex items-center gap-2 flex-wrap",
        autocharge ? "border-[#c7edd4] bg-[#f4fbf7]" : "border-[#fcd9a8] bg-[#fffdf7]")}>
        {autocharge
          ? <Check size={13} className="text-[#15803d] shrink-0" />
          : <AlertTriangle size={13} className="text-[#b45309] shrink-0" />}
        <span className={cn("text-[11px] font-bold", autocharge ? "text-[#15803d]" : "text-[#b45309]")}>
          {autocharge ? "Automatic charging is ON" : "Automatic charging is OFF"}
        </span>
        <span className="text-[11px] text-[#697a91]">
          {autocharge
            ? "The daily run charges active subscriptions on their due date."
            : "Nothing is charged automatically. Active subscriptions still show what is due, and “Charge now” still works."}
        </span>
        <button
          onClick={() => {
            if (!autocharge && !window.confirm("Turn ON automatic charging?\n\nFrom now on the daily run will charge every ACTIVE subscription on its due date, without asking.")) return;
            act({ action: "autocharge", enabled: !autocharge }, "switch");
          }}
          disabled={busy === "switch"}
          className={cn("ml-auto px-2.5 py-1 rounded-lg text-[11px] font-bold border",
            autocharge ? "bg-white text-[#b45309] border-[#fcd9a8]" : "bg-[#15B7AE] text-white border-[#15B7AE]")}>
          {busy === "switch" ? "…" : autocharge ? "Turn off" : "Turn on"}
        </button>
      </div>

      {err && <p className="text-[11px] text-[#e11d48] bg-[#fde8ee] border border-[#f5c2cf] rounded-lg px-2 py-1">{err}</p>}
      {msg && <p className="text-[11px] text-[#15803d] bg-[#e6f7ee] border border-[#c7edd4] rounded-lg px-2 py-1">{msg}</p>}

      {adding && (
        <div className="rounded-lg border border-[#e4ebf2] bg-white p-2.5 space-y-2">
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <input
                value={clientQuery}
                onChange={(e) => { setClientQuery(e.target.value); setShowMatches(true); if (form.ownerKey) setForm({ ...form, ownerKey: "" }); }}
                onFocus={() => setShowMatches(true)}
                onBlur={() => setTimeout(() => setShowMatches(false), 150)}
                placeholder="Start typing the client's name…"
                autoComplete="off"
                className={cn("w-full px-2 py-1.5 bg-[#eef2f7] border rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8]",
                  form.ownerKey ? "border-[#15B7AE]" : "border-[#d7e0ea]")} />
              {form.ownerKey && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-[#0e8f88]">✓ picked</span>}
              {showMatches && clientQuery.trim() && !form.ownerKey && (
                <ul className="absolute z-30 left-0 right-0 mt-1 rounded-lg border border-[#d7e0ea] bg-white shadow-lg max-h-[240px] overflow-y-auto">
                  {clientMatches.length === 0 ? (
                    <li className="px-2.5 py-1.5 text-xs text-[#8595a8]">No live or paused client matches “{clientQuery}”</li>
                  ) : clientMatches.map((c) => (
                    <li key={c.key}>
                      <button type="button" onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setForm({ ...form, ownerKey: c.key }); setClientQuery(c.label); setShowMatches(false); }}
                        className="w-full text-left px-2.5 py-1.5 text-sm text-[#1f3559] hover:bg-[#e6f7f5]">
                        {c.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder="$ amount" inputMode="decimal"
              className="w-[110px] px-2 py-1.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559]" />
            <select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value })}
              className="px-2 py-1.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#34568a]">
              <option value="monthly">Every month</option>
              <option value="once">One time</option>
            </select>
            <input type="date" value={form.nextChargeOn} onChange={(e) => setForm({ ...form, nextChargeOn: e.target.value })}
              title="First charge date"
              className="px-2 py-1.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#34568a]" />
          </div>
          <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
            placeholder="Note (shows on the Square payment, e.g. “3-month plan 1/3”)"
            className="w-full px-2 py-1.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559]" />
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={submit} disabled={busy === "new" || !form.ownerKey || !form.amount || !form.nextChargeOn}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#15B7AE] text-[#1f3559] disabled:opacity-50">
              {busy === "new" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Create as draft
            </button>
            <span className="text-[11px] text-[#697a91]">
              Saved as a draft — it charges nothing until you activate it. Monthly repeats on the same day, so pick day 1–28.
            </span>
          </div>
        </div>
      )}

      {loading && subs.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-[#697a91] py-3"><Loader2 size={13} className="animate-spin" /> Loading…</div>
      ) : subs.length === 0 ? (
        <p className="text-xs text-[#8595a8] py-2">No dashboard subscriptions yet. Square subscriptions are listed below and are untouched by this.</p>
      ) : (
        <ul className="space-y-1">
          {subs.map((s) => {
            const hist = byId.get(s.id) ?? [];
            const last = hist[0];
            const open = openId === s.id;
            return (
              <li key={s.id} className="rounded-lg border border-[#e4ebf2] bg-white">
                <div className="flex items-center gap-2 flex-wrap px-2.5 py-1.5">
                  <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border", TONE[s.status])}>{s.status}</span>
                  <span className="text-[13px] font-semibold text-[#1f3559]">{s.client_label || s.owner_key}</span>
                  <span className="text-[13px] font-bold text-[#0e8f88] tabular-nums">{money(s.amount_cents)}</span>
                  <span className="text-[11px] text-[#697a91]">{s.cadence === "monthly" ? "every month" : "one time"}</span>
                  {s.status !== "ended" && (dateEdit?.id === s.id ? (
                    <span className="flex items-center gap-1">
                      <input type="date" value={dateEdit.value} min={new Date().toISOString().slice(0, 10)}
                        onChange={(e) => setDateEdit({ id: s.id, value: e.target.value })}
                        className="px-1.5 py-0.5 rounded border border-[#15B7AE] text-[11px] text-[#1f3559]" />
                      <button onClick={async () => {
                          if (!dateEdit.value) return;
                          if (s.cadence === "monthly" && Number(dateEdit.value.slice(8, 10)) > 28) { setErr("Pick a day from 1–28 so every month has that date"); return; }
                          const ok = await act({ action: "update", id: s.id, nextChargeOn: dateEdit.value }, `date:${s.id}`);
                          if (ok) { setDateEdit(null); setMsg(`${s.client_label || s.owner_key}: next charge moved to ${fmt(dateEdit.value)}${s.cadence === "monthly" ? `, and the ${Number(dateEdit.value.slice(8, 10))}th of each month after` : ""}.`); }
                        }}
                        disabled={busy === `date:${s.id}`}
                        className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#15B7AE] text-white">{busy === `date:${s.id}` ? "…" : "Save"}</button>
                      <button onClick={() => setDateEdit(null)} className="px-1 text-[10px] text-[#8595a8]">cancel</button>
                    </span>
                  ) : (
                    <button onClick={() => setDateEdit({ id: s.id, value: s.next_charge_on })}
                      title={s.cadence === "monthly"
                        ? "Change the next charge date — the same day of the month is used from then on. Charges run at 7 AM Pacific."
                        : "Change the charge date. Charges run at 7 AM Pacific."}
                      className={cn("text-[11px] underline decoration-dotted underline-offset-2 hover:text-[#0e8f88]",
                        s.status === "active" ? "text-[#34568a]" : "text-[#8595a8]")}>
                      {s.status === "active" ? "next" : s.status === "paused" ? "resumes on" : "would start"} {fmt(s.next_charge_on)} 📅
                    </button>
                  ))}

                  <div className="ml-auto flex items-center gap-1.5">
                    {(s.status === "draft" || s.status === "paused") && (
                      <button onClick={() => act({ action: s.status === "draft" ? "activate" : "resume", id: s.id }, `on:${s.id}`)}
                        disabled={busy === `on:${s.id}`}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]">
                        <Play size={10} /> {s.status === "draft" ? "Activate" : "Resume"}
                      </button>
                    )}
                    {s.status === "active" && (
                      <button onClick={() => act({ action: "pause", id: s.id }, `off:${s.id}`)} disabled={busy === `off:${s.id}`}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border bg-[#fff7ec] text-[#b45309] border-[#fcd9a8]">
                        <Pause size={10} /> Pause
                      </button>
                    )}
                    {s.status === "active" && (
                      <button onClick={() => chargeNow(s)} disabled={busy === `charge:${s.id}`}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border bg-white text-[#0e8f88] border-[#a7e3df]">
                        {busy === `charge:${s.id}` ? <Loader2 size={10} className="animate-spin" /> : null} Charge now
                      </button>
                    )}
                    {s.status === "draft" && (
                      <button onClick={() => act({ action: "delete", id: s.id }, `del:${s.id}`)} disabled={busy === `del:${s.id}`}
                        title="Delete this draft" className="px-1.5 py-1 rounded-lg text-[#b6c2d0] hover:text-[#e11d48]">
                        <Trash2 size={11} />
                      </button>
                    )}
                    <button onClick={() => setOpenId(open ? null : s.id)} className="text-[11px] text-[#8595a8] px-1">
                      {hist.length > 0 ? `${hist.length} charge${hist.length === 1 ? "" : "s"}` : "history"} {open ? "▲" : "▼"}
                    </button>
                  </div>
                </div>

                {(s.note || last) && !open && (
                  <div className="px-2.5 pb-1.5 text-[10px] text-[#8595a8]">
                    {s.note}{s.note && last ? " · " : ""}
                    {last && (last.status === "succeeded"
                      ? `last charged ${fmt(last.charged_at)}`
                      : `last attempt failed ${fmt(last.charged_at)} — ${last.error ?? ""}`)}
                  </div>
                )}

                {open && (
                  <div className="border-t border-[#eef3f8] px-2.5 py-1.5 space-y-1">
                    <div className="text-[10px] text-[#8595a8]">
                      Created by {s.created_by?.split("@")[0] ?? "—"}
                      {s.activated_by ? ` · activated by ${s.activated_by.split("@")[0]}` : ""}
                      {s.note ? ` · ${s.note}` : ""}
                    </div>
                    {hist.length === 0 ? (
                      <p className="text-[11px] text-[#8595a8]">Never charged.</p>
                    ) : hist.map((c) => (
                      <div key={c.id} className="flex items-center gap-2 flex-wrap text-[11px]">
                        <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold border",
                          c.status === "succeeded" ? "bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]" : "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]")}>
                          {c.status === "succeeded" ? "paid" : "failed"}
                        </span>
                        <span className="font-semibold text-[#1f3559] tabular-nums">{money(c.amount_cents)}</span>
                        <span className="text-[#697a91]">{fmt(c.charged_at)}</span>
                        {c.period_key && <span className="text-[#8595a8]">for {c.period_key}</span>}
                        <span className="text-[#8595a8]">by {c.charged_by === "cron" ? "schedule" : c.charged_by?.split("@")[0] ?? "—"}</span>
                        {c.error && <span className="text-[#be123c] basis-full">{c.error}</span>}
                        {c.receipt_url && (
                          <a href={c.receipt_url} target="_blank" rel="noopener noreferrer"
                            className="ml-auto flex items-center gap-1 font-semibold text-[#0e8f88] hover:underline">
                            Receipt <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
