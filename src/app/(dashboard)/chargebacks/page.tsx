"use client";
import { useEffect, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { Loader2, ChevronRight, Copy, Check, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

// Chargebacks — live Square disputes, matched to clients, with CRM delivery
// evidence and a ready-to-paste dispute statement. Admin only.

interface Dispute {
  id: string;
  state: string;
  reason: string;
  reasonLabel: string;
  open: boolean;
  amountCents: number;
  dueAt: string | null;
  reportedAt: string | null;
  cardBrand: string | null;
  payment: { date: string | null; receipt: string | null; amountCents: number; last4: string | null; buyerEmail: string | null } | null;
  cardholder: { name: string; email: string | null } | null;
  client: { owner: string; business: string } | null;
  stats: { leads: number; booked: number; engaged: number; deposits: number; conversations: number; firstLead: string | null; lastLead: string | null } | null;
  statement: string | null;
}

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
const fmtD = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const daysLeft = (iso: string | null) => (iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000) : null);

const STATE_BADGE: Record<string, { label: string; cls: string }> = {
  EVIDENCE_REQUIRED: { label: "Needs response", cls: "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]" },
  INQUIRY_EVIDENCE_REQUIRED: { label: "Inquiry — needs response", cls: "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]" },
  PROCESSING: { label: "In review", cls: "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]" },
  EVIDENCE_UPLOADED: { label: "Evidence submitted", cls: "bg-[#eef4ff] text-[#34568a] border-[#c9d8f0]" },
  WON: { label: "Won 🎉", cls: "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]" },
  LOST: { label: "Lost", cls: "bg-[#f1f5f9] text-[#697a91] border-[#e2e8f0]" },
  ACCEPTED: { label: "Accepted (refunded)", cls: "bg-[#f1f5f9] text-[#697a91] border-[#e2e8f0]" },
};

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1600); }}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#15B7AE] text-white hover:bg-[#0e8f88] transition-colors">
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? "Copied!" : "Copy statement"}
    </button>
  );
}

export default function ChargebacksPage() {
  const { role, loading: roleLoading } = useUser();
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (role !== "admin") return;
    fetch("/api/square/disputes")
      .then((r) => r.json())
      .then((j) => { if (j.error) setError(j.error); else setDisputes(j.disputes ?? []); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [role]);

  if (roleLoading) return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-[#15B7AE]" /></div>;
  if (role !== "admin") return <div className="p-8 text-sm text-[#697a91]">Admins only.</div>;

  const open = disputes.filter((d) => d.open);

  return (
    <div className="p-3 md:p-4 max-w-5xl mx-auto space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-bold text-[#1f3559]">🛡️ Chargebacks</h1>
        <span className="text-xs text-[#697a91]">live from Square · {disputes.length} dispute{disputes.length === 1 ? "" : "s"} on record{open.length ? ` · ${open.length} need${open.length === 1 ? "s" : ""} a response` : ""}</span>
      </div>

      {open.length > 0 && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-[#f5c2cf] bg-[#fde8ee] text-[#9f1239] text-sm">
          <ShieldAlert size={17} className="shrink-0 mt-0.5" />
          <div>
            <strong>{open.length} dispute{open.length === 1 ? "" : "s"} waiting for evidence.</strong> Open it below, copy the
            statement, and ask Claude: <em>&ldquo;Chargeback: build the evidence folder for [client]&rdquo;</em> — you&apos;ll get the
            exhibits, highlighted agreement and screenshots ready to upload before the deadline.
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-10"><Loader2 size={15} className="animate-spin" />Loading disputes from Square…</div>
      ) : error ? (
        <div className="px-4 py-3 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-sm"><strong>Error:</strong> {error}</div>
      ) : disputes.length === 0 ? (
        <div className="px-4 py-10 rounded-xl border border-[#e4ebf2] bg-white text-center text-sm text-[#697a91]">No disputes on record — clean slate. 🎉</div>
      ) : (
        <ul className="space-y-2">
          {disputes.map((d) => {
            const badge = STATE_BADGE[d.state] ?? { label: d.state, cls: "bg-[#f1f5f9] text-[#697a91] border-[#e2e8f0]" };
            const left = daysLeft(d.dueAt);
            const isOpen = openId === d.id;
            return (
              <li key={d.id} className="rounded-xl border border-[#e4ebf2] bg-white overflow-hidden">
                <button onClick={() => setOpenId(isOpen ? null : d.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#fafcfe]">
                  <ChevronRight size={15} className={cn("shrink-0 text-[#94a3b8] transition-transform", isOpen && "rotate-90")} />
                  <span className="font-bold text-[#1f3559] text-base whitespace-nowrap">{money(d.amountCents)}</span>
                  <span className={cn("px-2 py-0.5 rounded-md text-[11px] font-bold border whitespace-nowrap", badge.cls)}>{badge.label}</span>
                  <span className="text-sm text-[#34568a] truncate">
                    {d.cardholder?.name ?? "Unknown cardholder"}
                    {d.client && <span className="text-[#0e8f88] font-semibold"> → {d.client.business || d.client.owner}</span>}
                  </span>
                  <span className="ml-auto text-xs text-[#697a91] whitespace-nowrap">{d.reasonLabel}</span>
                  {d.open && left != null && (
                    <span className={cn("px-2 py-0.5 rounded-md text-[11px] font-bold whitespace-nowrap", left <= 3 ? "bg-[#e11d48] text-white" : "bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]")}>
                      {left <= 0 ? "DUE NOW" : `${left}d left · ${fmtD(d.dueAt)}`}
                    </span>
                  )}
                </button>

                {isOpen && (
                  <div className="px-4 pb-4 pt-1 border-t border-[#eef3f8] space-y-3">
                    <div className="grid gap-2 sm:grid-cols-2 text-sm text-[#34568a]">
                      <div><span className="text-[#8595a8]">Payment:</span> {money(d.payment?.amountCents ?? d.amountCents)} on {fmtD(d.payment?.date ?? null)}{d.payment?.receipt ? ` · receipt #${d.payment.receipt}` : ""}{d.payment?.last4 ? ` · ${d.cardBrand ?? "card"} •${d.payment.last4}` : ""}</div>
                      <div><span className="text-[#8595a8]">Cardholder:</span> {d.cardholder?.name ?? "—"}{d.cardholder?.email ? ` · ${d.cardholder.email}` : ""}{d.payment?.buyerEmail && d.payment.buyerEmail !== d.cardholder?.email ? ` · ${d.payment.buyerEmail}` : ""}</div>
                      <div><span className="text-[#8595a8]">Reported:</span> {fmtD(d.reportedAt)}</div>
                      <div><span className="text-[#8595a8]">Matched client:</span> {d.client ? `${d.client.owner} — ${d.client.business}` : "no automatic match — ask Claude to investigate"}</div>
                    </div>

                    {d.stats && (
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
                        {[
                          ["Leads delivered", d.stats.leads],
                          ["Booked appts", d.stats.booked],
                          ["AI-engaged", d.stats.engaged],
                          ["Deposits", d.stats.deposits],
                          ["Conversations", d.stats.conversations],
                          ["First → last lead", `${fmtD(d.stats.firstLead).replace(", 2026", "")} → ${fmtD(d.stats.lastLead).replace(", 2026", "")}`],
                        ].map(([label, val]) => (
                          <div key={String(label)} className="rounded-lg bg-[#f7fafc] border border-[#eef3f8] px-2 py-1.5 text-center">
                            <div className="text-[9px] font-bold uppercase tracking-wide text-[#8595a8]">{label}</div>
                            <div className="text-sm font-bold text-[#1f3559]">{val}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {d.statement ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div className="text-[11px] font-bold uppercase tracking-wide text-[#34568a]">Ready-to-paste statement <span className="font-medium normal-case text-[#697a91] tracking-normal">· {d.statement.length}/2,000 chars · auto-filled with this client&apos;s real numbers</span></div>
                          <CopyBtn text={d.statement} />
                        </div>
                        <textarea readOnly value={d.statement} rows={9}
                          className="w-full text-xs leading-relaxed text-[#1f3559] bg-[#f7fafc] border border-[#e4ebf2] rounded-lg p-3 focus:outline-none" />
                        <p className="text-[11px] text-[#8595a8]">
                          ⚠️ This is a draft from live data. Before submitting, ask Claude to <strong>verify the case and build the evidence folder</strong> — the
                          chat-log quotes, highlighted agreement pages and real screenshots are what win disputes, and Claude assembles those per case.
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-[#697a91]">No client matched, so no statement was generated — ask Claude: <em>&ldquo;Chargeback: investigate {d.cardholder?.name ?? "this cardholder"}&rdquo;</em>.</p>
                    )}

                    <div className="rounded-lg bg-[#f0fbfa] border border-[#bfe9e5] px-3 py-2 text-[11.5px] text-[#0e6f6a] leading-relaxed">
                      <strong>Evidence checklist for Square:</strong> ① this statement (paste in the text box) · ② signed Scope of Service PDF + e-signature certificate ·
                      ③ payment receipt · ④ exhibit screenshots (agreement highlights, CRM chat logs with the cardholder&apos;s identity visible, lead conversations, live funnel page).
                      Claude builds ④ into a folder on request.
                    </div>
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
