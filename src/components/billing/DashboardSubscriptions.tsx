"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Loader2, Plus, X, Play, Pause, Check, Trash2, ExternalLink, AlertTriangle, CreditCard, Search } from "lucide-react";
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
  square_customer_id: string | null; square_card_id: string | null; square_card_label: string | null;
  retry_attempt?: number | null; pause_reason?: string | null;
};
/* A card belongs to a Square customer, and one business can have two of them:
   Bombshell Beauty is Erin Heidecke and Ayesha Ali, partners who each pay from
   their own card (owner, 2026-09-26). So a card carries its customer and the
   person it belongs to, and the subscription is pointed at that pair. */
type CardOpt = {
  id: string; customerId: string; person: string | null; personEmail: string | null;
  brand: string; last4: string; exp: string | null; holder: string | null; enabled: boolean;
};
type Payer = { customerId: string; name: string; email: string | null };
/* A Square customer as the manual search returns it — any contact in the
   account, not just ones already matched to this client. */
type SquareContact = { id: string; name: string; email: string | null; phone: string | null; company: string | null };
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
  // Card picker: which subscription is open, the people paying for that client
  // and the cards Square returned for each, and which card would be used if
  // nothing is chosen. `mustChoose` = two payers, so there is no default.
  const [cardPick, setCardPick] = useState<{ id: string; loading: boolean; error?: string; people: Payer[]; cards: CardOpt[]; defaultCardId: string | null; pinnedInPps: boolean; lastUsed?: boolean; mustChoose?: boolean; foundBySearch?: boolean } | null>(null);
  // last4 by card id, so a row can show "••4242" without a lookup each render
  const [cardLabels, setCardLabels] = useState<Record<string, string>>({});
  /* Find ANY Square contact by hand. Automatic discovery matches on the sheet's
     email, phone, business and the names in the Owner Full Name cell — which
     cannot reach a payer the sheet never names (a partner, a spouse, a manager,
     a record opened under a nickname). This box makes the picker work for every
     client, not only the ones whose partners are written down (owner,
     2026-09-26). Once attached, the customer is remembered for next time. */
  const [custQ, setCustQ] = useState("");
  const [custHits, setCustHits] = useState<SquareContact[]>([]);
  const [custBusy, setCustBusy] = useState(false);
  const [custNote, setCustNote] = useState<string | null>(null);

  const searchContacts = async () => {
    const q = custQ.trim();
    if (q.length < 3) { setCustNote("Type at least 3 characters."); return; }
    setCustBusy(true); setCustNote(null); setCustHits([]);
    try {
      const r = await fetch(`/api/ppa/customer-search?q=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Search failed");
      const hits = (j.customers ?? []) as SquareContact[];
      setCustHits(hits);
      if (!hits.length) setCustNote(`Nothing in Square matches "${q}".`);
    } catch (e) {
      setCustNote(e instanceof Error ? e.message : "Search failed");
    } finally { setCustBusy(false); }
  };

  /* Load one hand-picked contact's cards into the open picker. */
  const attachContact = async (subId: string, c: SquareContact) => {
    setCustBusy(true); setCustNote(null);
    try {
      const r = await fetch(`/api/subscriptions/cards?customerId=${encodeURIComponent(c.id)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load that contact's cards");
      const people = (j.people ?? []) as Payer[];
      setCardPick({
        id: subId, loading: false, people, cards: j.cards, defaultCardId: null,
        pinnedInPps: false, lastUsed: false, mustChoose: true, foundBySearch: true,
      });
      const labels: Record<string, string> = {};
      for (const k of j.cards as CardOpt[]) {
        labels[k.id] = `${k.person ? `${k.person.split(" ")[0]} · ` : ""}${k.brand} ••${k.last4}`;
      }
      setCardLabels((m) => ({ ...m, ...labels }));
      setCustHits([]); setCustQ("");
    } catch (e) {
      setCustNote(e instanceof Error ? e.message : "Could not load that contact's cards");
    } finally { setCustBusy(false); }
  };

  const openCardPicker = async (s: Sub) => {
    setCardPick({ id: s.id, loading: true, people: [], cards: [], defaultCardId: null, pinnedInPps: false });
    try {
      const r = await fetch(`/api/subscriptions/cards?ownerKey=${encodeURIComponent(s.owner_key)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load cards");
      const people = (j.people ?? []) as Payer[];
      setCardPick({ id: s.id, loading: false, people, cards: j.cards, defaultCardId: j.defaultCardId, pinnedInPps: !!j.pinnedInPps, lastUsed: !!j.lastUsed, mustChoose: !!j.mustChoose });
      const labels: Record<string, string> = {};
      // With two partners on one business the badge has to say WHOSE card it
      // is — "VISA ••1234" alone would not tell the admin who gets charged.
      for (const c of j.cards as CardOpt[]) {
        const who = people.length > 1 && c.person ? `${c.person.split(" ")[0]} · ` : "";
        labels[c.id] = `${who}${c.brand} ••${c.last4}`;
      }
      setCardLabels((m) => ({ ...m, ...labels }));
    } catch (e) {
      setCardPick({ id: s.id, loading: false, error: e instanceof Error ? e.message : "Could not load cards", people: [], cards: [], defaultCardId: null, pinnedInPps: false });
    }
  };
  const chooseCard = async (s: Sub, customerId: string | null, cardId: string | null) => {
    const cardLabel = cardId ? (cardLabels[cardId] ?? "") : "";
    // Tagged per card, so only the button that was clicked spins.
    const ok = await act({ action: "set_card", id: s.id, customerId: customerId ?? "", cardId: cardId ?? "", cardLabel }, `card:${s.id}:${cardId ?? "default"}`);
    if (ok) {
      setCardPick(null);
      setMsg(cardId
        ? `${s.client_label || s.owner_key}: will charge ${cardLabels[cardId] ?? "the chosen card"}.`
        : `${s.client_label || s.owner_key}: back to the default card.`);
    }
  };

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
        {!autocharge && (
          <span className="text-[11px] text-[#697a91]">
            Nothing is charged automatically. Active subscriptions still show what is due, and “Charge now” still works.
          </span>
        )}
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
          {/* Same calendar reading as the Square list below: a divider each
              time the next-charge month changes, this month first. */}
          {[...subs].sort((a, b) => (a.status === "ended") === (b.status === "ended") ? a.next_charge_on.localeCompare(b.next_charge_on) : a.status === "ended" ? 1 : -1).map((s, i, arr) => {
            const hist = byId.get(s.id) ?? [];
            const monthOf = (x: Sub) => x.status === "ended" ? "ended" : x.next_charge_on.slice(0, 7);
            const showDivider = i === 0 || monthOf(arr[i - 1]) !== monthOf(s);
            const monthLabel = monthOf(s) === "ended" ? "Ended" : new Date(`${monthOf(s)}-15T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
            const last = hist[0];
            const open = openId === s.id;
            return (
              <li key={s.id} className={cn(showDivider && i > 0 && "pt-2")}>
                {showDivider && (
                  <div className="flex items-center gap-2 px-1 pb-1">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-[#34568a]">{monthLabel}</span>
                    <span className="flex-1 h-px bg-[#d7e0ea]" />
                  </div>
                )}
                <div className="rounded-lg border border-[#e4ebf2] bg-white">
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
                  {/* A failed charge schedules itself again (+1d, +3d, +4d); say so. */}
                  {s.status === "active" && (s.retry_attempt ?? 0) > 0 && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#fff7ec] text-[#b45309] border border-[#fcd9a8]"
                      title="The last charge failed — this is the automatic retry (1 day, then 3, then 4). A 4th failure pauses the subscription.">
                      ↻ retry {s.retry_attempt} of 3
                    </span>
                  )}
                  {s.status === "paused" && s.pause_reason && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#fde8ee] text-[#be123c] border border-[#f5c2cf]" title={s.pause_reason}>
                      ⚠ card failed 4× — needs attention
                    </span>
                  )}

                  {s.status !== "ended" && (
                    <button onClick={() => openCardPicker(s)}
                      title={s.square_card_id
                        ? "This subscription charges a specific card — click to change"
                        : "No card chosen — the charge uses the PPS-pinned card or the first card on file, and fails when two people pay for the business. Click to choose."}
                      className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border",
                        s.square_card_id ? "bg-[#eef4ff] text-[#1d4ed8] border-[#c9dbfb]" : "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]")}>
                      <CreditCard size={10} />
                      {s.square_card_id ? (s.square_card_label ?? cardLabels[s.square_card_id] ?? "chosen card") : "default card"}
                    </button>
                  )}

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

                {cardPick?.id === s.id && (
                  <div className="border-t border-[#eef3f8] bg-[#f7fbff] px-2.5 py-2 space-y-1.5">
                    {cardPick.loading ? (
                      <div className="flex items-center gap-2 text-[11px] text-[#697a91]"><Loader2 size={12} className="animate-spin" /> Looking up cards on file in Square…</div>
                    ) : cardPick.error ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2 flex-wrap text-[11px] text-[#be123c]">
                          {cardPick.error}
                          <button onClick={() => setCardPick(null)} className="ml-auto text-[#8595a8]">close</button>
                        </div>
                        {/* Find any Square contact by hand — the general escape hatch when
                            automatic matching cannot reach a payer (owner, 2026-09-26). */}
                        <div className="border-t border-[#e4ebf2] pt-1.5 mt-1.5 space-y-1">
                          <div className="flex items-center gap-1.5">
                            <Search size={11} className="text-[#697a91] shrink-0" />
                            <input
                              value={custQ}
                              onChange={(e) => setCustQ(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void searchContacts(); } }}
                              placeholder="Find another Square contact — name, email, phone or business…"
                              className="flex-1 min-w-0 px-2 py-1 rounded-md border border-[#d7e0ea] text-[11px] text-[#1f3559] placeholder:text-[#a6b3c4] focus:outline-none focus:border-[#15B7AE]" />
                            <button onClick={() => void searchContacts()} disabled={custBusy}
                              className="flex items-center gap-1 px-2 py-1 rounded-md border border-[#d7e0ea] text-[11px] font-semibold text-[#34568a] hover:border-[#15B7AE] disabled:opacity-50">
                              {custBusy ? <Loader2 size={10} className="animate-spin" /> : null} Search
                            </button>
                          </div>
                          {custNote && <p className="text-[10.5px] text-[#b45309]">{custNote}</p>}
                          {custHits.length > 0 && (
                            <div className="space-y-1">
                              {custHits.map((c) => (
                                <button key={c.id} onClick={() => void attachContact(s.id, c)} disabled={custBusy}
                                  className="w-full flex items-center gap-2 px-2 py-1 rounded-md border border-[#e4ebf2] bg-white text-left hover:border-[#15B7AE] disabled:opacity-50">
                                  <span className="text-[11px] font-semibold text-[#1f3559] truncate">{c.name || "(no name)"}</span>
                                  <span className="text-[10px] text-[#8595a8] truncate">{c.email ?? c.company ?? c.phone ?? ""}</span>
                                  <span className="ml-auto text-[10px] font-bold text-[#0e8f88] shrink-0">use →</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="text-[11px] font-semibold text-[#1f3559]">
                          Which card should this subscription charge?
                          {/* Two payers on one business is normal for a partner studio —
                              say so, and say what "leave it" would do. */}
                          {cardPick.foundBySearch ? (
                            <span className="ml-2 font-normal text-[#0e8f88]">
                              showing a contact you found by hand — pick the card to attach
                            </span>
                          ) : cardPick.mustChoose && (
                            <span className="ml-2 font-normal text-[#b45309]">
                              {cardPick.people.length} people pay for this business — pick whose card this one charges
                            </span>
                          )}
                          {cardPick.pinnedInPps
                            ? <span className="ml-2 font-normal text-[#697a91]">(the default is the card pinned on PPS Billing)</span>
                            : cardPick.lastUsed
                              ? <span className="ml-2 font-normal text-[#697a91]">(the default is the card she last paid with)</span>
                              : !cardPick.defaultCardId
                                ? <span className="ml-2 font-normal text-[#697a91]">(there is no default — a charge with no card chosen will fail)</span>
                                : null}
                        </div>
                        {cardPick.cards.length === 0 ? (
                          <p className="text-[11px] text-[#be123c]">This client has no cards on file in Square.</p>
                        ) : (
                          /* One group per Square customer. Partners keep their own
                             heading so "MASTERCARD ••6282" is never ambiguous. */
                          <div className="space-y-1.5">
                            {cardPick.people.map((p) => (
                              <div key={p.customerId} className="space-y-1">
                                {cardPick.people.length > 1 && (
                                  <div className="text-[10px] font-bold uppercase tracking-wide text-[#34568a]">
                                    {p.name}
                                    {p.email && <span className="ml-1.5 font-normal normal-case tracking-normal text-[#8595a8]">{p.email}</span>}
                                  </div>
                                )}
                                <div className="flex flex-wrap gap-1.5">
                                  {cardPick.cards.filter((c) => c.customerId === p.customerId).map((c) => {
                                    const chosen = s.square_card_id === c.id;
                                    const isDefault = !s.square_card_id && c.id === cardPick.defaultCardId;
                                    return (
                                      <button key={c.id} disabled={!c.enabled || !!busy?.startsWith(`card:${s.id}`)}
                                        /* The card's OWN customer — charging Erin's card
                                           against Ayesha's Square record would fail. */
                                        onClick={() => chooseCard(s, c.customerId, c.id)}
                                        title={!c.enabled ? "Disabled in Square — cannot be charged" : c.holder ?? undefined}
                                        className={cn("flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] text-left",
                                          chosen ? "bg-[#eef4ff] border-[#1d4ed8] text-[#1d4ed8] font-semibold"
                                            : c.enabled ? "bg-white border-[#d7e0ea] text-[#1f3559] hover:border-[#15B7AE]"
                                              : "bg-[#f6f7f9] border-[#e2e8f0] text-[#94a3b8] line-through")}>
                                        {busy === `card:${s.id}:${c.id}` ? <Loader2 size={12} className="animate-spin" /> : <CreditCard size={12} />}
                                        <span>{c.brand} ••{c.last4}{c.exp ? ` · exp ${c.exp}` : ""}</span>
                                        {chosen && <span className="text-[9px] font-bold uppercase">chosen</span>}
                                        {isDefault && <span className="text-[9px] font-bold uppercase text-[#0e8f88]">default</span>}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {/* Find any Square contact by hand — the general escape hatch when
                            automatic matching cannot reach a payer (owner, 2026-09-26). */}
                        <div className="border-t border-[#e4ebf2] pt-1.5 mt-1.5 space-y-1">
                          <div className="flex items-center gap-1.5">
                            <Search size={11} className="text-[#697a91] shrink-0" />
                            <input
                              value={custQ}
                              onChange={(e) => setCustQ(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void searchContacts(); } }}
                              placeholder="Find another Square contact — name, email, phone or business…"
                              className="flex-1 min-w-0 px-2 py-1 rounded-md border border-[#d7e0ea] text-[11px] text-[#1f3559] placeholder:text-[#a6b3c4] focus:outline-none focus:border-[#15B7AE]" />
                            <button onClick={() => void searchContacts()} disabled={custBusy}
                              className="flex items-center gap-1 px-2 py-1 rounded-md border border-[#d7e0ea] text-[11px] font-semibold text-[#34568a] hover:border-[#15B7AE] disabled:opacity-50">
                              {custBusy ? <Loader2 size={10} className="animate-spin" /> : null} Search
                            </button>
                          </div>
                          {custNote && <p className="text-[10.5px] text-[#b45309]">{custNote}</p>}
                          {custHits.length > 0 && (
                            <div className="space-y-1">
                              {custHits.map((c) => (
                                <button key={c.id} onClick={() => void attachContact(s.id, c)} disabled={custBusy}
                                  className="w-full flex items-center gap-2 px-2 py-1 rounded-md border border-[#e4ebf2] bg-white text-left hover:border-[#15B7AE] disabled:opacity-50">
                                  <span className="text-[11px] font-semibold text-[#1f3559] truncate">{c.name || "(no name)"}</span>
                                  <span className="text-[10px] text-[#8595a8] truncate">{c.email ?? c.company ?? c.phone ?? ""}</span>
                                  <span className="ml-auto text-[10px] font-bold text-[#0e8f88] shrink-0">use →</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-2 text-[11px]">
                          {/* Clearing the choice is only an option when there IS a
                              default — with two payers it would leave the charge
                              with nothing to fall back on. */}
                          {s.square_card_id && !cardPick.mustChoose && (
                            <button onClick={() => chooseCard(s, null, null)} disabled={!!busy?.startsWith(`card:${s.id}`)}
                              className="flex items-center gap-1 text-[#34568a] underline decoration-dotted disabled:opacity-50">
                              {busy === `card:${s.id}:default` && <Loader2 size={10} className="animate-spin" />}
                              Use the default card instead
                            </button>
                          )}
                          <button onClick={() => setCardPick(null)} className="ml-auto text-[#8595a8]">close</button>
                        </div>
                      </>
                    )}
                  </div>
                )}

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
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
