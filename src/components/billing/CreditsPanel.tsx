"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Check, Ban, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type Credit = {
  id: string;
  owner_key: string;
  client_label: string | null;
  amount: number;
  reason: string;
  status: "pending" | "approved" | "denied";
  applied: number;
  requested_by: string | null;
  requested_at: string;
  decided_by: string | null;
};

const money = (n: number) => `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/**
 * Account credit for PPS clients. A Client Success Coach asks for one and says
 * why; an admin approves it here. Approved credit comes off the client's next
 * service-fee charge automatically, so nothing has to be remembered on the day.
 */
export function CreditsPanel({
  clients, onChanged,
}: {
  clients: Array<{ ownerKey: string; label: string }>;
  onChanged?: () => void;
}) {
  const [credits, setCredits] = useState<Credit[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [ownerKey, setOwnerKey] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/credits");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load credits");
      setCredits(j.credits ?? []);
      setRole(j.role ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load credits");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const canRequest = role === "admin" || role === "editor";
  const isAdmin = role === "admin";
  const pending = credits.filter((c) => c.status === "pending");
  const active = credits.filter((c) => c.status === "approved" && Number(c.amount) - Number(c.applied) > 0);

  async function submit() {
    if (!ownerKey || !amount.trim() || !reason.trim() || busy) return;
    setBusy("new");
    setError(null);
    try {
      const label = clients.find((c) => c.ownerKey === ownerKey)?.label ?? ownerKey;
      const r = await fetch("/api/credits/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerKey, clientLabel: label, amount, reason }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Request failed");
      setAdding(false); setOwnerKey(""); setAmount(""); setReason("");
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, decision: "approve" | "deny") {
    setBusy(id);
    setError(null);
    try {
      const r = await fetch("/api/credits/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Action failed");
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-xs text-[#697a91] py-2"><Loader2 size={13} className="animate-spin" />Loading credits…</div>;
  }
  if (!canRequest && pending.length === 0 && active.length === 0) return null;

  return (
    <div className="rounded-xl border border-[#cfe3f7] bg-[#f7fbff] p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-bold text-[#1d4ed8]">💳 Account credit</h2>
        {pending.length > 0 && (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#fff7ec] text-[#b45309] border border-[#fcd9a8]">
            {pending.length} waiting for approval
          </span>
        )}
        {active.length > 0 && (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#e6f7ee] text-[#15803d] border border-[#c7edd4]">
            {money(active.reduce((t, c) => t + (Number(c.amount) - Number(c.applied)), 0))} unused
          </span>
        )}
        {canRequest && (
          <button onClick={() => setAdding((a) => !a)}
            className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border border-[#bfdbfe] bg-white text-[#1d4ed8] hover:bg-[#eff6ff]">
            {adding ? <X size={12} /> : <Plus size={12} />} {adding ? "Cancel" : "Give credit"}
          </button>
        )}
      </div>

      {error && <p className="text-[11px] text-[#e11d48]">{error}</p>}

      {adding && (
        <div className="rounded-lg border border-[#e4ebf2] bg-white p-2.5 space-y-2">
          <div className="flex flex-wrap gap-2">
            <select value={ownerKey} onChange={(e) => setOwnerKey(e.target.value)}
              className="flex-1 min-w-[180px] px-2 py-1.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559]">
              <option value="">Choose a client…</option>
              {clients.map((c) => <option key={c.ownerKey} value={c.ownerKey}>{c.label}</option>)}
            </select>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$ amount" inputMode="decimal"
              className="w-[110px] px-2 py-1.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559]" />
          </div>
          <input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this credit owed? (the client sees nothing — this is for the approval)"
            className="w-full px-2 py-1.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559]" />
          <div className="flex items-center gap-2">
            <button onClick={submit} disabled={busy === "new" || !ownerKey || !amount.trim() || !reason.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#15B7AE] text-[#1f3559] disabled:opacity-50">
              {busy === "new" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {isAdmin ? "Add (you approve below)" : "Send for approval"}
            </button>
            <span className="text-[11px] text-[#697a91]">
              {isAdmin ? "Admins still approve it in the list below before it comes off a charge."
                       : "Nicolas reviews it before it comes off a charge."}
            </span>
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <div className="space-y-1.5">
          {pending.map((c) => (
            <div key={c.id} className="flex items-center gap-3 flex-wrap rounded-lg border border-[#f0e4cf] bg-white px-3 py-2">
              <div className="min-w-[180px] flex-1">
                <div className="text-sm font-semibold text-[#1f3559]">
                  {c.client_label || c.owner_key} · <span className="text-[#1d4ed8]">{money(c.amount)}</span>
                </div>
                <div className="text-[11px] text-[#697a91]">
                  requested by {c.requested_by?.split("@")[0] ?? "—"} · “{c.reason}”
                </div>
              </div>
              {isAdmin ? (
                <>
                  <button disabled={busy === c.id} onClick={() => decide(c.id, "approve")}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#e6f7ee] hover:bg-[#d5f0e0] text-[#15803d] border border-[#86efac] disabled:opacity-50">
                    {busy === c.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Approve
                  </button>
                  <button disabled={busy === c.id} onClick={() => decide(c.id, "deny")}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-white hover:bg-[#fde8ee] text-[#e11d48] border border-[#f5c2cf] disabled:opacity-50">
                    <Ban size={12} /> Deny
                  </button>
                </>
              ) : (
                <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-[#fff7ec] text-[#b45309] border border-[#fcd9a8]">Waiting for approval</span>
              )}
            </div>
          ))}
        </div>
      )}

      {active.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {active.map((c) => (
            <span key={c.id} title={`${c.reason} — approved by ${c.decided_by?.split("@")[0] ?? "—"}`}
              className={cn("px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]")}>
              {c.client_label || c.owner_key}: {money(Number(c.amount) - Number(c.applied))} left
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
