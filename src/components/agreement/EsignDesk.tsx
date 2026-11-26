"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Link2, Copy, Check, Download, Ban, ChevronDown, ChevronRight, ExternalLink, Save, RotateCcw, Search, FileSignature } from "lucide-react";
import { AgreementView } from "@/components/agreement/AgreementView";
import type { Agreement, Block } from "@/lib/agreement";
import {
  TEMPLATE_IDS, TEMPLATE_LABELS, defaultFields, fieldLabel, validateFields, renderAgreement, placeholderValues, usDate, usDateTime,
  type EsignTemplateId, type FieldDef, type FieldValues,
} from "@/lib/esign";

// Agreements tab (owner, 11/26/2026): one menu tab with sub-tabs —
//   Send for signature (default): pick a template, type the client and the
//     numbers, get a signing link. The wording is locked.
//   Signed agreements: every signed agreement, for the whole sales team, plus
//     the older ones from the Go High Level "Signed Agreements" sheet.
//   Edit wording (admins only): the template wording + the old builder.
// Screens stay short: details sit behind a click.

type Row = {
  id: string; token: string; template: EsignTemplateId; fields: FieldValues;
  partner_name: string; partner_email: string; partner_phone: string | null;
  created_by: string | null; created_at: string; status: "sent" | "viewed" | "signed" | "void";
  viewed_at: string | null; signed_at: string | null; signer_name: string | null; signed_pdf_path: string | null;
  voided_at: string | null; voided_by: string | null; ghl_note: string | null;
};
type SignedRow = {
  id: string; template: EsignTemplateId; fields: FieldValues; partner_name: string; partner_email: string;
  created_by: string | null; created_at: string; signed_at: string | null; signer_name: string | null; signed_pdf_path: string | null;
};
type OlderRow = { name: string; date: string };
type TemplateInfo = { label: string; fields: FieldDef[]; template: Agreement; overridden: boolean };
type Data = {
  role: string; email: string | null; linkOrigin: string | null; templates: Record<EsignTemplateId, TemplateInfo>;
  rows: Row[]; signed: SignedRow[]; older: OlderRow[]; setupNeeded: boolean; error: string | null;
};
type View = "send" | "signed" | "wording";

const local = () => (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC");
const btn = "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold border disabled:opacity-60";
const input = "w-full px-2.5 py-1.5 rounded-lg border border-[#d7e0ea] bg-white text-[13px] text-[#1f3559] focus:outline-none focus:border-[#15B7AE]";

function linkFor(token: string, origin: string | null) { return `${origin || window.location.origin}/sign/${token}`; }

const norm = (n: string) => n.toLowerCase().replace(/[^a-z]+/g, " ").trim();
/** "Who sent it": the part of the email before the @. */
const who = (email: string | null) => (email ? email.split("@")[0] : "");

function CopyButton({ text, label = "Copy link" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={`${btn} border-[#d7e0ea] bg-white text-[#34568a]`}
      onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { window.prompt("Copy this link:", text); } }}>
      {done ? <Check size={12} /> : <Copy size={12} />} {done ? "Copied" : label}
    </button>
  );
}

function StatusChip({ r }: { r: Row }) {
  const tz = local();
  if (r.status === "signed") return <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#e6f7ee] text-[#15803d] border border-[#c7edd4]">Signed {usDate(r.signed_at, tz)}</span>;
  if (r.status === "void") return <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#f1f5f9] text-[#64748b] border border-[#e2e8f0]">Void</span>;
  if (r.status === "viewed") return <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#eef4ff] text-[#1d4ed8] border border-[#cfdcfb]">Opened {usDate(r.viewed_at, tz)}</span>;
  return <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#fff7ec] text-[#b45309] border border-[#fcd9a8]">Sent {usDate(r.created_at, tz)}</span>;
}

function fieldSummary(t: EsignTemplateId, v: FieldValues): string {
  try {
    const p = placeholderValues(t, v);
    return t === "ppa"
      ? `${p.fee} fee + ${p.deposit} deposit (total ${p.total}) · ads ${p.ad_spend}`
      : `${p.program_length} · ${p.price_terms} · ads ${p.ad_spend}/mo · ${p.guarantee_bookings} bookings ${p.guarantee_period}`;
  } catch { return ""; }
}

/** Admin-only: edit the locked wording. {{spots}} must stay. */
function WordingEditor({ t, info, onSaved }: { t: EsignTemplateId; info: TemplateInfo; onSaved: () => void }) {
  const [doc, setDoc] = useState<Agreement>(info.template);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setDoc(info.template); }, [info.template]);
  const setBlock = (i: number, b: Block) => setDoc((d) => ({ ...d, blocks: d.blocks.map((x, n) => (n === i ? b : x)) }));
  async function post(action: "save_template" | "reset_template") {
    if (action === "reset_template" && !window.confirm("Go back to the original wording from the Canva file?")) return;
    setBusy(action === "save_template" ? "save" : "reset"); setMsg(null);
    try {
      const r = await fetch("/api/esign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, template: t, agreement: doc }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed");
      setMsg({ ok: true, text: action === "save_template" ? "Saved. New links use this wording." : "Back to the original wording." });
      onSaved();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" }); }
    finally { setBusy(null); }
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-[#697a91]">Keep every {"{{spot}}"} — that is where the numbers go. Links already sent never change.</p>
      {doc.blocks.map((b, i) => {
        if (b.type === "signature") return <p key={i} className="text-[11px] text-[#8595a8]">[signature block]</p>;
        if (b.type === "heading" || b.type === "paragraph") {
          return <textarea key={i} value={b.text} rows={b.type === "heading" ? 1 : 3} onChange={(e) => setBlock(i, { ...b, text: e.target.value })}
            className={`${input} ${b.type === "heading" ? "font-bold" : ""}`} />;
        }
        return <textarea key={i} value={b.items.join("\n\n")} rows={Math.max(3, b.items.length * 2)}
          onChange={(e) => setBlock(i, { ...b, items: e.target.value.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean) })} className={input} />;
      })}
      <p className="text-[10px] text-[#8595a8]">In lists, leave an empty line between items.</p>
      <div className="flex gap-2 flex-wrap">
        <button type="button" onClick={() => post("save_template")} disabled={!!busy} className={`${btn} border-[#a7e3df] bg-[#e6f7f5] text-[#0e8f88]`}>
          {busy === "save" ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save wording
        </button>
        {info.overridden && (
          <button type="button" onClick={() => post("reset_template")} disabled={!!busy} className={`${btn} border-[#d7e0ea] bg-white text-[#34568a]`}>
            {busy === "reset" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Back to original
          </button>
        )}
      </div>
      {msg && <p className={`text-[12px] rounded-lg px-2.5 py-1.5 ${msg.ok ? "text-[#15803d] bg-[#e6f7ee]" : "text-[#e11d48] bg-[#fde8ee]"}`}>{msg.text}</p>}
    </div>
  );
}

export function EsignDesk() {
  const params = useSearchParams();
  const focusId = params.get("id");
  const [data, setData] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [t, setT] = useState<EsignTemplateId>("standard");
  const [wt, setWt] = useState<EsignTemplateId>("standard");
  const [vals, setVals] = useState<Record<EsignTemplateId, FieldValues>>({ standard: defaultFields("standard"), ppa: defaultFields("ppa") });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [serverFieldErrs, setServerFieldErrs] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ link: string; name: string } | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [open, setOpen] = useState<string | null>(focusId);
  const [view, setView] = useState<View>(params.get("tab") === "signed" ? "signed" : "send");
  const [q, setQ] = useState("");
  const [showOlder, setShowOlder] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/esign", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) { setLoadErr(j.error || "Failed to load"); return; }
      setData(j);
    } catch { setLoadErr("Failed to load"); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // A link to a signed agreement someone else sent (?id=) opens "Signed agreements".
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current || !focusId || !data) return;
    jumped.current = true;
    if (!data.rows.some((r) => r.id === focusId) && data.signed.some((r) => r.id === focusId)) setView("signed");
  }, [focusId, data]);

  const { values, errors } = useMemo(() => validateFields(t, vals[t]), [t, vals]);
  const preview = useMemo(() => {
    if (!data) return null;
    // Invalid fields fall back to the default in the preview only.
    const merged = { ...defaultFields(t), ...values };
    return renderAgreement(data.templates[t].template, t, merged);
  }, [data, t, values]);

  const fieldErrs = { ...serverFieldErrs, ...errors };
  const canCreate = name.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()) && Object.keys(errors).length === 0;

  async function create() {
    if (!canCreate) return;
    setBusy("create"); setErr(null); setServerFieldErrs({}); setCreated(null);
    try {
      const r = await fetch("/api/esign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", template: t, name, email, phone, fields: vals[t] }),
      });
      const j = await r.json();
      if (!r.ok) { setServerFieldErrs(j.fieldErrors ?? {}); throw new Error(j.error || "Could not create the link"); }
      setCreated({ link: j.link, name: name.trim() });
      setName(""); setEmail(""); setPhone("");
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not create the link"); }
    finally { setBusy(null); }
  }

  async function voidRow(r: Row) {
    if (!window.confirm(`Void the agreement for ${r.partner_name}?\n\nThe link will stop working. This can't be undone.`)) return;
    setBusy(`void:${r.id}`); setErr(null);
    try {
      const res = await fetch("/api/esign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "void", id: r.id }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Could not void");
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not void"); }
    finally { setBusy(null); }
  }

  async function download(r: { id: string; signer_name: string | null; partner_name: string }) {
    setBusy(`pdf:${r.id}`); setErr(null);
    try {
      const res = await fetch(`/api/esign/${r.id}?pdf=1`);
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "Could not download"); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `PMU-Agreement-${(r.signer_name || r.partner_name).replace(/[^a-z0-9]+/gi, "-")}-signed.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not download"); }
    finally { setBusy(null); }
  }

  if (loadErr) return <div className="p-6 text-sm text-[#e11d48]">{loadErr}</div>;
  if (!data) return <div className="flex items-center gap-2 text-sm text-[#697a91] p-6"><Loader2 size={15} className="animate-spin" /> Loading…</div>;

  const isAdmin = data.role === "admin";
  const fields = data.templates[t].fields.filter((f) => !f.showIf || String(vals[t][f.showIf.key]) === f.showIf.value);
  const setField = (k: string, v: string) => { setVals((cur) => ({ ...cur, [t]: { ...cur[t], [k]: v } })); setServerFieldErrs({}); };

  const tabs: Array<[View, string]> = [["send", "Send for signature"], ["signed", `Signed agreements (${data.signed.length})`]];
  if (isAdmin) tabs.push(["wording", "Edit wording"]);

  return (
    <div className="p-3 sm:p-4 space-y-3 max-w-[1200px]">
      <div>
        <h1 className="text-xl font-bold text-[#1f3559]">Agreements</h1>
        <p className="text-[12px] text-[#697a91]">Change the numbers, get a link, send it to the client. They sign on our page.</p>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {tabs.map(([v, label]) => (
          <button key={v} type="button" onClick={() => setView(v)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-semibold border ${view === v ? "bg-[#1f3559] text-white border-[#1f3559]" : "bg-white text-[#34568a] border-[#d7e0ea]"}`}>
            {label}
          </button>
        ))}
      </div>

      {data.setupNeeded && (
        <p className="text-[12px] text-[#b45309] bg-[#fff7ec] border border-[#fcd9a8] rounded-lg px-3 py-2">Setup needed: the database table is not created yet (supabase/agreement-signatures.sql).</p>
      )}
      {err && view !== "send" && <p className="text-[12px] text-[#e11d48] bg-[#fde8ee] border border-[#f5c2cf] rounded-lg px-2.5 py-1.5">{err}</p>}

      {view === "send" && (
        <>
        <div className="grid lg:grid-cols-[380px_1fr] gap-3 items-start">
          {/* ── Send for signature ── */}
          <div className="rounded-xl border border-[#e4ebf2] bg-white p-3 space-y-3">
            <h2 className="text-[13px] font-bold text-[#1f3559]">Send for signature</h2>
            <div className="grid grid-cols-2 gap-1.5">
              {TEMPLATE_IDS.map((id) => (
                <button key={id} type="button" onClick={() => { setT(id); setServerFieldErrs({}); }}
                  className={`px-2 py-2 rounded-lg text-[12px] font-semibold border ${t === id ? "bg-[#15B7AE] text-white border-[#15B7AE]" : "bg-white text-[#34568a] border-[#d7e0ea]"}`}>
                  {TEMPLATE_LABELS[id]}
                </button>
              ))}
            </div>
            <div className="space-y-2">
              <label className="block"><span className="text-[11px] font-semibold text-[#34568a]">Client full name</span>
                <input value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} className={input} /></label>
              <label className="block"><span className="text-[11px] font-semibold text-[#34568a]">Client email</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value.slice(0, 200))} className={input} /></label>
              <label className="block"><span className="text-[11px] font-semibold text-[#34568a]">Client phone (optional)</span>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value.slice(0, 30))} className={input} /></label>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-[#eef3f8]">
              {fields.map((f) => (
                <label key={f.key} className={`block ${f.wide ? "col-span-2" : ""}`}>
                  <span className="text-[11px] font-semibold text-[#34568a]">{fieldLabel(f, vals[t])}</span>
                  {f.type === "choice" ? (
                    <select value={String(vals[t][f.key])} onChange={(e) => setField(f.key, e.target.value)} className={input}>
                      {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <div className="relative">
                      {f.type === "money" && <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[13px] text-[#8595a8]">$</span>}
                      <input value={String(vals[t][f.key] ?? "")} onChange={(e) => setField(f.key, e.target.value.slice(0, 20))}
                        inputMode={f.type === "money" || f.type === "number" ? "decimal" : "text"} placeholder={f.hint}
                        className={`${input} ${f.type === "money" ? "pl-5" : ""} ${fieldErrs[f.key] ? "border-[#e11d48]" : ""}`} />
                    </div>
                  )}
                  {fieldErrs[f.key] && <span className="text-[10px] text-[#e11d48]">{fieldErrs[f.key]}</span>}
                </label>
              ))}
              {t === "ppa" && !errors.fee && !errors.deposit && (
                <p className="col-span-2 text-[11px] text-[#697a91]">Total per booking: <b>{placeholderValues("ppa", values).total}</b> (fee + deposit)</p>
              )}
            </div>
            {err && <p className="text-[12px] text-[#e11d48] bg-[#fde8ee] border border-[#f5c2cf] rounded-lg px-2.5 py-1.5">{err}</p>}
            <button type="button" onClick={create} disabled={!canCreate || busy === "create"}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-bold bg-[#15B7AE] text-white disabled:opacity-50">
              {busy === "create" ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><Link2 size={14} /> Create signing link</>}
            </button>
            {created && (
              <div className="rounded-lg border border-[#c7edd4] bg-[#e6f7ee] p-2.5 space-y-2">
                <p className="text-[12px] font-semibold text-[#15803d]">Link ready for {created.name}</p>
                <input readOnly value={created.link} onFocus={(e) => e.target.select()} className={`${input} text-[11px]`} />
                <div className="flex gap-1.5"><CopyButton text={created.link} />
                  <a href={created.link} target="_blank" rel="noreferrer" className={`${btn} border-[#d7e0ea] bg-white text-[#34568a]`}><ExternalLink size={12} /> Open</a></div>
                <p className="text-[10px] text-[#4d7c5f]">Nothing was sent to the client. Send the link yourself.</p>
              </div>
            )}
          </div>

          {/* ── Preview ── */}
          <div className="space-y-2 min-w-0">
            <button type="button" onClick={() => setShowPreview((v) => !v)} className="flex items-center gap-1 text-[12px] font-semibold text-[#34568a]">
              {showPreview ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Preview — what the client will sign
            </button>
            {showPreview && preview && (
              <div className="max-h-[75vh] overflow-y-auto rounded-xl">
                <AgreementView agreement={preview} partnerName={name.trim() || undefined} />
              </div>
            )}
          </div>
        </div>

        {/* ── Sent agreements ── */}
        <div className="rounded-xl border border-[#e4ebf2] bg-white p-3">
          <h2 className="text-[13px] font-bold text-[#1f3559] mb-2">Sent by {isAdmin ? "the team" : "you"} <span className="text-[#8595a8] font-normal">({data.rows.length})</span></h2>
          {data.rows.length === 0 ? <p className="text-[12px] text-[#8595a8]">None yet.</p> : (
            <ul className="divide-y divide-[#eef3f8]">
              {data.rows.map((r) => {
                const canVoid = (isAdmin || r.created_by === data.email) && (r.status === "sent" || r.status === "viewed");
                const isOpen = open === r.id;
                return (
                  <li key={r.id} className={`py-2 ${focusId === r.id ? "bg-[#f7fbff] -mx-2 px-2 rounded-lg" : ""}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button type="button" onClick={() => setOpen(isOpen ? null : r.id)} className="flex items-center gap-1 min-w-0 text-left">
                        {isOpen ? <ChevronDown size={13} className="text-[#8595a8] shrink-0" /> : <ChevronRight size={13} className="text-[#8595a8] shrink-0" />}
                        <span className="text-[13px] font-semibold text-[#1f3559] truncate">{r.partner_name}</span>
                        <span className="text-[11px] text-[#8595a8] shrink-0">· {TEMPLATE_LABELS[r.template]}</span>
                      </button>
                      <StatusChip r={r} />
                      <div className="ml-auto flex items-center gap-1.5">
                        {r.status !== "void" && r.status !== "signed" && <CopyButton text={linkFor(r.token, data.linkOrigin)} />}
                        {r.status === "signed" && (
                          <button type="button" onClick={() => download(r)} disabled={busy === `pdf:${r.id}`} className={`${btn} border-[#a7e3df] bg-[#e6f7f5] text-[#0e8f88]`}>
                            {busy === `pdf:${r.id}` ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Signed PDF
                          </button>
                        )}
                        {canVoid && (
                          <button type="button" onClick={() => voidRow(r)} disabled={busy === `void:${r.id}`} className={`${btn} border-[#f5c2cf] bg-white text-[#e11d48]`}>
                            {busy === `void:${r.id}` ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />} Void
                          </button>
                        )}
                      </div>
                    </div>
                    {isOpen && (
                      <div className="mt-1.5 ml-5 text-[11px] text-[#697a91] space-y-0.5 break-words">
                        <div>{r.partner_email}{r.partner_phone ? ` · ${r.partner_phone}` : ""}</div>
                        <div>{fieldSummary(r.template, r.fields)}</div>
                        <div>Made {usDateTime(r.created_at, local())}{r.created_by ? ` by ${r.created_by}` : ""}</div>
                        {r.viewed_at && <div>Opened {usDateTime(r.viewed_at, local())}</div>}
                        {r.signed_at && <div>Signed {usDateTime(r.signed_at, local())}{r.signer_name ? ` by ${r.signer_name}` : ""}</div>}
                        {r.voided_at && <div>Voided {usDateTime(r.voided_at, local())}{r.voided_by ? ` by ${r.voided_by}` : ""}</div>}
                        {r.ghl_note && <div>GHL: {r.ghl_note}</div>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        </>
      )}

      {view === "signed" && (
        <SignedList data={data} q={q} setQ={setQ} focusId={focusId} busy={busy} onDownload={download} showOlder={showOlder} setShowOlder={setShowOlder} />
      )}

      {view === "wording" && isAdmin && (
        <div className="rounded-xl border border-[#e4ebf2] bg-white p-3 space-y-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            {TEMPLATE_IDS.map((id) => (
              <button key={id} type="button" onClick={() => setWt(id)}
                className={`px-2.5 py-1.5 rounded-lg text-[12px] font-semibold border ${wt === id ? "bg-[#15B7AE] text-white border-[#15B7AE]" : "bg-white text-[#34568a] border-[#d7e0ea]"}`}>
                {TEMPLATE_LABELS[id]}{data.templates[id].overridden ? " · changed" : ""}
              </button>
            ))}
            <Link href="/agreement" className={`${btn} ml-auto border-[#d7e0ea] bg-white text-[#34568a]`}><FileSignature size={12} /> Old agreement builder</Link>
          </div>
          <WordingEditor key={wt} t={wt} info={data.templates[wt]} onSaved={load} />
        </div>
      )}
    </div>
  );
}

/** Every signed agreement (whole team) + the older Go High Level ones. */
function SignedList({ data, q, setQ, focusId, busy, onDownload, showOlder, setShowOlder }: {
  data: Data; q: string; setQ: (v: string) => void; focusId: string | null; busy: string | null;
  onDownload: (r: SignedRow) => void; showOlder: boolean; setShowOlder: (v: boolean) => void;
}) {
  const tz = local();
  const needle = norm(q);
  const signed = data.signed.filter((r) => !needle || norm(`${r.signer_name ?? ""} ${r.partner_name} ${r.partner_email}`).includes(needle));
  // The Go High Level workflow also writes OUR e-sign signings into the
  // sheet — hide those twins (same name, within 3 days).
  const ours = data.signed.map((r) => ({ names: [norm(r.signer_name ?? ""), norm(r.partner_name)], at: r.signed_at ? Date.parse(r.signed_at) : NaN }));
  const older = data.older
    .filter((o) => {
      const at = Date.parse(o.date);
      const n = norm(o.name);
      return !ours.some((x) => x.names.includes(n) && Number.isFinite(at) && Number.isFinite(x.at) && Math.abs(at - x.at) < 3 * 86400_000);
    })
    .filter((o) => !needle || norm(o.name).includes(needle))
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

  return (
    <div className="space-y-3">
      <div className="relative w-full sm:w-72">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8595a8]" />
        <input value={q} onChange={(e) => setQ(e.target.value.slice(0, 80))} placeholder="Search name or email" className={`${input} pl-7`} />
      </div>
      <div className="rounded-xl border border-[#e4ebf2] bg-white p-3">
        <h2 className="text-[13px] font-bold text-[#1f3559] mb-2">Signed here <span className="text-[#8595a8] font-normal">({signed.length})</span></h2>
        {signed.length === 0 ? <p className="text-[12px] text-[#8595a8]">None yet.</p> : (
          <ul className="divide-y divide-[#eef3f8]">
            {signed.map((r) => (
              <li key={r.id} className={`py-2 flex items-center gap-2 flex-wrap ${focusId === r.id ? "bg-[#f7fbff] -mx-2 px-2 rounded-lg" : ""}`}>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-[#1f3559] truncate">{r.signer_name || r.partner_name}</div>
                  <div className="text-[11px] text-[#8595a8] truncate">
                    {TEMPLATE_LABELS[r.template]} · signed {usDate(r.signed_at, tz)}{r.created_by ? ` · sent by ${who(r.created_by)}` : ""}
                  </div>
                </div>
                {r.signed_pdf_path && (
                  <button type="button" onClick={() => onDownload(r)} disabled={busy === `pdf:${r.id}`} className={`${btn} ml-auto border-[#a7e3df] bg-[#e6f7f5] text-[#0e8f88]`}>
                    {busy === `pdf:${r.id}` ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} PDF
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="rounded-xl border border-[#e4ebf2] bg-white p-3">
        <button type="button" onClick={() => setShowOlder(!showOlder)} className="flex items-center gap-1 text-[13px] font-bold text-[#1f3559]">
          {showOlder ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Older (Go High Level) <span className="text-[#8595a8] font-normal">({older.length})</span>
        </button>
        {showOlder && (older.length === 0 ? <p className="mt-2 text-[12px] text-[#8595a8]">None.</p> : (
          <ul className="mt-2 divide-y divide-[#eef3f8]">
            {older.map((o, i) => (
              <li key={`${o.name}-${o.date}-${i}`} className="py-1.5 flex items-center gap-2 text-[12px]">
                <span className="font-semibold text-[#1f3559] truncate">{o.name || "—"}</span>
                <span className="ml-auto text-[#8595a8] shrink-0">{o.date || "—"}</span>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}
