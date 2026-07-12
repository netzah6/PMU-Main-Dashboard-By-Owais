"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search, ChevronDown, ChevronRight, Check, DollarSign, CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types (mirror /api/ppa/*) ────────────────────────────────────────────────
interface ClientRow {
  ownerKey: string; ownerName: string; business: string; status: string; version: string;
  isPpa: boolean; fee: number; note: string | null;
  deposits: number; depositTotal: number;
  served: number; pastDue: number; upcoming: number; noshow: number; noAppt: number;
  readyToCharge: number; chargedCount: number; chargedAmount: number; readyOwed: number;
}
interface Appt {
  apptId: string; contactName: string | null; email: string | null; depositDate: string | null;
  amount: string | null; status: string | null; notes: string | null; source: string | null;
  currentStage: string | null; appointmentDate: string | null; appointmentStatus: string | null;
  chargeStatus: string; charged: boolean; chargedAmount: number | null; chargedAt: string | null;
  chargedBy: string | null; chargeNote: string | null;
}
interface Drill {
  client: { ownerKey: string; ownerName: string; business: string; isPpa: boolean; fee: number; note: string | null };
  summary: { deposits: number; served: number; pastDue: number; upcoming: number; noshow: number; noAppt: number; readyToCharge: number };
  appointments: Appt[];
}

const CS: Record<string, { label: string; cls: string }> = {
  served:   { label: "Served",       cls: "bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]" },
  past_due: { label: "Past due",     cls: "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]" },
  upcoming: { label: "Upcoming",     cls: "bg-[#eef4ff] text-[#3b6fd4] border-[#c9dbfb]" },
  noshow:   { label: "No-show",      cls: "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]" },
  no_appt:  { label: "No appt",      cls: "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]" },
};
const isReady = (a: Appt) => !a.charged && (a.chargeStatus === "served" || a.chargeStatus === "past_due");

function money(n: number): string {
  return "$" + (n || 0).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0 });
}
function fmtDate(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ── Appointment tracker (drill-down) ─────────────────────────────────────────
function AppointmentList({ client, onCharged }: { client: ClientRow; onCharged: () => void }) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/ppa/client?owner_key=${encodeURIComponent(client.ownerKey)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setDrill(json as Drill);
    } catch (e) { setError(`${e}`.replace("Error: ", "")); }
    finally { setLoading(false); }
  }, [client.ownerKey]);
  useEffect(() => { load(); }, [load]);

  const toggleCharge = async (a: Appt, charged: boolean) => {
    if (!drill) return;
    setBusy((b) => new Set(b).add(a.apptId));
    setDrill({ ...drill, appointments: drill.appointments.map((x) => x.apptId === a.apptId ? { ...x, charged, chargedAmount: charged ? client.fee : null } : x) });
    try {
      const res = await fetch("/api/ppa/charge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appt_id: a.apptId, owner_key: client.ownerKey, charged, amount: charged ? client.fee : null }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "save failed");
      onCharged();
    } catch (e) {
      setError(`${e}`.replace("Error: ", "")); await load();
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(a.apptId); return n; });
    }
  };

  const chargeAllReady = async () => {
    if (!drill) return;
    for (const a of drill.appointments.filter(isReady)) await toggleCharge(a, true);
  };

  if (loading) return <div className="flex items-center gap-2 text-xs text-[#697a91] py-6 justify-center"><Loader2 size={13} className="animate-spin" /> Loading appointments…</div>;
  if (error) return <div className="text-xs text-[#e11d48] py-4 text-center">{error}</div>;
  if (!drill) return null;

  const s = drill.summary;
  const readyCount = drill.appointments.filter(isReady).length;

  return (
    <div className="space-y-3 pt-1">
      {/* Deposit-linked snapshot */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-[#8595a8]">These deposits:</span>
        <Pill label="Served" value={s.served} tone="green" />
        <Pill label="Past due" value={s.pastDue} tone={s.pastDue > 0 ? "amber" : "gray"} />
        <Pill label="Upcoming" value={s.upcoming} tone="gray" />
        {s.noshow > 0 && <Pill label="No-show" value={s.noshow} tone="gray" />}
        {s.noAppt > 0 && <Pill label="No appt booked" value={s.noAppt} tone="gray" />}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-[#697a91]">{drill.appointments.length} deposit{drill.appointments.length === 1 ? "" : "s"} · <strong className="text-[#0e8f88]">{readyCount} ready to charge</strong></span>
        {readyCount > 0 && (
          <button onClick={chargeAllReady}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-[#e6f7f5] hover:bg-[#d6f0ed] text-[#0e8f88] border border-[#a7e3df]">
            <Check size={11} /> Charge all ready ({money(readyCount * client.fee)})
          </button>
        )}
      </div>

      {drill.appointments.length === 0 ? (
        <div className="text-xs text-[#8595a8] py-4 text-center border border-dashed border-[#e4ebf2] rounded-lg">
          No deposits found for this client{client.business ? ` (matched by business name "${client.business}")` : ""}.
        </div>
      ) : (
        <div className="rounded-lg border border-[#e4ebf2] overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#e4ebf2] bg-[#f8fafc]">
                {["Contact", "Deposit", "Appt date", "Stage", "Status", "Charged?"].map((h) => (
                  <th key={h} className="px-2.5 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-[#697a91] whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {drill.appointments.map((a, i) => {
                const ready = isReady(a);
                const cs = CS[a.chargeStatus] ?? CS.no_appt;
                return (
                  <tr key={a.apptId} className={cn("border-b border-[#eef3f8]", a.charged ? "bg-[#f2fbf9]" : ready ? "bg-[#fffdf5]" : i % 2 ? "bg-[#fafcfe]" : "bg-white")}>
                    <td className="px-2.5 py-1.5">
                      <div className="font-medium text-[#1f3559]">{a.contactName || "—"}</div>
                      {a.email && <div className="text-[10px] text-[#8595a8]">{a.email}</div>}
                    </td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap">
                      <span className="text-[#0e8f88] font-semibold">{a.amount ? (a.amount.startsWith("$") ? a.amount : "$" + a.amount) : "—"}</span>
                      <div className="text-[10px] text-[#a6b3c4]">{fmtDate(a.depositDate)}</div>
                    </td>
                    <td className="px-2.5 py-1.5 text-[#697a91] whitespace-nowrap">{fmtDate(a.appointmentDate)}</td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap">
                      {a.currentStage ? <span className="text-[#697a91]">{a.currentStage}</span> : <span className="text-[10px] text-[#b9c3d0]">no lead match</span>}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap", cs.cls)}>{cs.label}</span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <button onClick={() => toggleCharge(a, !a.charged)} disabled={busy.has(a.apptId)}
                        className={cn("flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold border transition-colors",
                          a.charged ? "bg-[#e6f7ee] text-[#15803d] border-[#86efac]"
                            : ready ? "bg-white text-[#0e8f88] border-[#a7e3df] hover:bg-[#e6f7f5]"
                            : "bg-white text-[#697a91] border-[#e4ebf2] hover:border-[#15B7AE] hover:text-[#0e8f88]")}>
                        {busy.has(a.apptId) ? <Loader2 size={11} className="animate-spin" /> : a.charged ? <Check size={11} /> : <DollarSign size={11} />}
                        {a.charged ? `Charged ${a.chargedAmount != null ? money(a.chargedAmount) : ""}` : "Mark charged"}
                      </button>
                      {a.charged && a.chargedBy && <div className="text-[9px] text-[#a6b3c4] mt-0.5">by {a.chargedBy}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Pill({ label, value, tone }: { label: string; value: number | string; tone: "green" | "amber" | "gray" }) {
  const c = tone === "green" ? "bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]"
    : tone === "amber" ? "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]"
    : "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]";
  return <span className={cn("px-1.5 py-0.5 rounded border font-semibold", c)}>{label}: {value}</span>;
}

// ── Client card ──────────────────────────────────────────────────────────────
function ClientCard({ c, onChange, defaultOpen }: { c: ClientRow; onChange: () => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [fee, setFee] = useState(String(c.fee));
  const [savingCfg, setSavingCfg] = useState(false);
  useEffect(() => { setFee(String(c.fee)); }, [c.fee]);

  const saveConfig = async (patch: { is_ppa?: boolean; fee?: number }) => {
    setSavingCfg(true);
    try {
      await fetch("/api/ppa/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner_key: c.ownerKey, ...patch }) });
      onChange();
    } finally { setSavingCfg(false); }
  };

  return (
    <div className={cn("rounded-xl border bg-white", c.readyToCharge > 0 && c.isPpa ? "border-[#fcd9a8]" : c.isPpa ? "border-[#a7e3df]" : "border-[#e4ebf2]")}>
      <div className="flex items-center gap-3 p-3 flex-wrap">
        <button onClick={() => setOpen((o) => !o)} className="text-[#8595a8] hover:text-[#0e8f88] shrink-0">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="min-w-[160px] flex-1">
          <div className="font-bold text-[#1f3559] leading-tight">{c.ownerName}</div>
          <div className="text-[11px] text-[#8595a8] truncate">{c.business || "—"}
            {c.status === "paused" && <span className="ml-1.5 px-1 py-0.5 rounded text-[9px] font-bold bg-[#fff7ec] text-[#d97706]">PAUSED</span>}
          </div>
        </div>

        <label className="flex items-center gap-1.5 cursor-pointer select-none shrink-0">
          <input type="checkbox" checked={c.isPpa} disabled={savingCfg} onChange={(e) => saveConfig({ is_ppa: e.target.checked })} className="w-4 h-4 accent-[#15B7AE]" />
          <span className={cn("text-[11px] font-semibold", c.isPpa ? "text-[#0e8f88]" : "text-[#8595a8]")}>Pay-per-appt</span>
        </label>

        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[11px] text-[#8595a8]">Fee</span>
          <div className="relative">
            <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[11px] text-[#8595a8]">$</span>
            <input value={fee} onChange={(e) => setFee(e.target.value.replace(/[^0-9.]/g, ""))}
              onBlur={() => { const n = Number(fee); if (!isNaN(n) && n !== c.fee) saveConfig({ fee: n }); }}
              className="w-16 pl-4 pr-1 py-1 text-xs text-right rounded-lg border border-[#e4ebf2] focus:outline-none focus:border-[#15B7AE]" />
          </div>
        </div>

        <div className="flex items-center gap-3 text-center shrink-0">
          <Metric label="Deposits" value={c.deposits} sub="potential" />
          <Metric label="Served" value={c.served} tone={c.served > 0 ? "green" : "gray"} />
          <Metric label="Upcoming" value={c.upcoming} sub="future" tone="gray" />
          <Metric label="Ready" value={c.readyToCharge} sub={c.isPpa ? money(c.readyOwed) : ""} tone={c.readyToCharge > 0 ? "amber" : "gray"} />
          <Metric label="Charged" value={c.chargedCount} sub={money(c.chargedAmount)} tone="teal" />
        </div>
      </div>

      {open && <div className="px-3 pb-3 border-t border-[#eef3f8]"><AppointmentList client={c} onCharged={onChange} /></div>}
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "green" | "amber" | "teal" | "gray" }) {
  const color = tone === "green" ? "text-[#15803d]" : tone === "amber" ? "text-[#d97706]" : tone === "teal" ? "text-[#0e8f88]" : "text-[#1f3559]";
  return (
    <div className="min-w-[52px]">
      <div className={cn("text-base font-bold leading-none", color)}>{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-[#a6b3c4] font-semibold mt-0.5">{label}</div>
      {sub && <div className="text-[9px] text-[#8595a8]">{sub}</div>}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
type Filter = "all" | "ppa" | "ready" | "unset";
export default function V3BillingPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/ppa/overview${refresh ? "?refresh=1" : ""}`);
      const text = await res.text();
      let json: { clients?: ClientRow[]; error?: string } = {};
      try { json = JSON.parse(text); } catch { throw new Error(res.ok ? "Unexpected response" : `Server error (${res.status})`); }
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setClients(json.clients ?? []);
    } catch (e) { setError(`${e}`.replace("Error: ", "")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    const t = { v3: clients.length, ppa: 0, ready: 0, readyUsd: 0, chargedUsd: 0 };
    for (const c of clients) {
      if (c.isPpa) { t.ppa++; t.ready += c.readyToCharge; t.readyUsd += c.readyOwed; }
      t.chargedUsd += c.chargedAmount;
    }
    return t;
  }, [clients]);

  // The Monday worklist — pay-per-appt clients with appointments ready to charge.
  const worklist = useMemo(() =>
    clients.filter((c) => c.isPpa && c.readyToCharge > 0).sort((a, b) => b.readyOwed - a.readyOwed),
  [clients]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return clients.filter((c) => {
      if (filter === "ppa" && !c.isPpa) return false;
      if (filter === "ready" && !(c.isPpa && c.readyToCharge > 0)) return false;
      if (filter === "unset" && c.isPpa) return false;
      if (q && !`${c.ownerName} ${c.business}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [clients, search, filter]);

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1f3559]">V3 Billing</h1>
          <p className="text-sm text-[#697a91]">Pay-per-appointment tracking · who to charge, and how much</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#eef2f7] text-[#34568a] border border-[#e4ebf2]">{totals.v3} V3</span>
          <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#e6f7f5] text-[#0e8f88] border border-[#a7e3df]">{totals.ppa} pay-per-appt</span>
          {totals.chargedUsd > 0 && <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#e6f7ee] text-[#15803d] border border-[#86efac]">{money(totals.chargedUsd)} charged</span>}
          <button onClick={() => load(true)} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* Monday worklist — who to charge this week */}
      <div className="rounded-xl border border-[#fcd9a8] bg-[#fffdf7] p-3">
        <div className="flex items-center gap-2 mb-2">
          <CalendarClock size={15} className="text-[#d97706]" />
          <h2 className="text-sm font-bold text-[#1f3559]">To charge</h2>
          {totals.ready > 0
            ? <span className="text-xs font-semibold text-[#d97706]">{totals.ready} appointment{totals.ready === 1 ? "" : "s"} · {money(totals.readyUsd)} across {worklist.length} client{worklist.length === 1 ? "" : "s"}</span>
            : <span className="text-xs text-[#15803d] font-semibold">All caught up 🎉</span>}
        </div>
        {worklist.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {worklist.map((c) => (
              <button key={c.ownerKey} onClick={() => { setFilter("ready"); setSearch(c.ownerName); }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-white border border-[#fcd9a8] hover:border-[#d97706]">
                <span className="font-semibold text-[#1f3559]">{c.ownerName}</span>
                <span className="text-[#d97706] font-bold">{c.readyToCharge}</span>
                <span className="text-[#8595a8]">· {money(c.readyOwed)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client or business…"
            className="w-full pl-8 pr-3 py-2 bg-[#eef2f7] border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}
          className="px-3 py-2 text-sm rounded-lg border border-[#e4ebf2] bg-white text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
          <option value="all">All V3 clients</option>
          <option value="ready">Ready to charge</option>
          <option value="ppa">Pay-per-appt only</option>
          <option value="unset">Not pay-per-appt</option>
        </select>
      </div>

      {error ? (
        <div className="px-4 py-6 rounded-xl border border-[#e4ebf2] bg-white text-center text-sm text-[#e11d48]">{error}</div>
      ) : loading && clients.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-12 justify-center"><Loader2 size={15} className="animate-spin" /> Loading V3 clients, stages &amp; appointments…</div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-[#8595a8]">No clients match.</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => <ClientCard key={c.ownerKey} c={c} onChange={() => load()} defaultOpen={filter === "ready"} />)}
        </div>
      )}
    </div>
  );
}
