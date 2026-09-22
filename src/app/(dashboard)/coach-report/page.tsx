"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { Loader2, RefreshCw, Send } from "lucide-react";
import { cn } from "@/lib/utils";

// Coach Report — the monthly "Managed Accounts Accountability Report",
// submitted here instead of the old GHL form. The coach's real book is
// pre-listed (Clients Master "Assigned"), each client gets one of the three
// statuses from the form, and the submission lands on the admin's Alerts tab
// with mismatches vs the dashboard already computed.

type Reported = "active" | "paused_resuming" | "churned";
type RosterRow = { owner: string; biz: string; status: string };
type Referral = { referred_name: string; referred_by: string; note: string };
type Submission = { id: number; coach: string; report_month: string; snapshot_date: string | null; entries: { reported: Reported }[]; referrals?: Referral[]; mismatches: string[]; extra: string; created_at: string };
// Each referral the coach brings in is a $100 bonus (owner, 2026-09-22).
const REFERRAL_BONUS = 100;

const CHOICES: { k: Reported; label: string; on: string }[] = [
  { k: "active", label: "Active ✅", on: "bg-[#e7f6ec] text-[#15803d] border-[#15803d]" },
  { k: "paused_resuming", label: "Paused · resumes ≤14d ⏳", on: "bg-[#fff3e6] text-[#c2410c] border-[#c2410c]" },
  { k: "churned", label: "Paused · no date 😡", on: "bg-[#fdeaea] text-[#b91c1c] border-[#b91c1c]" },
];

/* This month first, then the two before it — matches how the old GHL form's
   month dropdown was used (report the month being paid). */
function monthOptions(): { v: string; label: string }[] {
  const out: { v: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    out.push({ v: d.toISOString().slice(0, 7), label: d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) });
  }
  return out;
}

export default function CoachReportPage() {
  const { role, loading: userLoading } = useUser();
  const isAdmin = role === "admin";
  const [coach, setCoach] = useState("");           // admin's picked coach ("" until picked)
  const [coaches, setCoaches] = useState<string[]>([]);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [month, setMonth] = useState(monthOptions()[0].v);
  const [choice, setChoice] = useState<Record<string, Reported>>({});
  const [extra, setExtra] = useState("");
  // Referrals claimed this month — a new PMU artist sent in by a client the
  // coach already manages. One blank row is always present to type into.
  const [referrals, setReferrals] = useState<Referral[]>([{ referred_name: "", referred_by: "", note: "" }]);
  const filledReferrals = referrals.filter((r) => r.referred_name.trim() || r.referred_by.trim());
  const setRef = (i: number, patch: Partial<Referral>) =>
    setReferrals((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const incompleteReferral = filledReferrals.some((r) => !r.referred_name.trim() || !r.referred_by.trim());
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* Reload the roster + history. Leaves the success banner alone — submit()
     shows it right after its own reload, so wiping it here would flash it
     away before the coach reads the mismatch count. */
  const load = useCallback(async (forCoach?: string) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/coach-report${forCoach ? `?coach=${encodeURIComponent(forCoach)}` : ""}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? "Failed to load"); return; }
      setCoach(j.coach ?? "");
      setCoaches(j.coaches ?? []);
      setRoster(j.roster ?? []);
      setSubmissions(j.submissions ?? []);
      setChoice({});
      setConfirm(false);
      setError(null);
    } catch { setError("Network error — try Refresh"); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const key = (r: RosterRow) => `${r.owner}|${r.biz}`;
  const unset = roster.filter((r) => !choice[key(r)]);
  const counts = useMemo(() => ({
    active: roster.filter((r) => choice[key(r)] === "active").length,
    paused_resuming: roster.filter((r) => choice[key(r)] === "paused_resuming").length,
    churned: roster.filter((r) => choice[key(r)] === "churned").length,
  }), [roster, choice]);

  async function submit() {
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await fetch("/api/coach-report", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coach: isAdmin ? coach : undefined, month, extra, confirm,
          entries: roster.map((x) => ({ owner: x.owner, biz: x.biz, reported: choice[key(x)] })),
          referrals: filledReferrals,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? "Submit failed"); return; }
      await load(isAdmin ? coach : undefined);
      setDone(`Report submitted ✓ — Netzah gets it on the Alerts tab${j.mismatchCount ? ` (${j.mismatchCount} thing${j.mismatchCount === 1 ? "" : "s"} flagged for review)` : ""}${j.referrals ? ` · ${j.referrals} referral${j.referrals === 1 ? "" : "s"} claimed = $${j.referralBonus} bonus` : ""}.`);
      setReferrals([{ referred_name: "", referred_by: "", note: "" }]);
    } catch { setError("Network error — the report may not have been sent; try again"); } finally { setBusy(false); }
  }

  if (userLoading) return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin text-[#697a91]" /></div>;

  return (
    <div className="p-3 md:p-6 max-w-[880px] mx-auto">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h1 className="text-base sm:text-lg font-semibold text-[#1c2b3a]">📋 Coach Report</h1>
        <button onClick={() => void load(isAdmin ? coach : undefined)} title="Refresh"
          className="flex items-center gap-1.5 text-sm border border-[#e4ebf2] rounded-lg px-2.5 py-1.5 hover:bg-[#f6f9fc]">
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>
      <p className="text-xs text-[#697a91] mb-3">
        The monthly Managed Accounts Accountability Report. Mark every client in your book, confirm, submit — it lands on the admin&rsquo;s Alerts tab with anything that doesn&rsquo;t match the dashboard already flagged.
      </p>

      {isAdmin && (
        <label className="grid gap-0.5 mb-3 max-w-xs">
          <span className="text-[10px] font-medium text-[#697a91]">Coach (admin view)</span>
          <select value={coach} disabled={loading}
            onChange={(e) => { setCoach(e.target.value); setDone(null); void load(e.target.value); }}
            className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm bg-white disabled:opacity-60">
            <option value="">— pick a coach —</option>
            {coaches.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      )}

      {error && <div className="mb-3 text-sm bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c] rounded-lg px-3 py-2">{error}</div>}
      {done && <div className="mb-3 text-sm bg-[#e7f6ec] border border-[#bfe3cd] text-[#15803d] rounded-lg px-3 py-2">{done}</div>}

      {loading ? (
        <div className="text-sm text-[#697a91]"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading your clients…</div>
      ) : !coach ? (
        <div className="text-sm text-[#697a91] border border-[#e4ebf2] rounded-xl bg-white p-4">
          {isAdmin ? "Pick a coach above to file or review their report. Recent reports from every coach are below." : "No client book matches your login — ask an admin to check that your email matches your name in the Clients sheet."}
        </div>
      ) : (
        <>
          <div className="border border-[#e4ebf2] rounded-xl bg-white p-4">
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <span className="text-sm font-semibold text-[#1c2b3a]">{coach}&rsquo;s clients ({roster.length})</span>
              <label className="flex items-center gap-1.5 text-xs text-[#697a91]">
                Month:
                <select value={month} onChange={(e) => setMonth(e.target.value)} className="border border-[#e4ebf2] rounded-lg px-2 py-1 text-xs bg-white">
                  {monthOptions().map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
                </select>
              </label>
              <span className="ml-auto text-xs text-[#697a91]">
                ✅ {counts.active} · ⏳ {counts.paused_resuming} · 😡 {counts.churned}
                {unset.length > 0 && <b className="text-[#c2410c]"> · {unset.length} unmarked</b>}
              </span>
            </div>

            <div className="grid gap-1">
              {roster.map((r) => {
                const k = key(r);
                return (
                  <div key={k} className="flex flex-wrap items-center gap-1.5 border border-[#f0f4f8] rounded-lg px-2.5 py-1.5">
                    <span className="text-xs font-medium text-[#1c2b3a] min-w-[150px]">{r.owner}</span>
                    <span className="text-[11px] text-[#8595a8] flex-1 min-w-[100px] truncate">{r.biz}</span>
                    <div className="flex gap-1">
                      {CHOICES.map((c) => (
                        <button key={c.k} type="button" onClick={() => setChoice((x) => ({ ...x, [k]: c.k }))}
                          className={cn("text-[10px] font-semibold rounded-full px-2 py-0.5 border",
                            choice[k] === c.k ? c.on : "bg-white border-[#e4ebf2] text-[#697a91] hover:bg-[#f6f9fc]")}>
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
              {roster.length === 0 && <p className="text-xs text-[#697a91]">No live or paused clients assigned to {coach} in the Clients sheet.</p>}
            </div>

            {unset.length > 0 && (
              <button type="button" onClick={() => setChoice((x) => { const n = { ...x }; for (const r of unset) n[key(r)] = "active"; return n; })}
                className="mt-2 text-[11px] font-semibold text-[#0b7f7f] border border-[#bfe6e2] bg-[#f7fdfc] rounded-lg px-2.5 py-1.5 hover:bg-[#effaf8]">
                Mark the {unset.length} remaining as Active ✅ (then fix the exceptions)
              </button>
            )}

            {/* Referrals — a new PMU artist sent in by one of the clients above.
                $100 each, approved by the admin on the same Alerts card. */}
            <div className="mt-4 rounded-xl border border-[#ffe0b8] bg-[#fffaf3] p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold text-[#1c2b3a]">🎁 Referrals this month</span>
                <span className="text-[10px] text-[#8a6d3b]">a new artist referred in by a client you manage — ${REFERRAL_BONUS} bonus each</span>
                {filledReferrals.length > 0 && (
                  <span className="ml-auto text-xs font-bold text-[#b45309]">
                    {filledReferrals.length} × ${REFERRAL_BONUS} = ${filledReferrals.length * REFERRAL_BONUS}
                  </span>
                )}
              </div>
              <div className="mt-2 grid gap-1.5">
                {referrals.map((r, i) => (
                  <div key={i} className="grid sm:grid-cols-[1fr_1fr_1fr_auto] gap-1.5">
                    <input value={r.referred_name} onChange={(e) => setRef(i, { referred_name: e.target.value })}
                      placeholder="New artist's name" className="border border-[#e4ebf2] rounded-lg px-2.5 py-1.5 text-xs bg-white" />
                    <input value={r.referred_by} onChange={(e) => setRef(i, { referred_by: e.target.value })}
                      list="coach-roster-names" placeholder="Referred by (your client)" className="border border-[#e4ebf2] rounded-lg px-2.5 py-1.5 text-xs bg-white" />
                    <input value={r.note} onChange={(e) => setRef(i, { note: e.target.value })}
                      placeholder="Note (optional)" className="border border-[#e4ebf2] rounded-lg px-2.5 py-1.5 text-xs bg-white" />
                    <button type="button" onClick={() => setReferrals((rs) => (rs.length === 1 ? [{ referred_name: "", referred_by: "", note: "" }] : rs.filter((_, j) => j !== i)))}
                      className="px-2 text-[#b45309] text-xs font-bold" title="Remove this referral">×</button>
                  </div>
                ))}
                <datalist id="coach-roster-names">
                  {roster.map((x) => <option key={key(x)} value={x.owner} />)}
                </datalist>
              </div>
              <button type="button" onClick={() => setReferrals((rs) => [...rs, { referred_name: "", referred_by: "", note: "" }])}
                className="mt-1.5 text-[11px] font-semibold text-[#b45309] border border-[#ffe0b8] bg-white rounded-lg px-2.5 py-1 hover:bg-[#fffaf3]">
                + Add another referral
              </button>
              {incompleteReferral && (
                <p className="mt-1 text-[10px] text-[#c2410c]">Each referral needs both names — the new artist and who referred them.</p>
              )}
            </div>

            <label className="grid gap-0.5 mt-3">
              <span className="text-[10px] font-medium text-[#697a91]">Anything else (a client not on this list, context on a pause…) — optional</span>
              <textarea value={extra} rows={2} onChange={(e) => setExtra(e.target.value)}
                className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
            </label>

            <label className="flex items-start gap-2 mt-3 text-xs text-[#1c2b3a]">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" />
              <span className="font-semibold">I confirm that the pipeline has been organized and all clients are assigned to the correct stages prior to this form submission.</span>
            </label>

            <button onClick={() => void submit()} disabled={busy || !confirm || unset.length > 0 || roster.length === 0 || incompleteReferral}
              className="mt-3 w-full sm:w-auto flex items-center justify-center gap-2 text-sm font-semibold bg-[#15B7AE] text-white rounded-lg px-6 py-2.5 hover:bg-[#0e9c9c] disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Yes I Confirm — Submit!
            </button>
            {unset.length > 0 && <p className="mt-1 text-[10px] text-[#c2410c]">Mark every client before submitting — {unset.length} left.</p>}
          </div>

        </>
      )}
      {!loading && submissions.length > 0 && (
            <div className="mt-4 border border-[#e4ebf2] rounded-xl bg-white p-4">
              <p className="text-sm font-semibold text-[#1c2b3a] mb-2">Previous reports</p>
              <div className="grid gap-1">
                {submissions.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-2 text-xs border border-[#f0f4f8] rounded-lg px-2.5 py-1.5">
                    <b className="text-[#1c2b3a]">{new Date(s.report_month + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</b>
                    {isAdmin && !coach ? <span className="text-[#697a91]">{s.coach}</span> : null}
                    <span className="text-[#697a91]">{s.entries.filter((e) => e.reported === "active").length} active · {s.entries.filter((e) => e.reported === "paused_resuming").length} resuming · {s.entries.filter((e) => e.reported === "churned").length} churned</span>
                    {(s.referrals?.length ?? 0) > 0 && (
                      <span className="font-semibold text-[#b45309]">🎁 {s.referrals!.length} referral{s.referrals!.length === 1 ? "" : "s"} (${s.referrals!.length * REFERRAL_BONUS})</span>
                    )}
                    <span className={cn("ml-auto font-semibold", s.mismatches.length ? "text-[#c2410c]" : "text-[#15803d]")}>
                      {s.mismatches.length ? `${s.mismatches.length} flagged` : "all matched ✓"}
                    </span>
                    <span className="text-[#8595a8]">{new Date(s.created_at).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            </div>
      )}
    </div>
  );
}
