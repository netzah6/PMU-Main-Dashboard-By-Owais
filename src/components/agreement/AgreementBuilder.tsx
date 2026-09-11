"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Download, Sparkles, RotateCcw, Save, Undo2, FileText, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Agreement, type Block, agreementToText } from "@/lib/agreement";

// Agreement builder. Starts from the standard Scope of Service, takes edits in
// plain English ("add a clause that…", "change the price to…"), shows the
// result, and downloads it as a PDF. Every generated agreement can be saved
// and reopened; the standard itself can be updated when a change is permanent.
//
// The PDF is built in the browser (@react-pdf/renderer) — no server round
// trip, nothing stored unless Save is pressed.

type Saved = { id: string; partner_name: string | null; changes: string | null; created_by: string | null; created_at: string };

export function AgreementBuilder() {
  const [standard, setStandard] = useState<Agreement | null>(null);
  const [doc, setDoc] = useState<Agreement | null>(null);
  const [history, setHistory] = useState<Agreement[]>([]);   // for Undo
  const [changes, setChanges] = useState<string[]>([]);      // what the AI did, in order
  const [partner, setPartner] = useState("");
  const [saved, setSaved] = useState<Saved[]>([]);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<"ai" | "pdf" | "save" | "template" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/agreement");
    const j = await r.json();
    if (!r.ok) { setErr(j.error || "Failed to load"); return; }
    setStandard(j.template); setDoc(j.template); setSaved(j.saved ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const isModified = useMemo(() => !!doc && !!standard && agreementToText(doc) !== agreementToText(standard), [doc, standard]);

  const apply = (next: Agreement, what: string) => {
    if (doc) setHistory((h) => [...h, doc]);
    setDoc(next);
    setChanges((c) => [...c, what]);
  };

  async function askAi() {
    if (!doc || !instruction.trim()) return;
    setBusy("ai"); setErr(null); setNote(null);
    try {
      const r = await fetch("/api/agreement/edit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreement: doc, instruction }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Edit failed");
      apply(j.agreement, j.summary);
      setNote(j.summary);
      setInstruction("");
      inputRef.current?.focus();
    } catch (e) { setErr(e instanceof Error ? e.message : "Edit failed"); }
    finally { setBusy(null); }
  }

  function undo() {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setChanges((c) => c.slice(0, -1));
    setDoc(prev);
    setNote(null);
  }

  function editBlock(i: number, patch: Block) {
    if (!doc) return;
    const blocks = doc.blocks.slice(); blocks[i] = patch;
    apply({ ...doc, blocks }, "Edited by hand");
  }

  async function downloadPdf() {
    if (!doc) return;
    setBusy("pdf"); setErr(null);
    try {
      // Loaded on demand — the PDF engine is heavy and most visits never need it.
      const [{ pdf }, { AgreementPdf }] = await Promise.all([
        import("@react-pdf/renderer"),
        import("@/components/agreement/AgreementPdf"),
      ]);
      // The logo is embedded as a data URL so the PDF never references a host.
      const logoSrc = await fetch("/brand-logo.png").then((r) => r.blob()).then(
        (b) => new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(b); }),
      );
      const blob = await pdf(<AgreementPdf agreement={doc} partnerName={partner.trim() || undefined} logoSrc={logoSrc} />).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const who = partner.trim() ? `-${partner.trim().replace(/[^a-z0-9]+/gi, "-")}` : "";
      a.href = url; a.download = `PMU-Scope-of-Service${who}-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not build the PDF"); }
    finally { setBusy(null); }
  }

  async function post(body: Record<string, unknown>) {
    const r = await fetch("/api/agreement", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Failed");
    return j;
  }

  async function saveAgreement() {
    if (!doc) return;
    setBusy("save"); setErr(null);
    try {
      await post({ action: "save_agreement", agreement: doc, partnerName: partner, changes: changes.join(" · ") });
      setNote(`Saved${partner ? ` for ${partner}` : ""} — it's in the list on the right and can be reopened any time.`);
      await load().then(() => { /* load resets doc; keep the working copy */ });
      setDoc(doc);
    } catch (e) { setErr(e instanceof Error ? e.message : "Save failed"); }
    finally { setBusy(null); }
  }

  async function makeStandard() {
    if (!doc) return;
    if (!window.confirm("Make this the standard agreement?\n\nEvery new agreement will start from this text from now on.")) return;
    setBusy("template"); setErr(null);
    try {
      await post({ action: "save_template", agreement: doc });
      setStandard(doc); setChanges([]); setHistory([]);
      setNote("This is now the standard. New agreements start from here.");
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(null); }
  }

  async function openSaved(id: string) {
    setErr(null);
    try {
      const j = await post({ action: "load_agreement", id });
      setDoc(j.agreement); setPartner(j.partnerName ?? ""); setChanges(j.changes ? [j.changes] : []); setHistory([]);
      setNote(`Opened the saved agreement${j.partnerName ? ` for ${j.partnerName}` : ""}.`);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
  }

  if (!doc) return <div className="flex items-center gap-2 text-sm text-[#697a91] p-6"><Loader2 size={15} className="animate-spin" /> Loading the agreement…</div>;

  return (
    <div className="p-3 sm:p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-xl font-bold text-[#1f3559]">Agreement</h1>
        {isModified
          ? <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#fff7ec] text-[#b45309] border border-[#fcd9a8]">{changes.length} change{changes.length === 1 ? "" : "s"} from standard</span>
          : <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#e6f7ee] text-[#15803d] border border-[#c7edd4]">Standard</span>}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <input value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="Partner name (optional)"
            className="px-2.5 py-1.5 rounded-lg border border-[#d7e0ea] bg-white text-sm text-[#1f3559] w-[210px]" />
          <button onClick={downloadPdf} disabled={busy === "pdf"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-[#15B7AE] text-white hover:bg-[#0e8f88] disabled:opacity-60">
            {busy === "pdf" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Download PDF
          </button>
        </div>
      </div>

      {/* The ask box */}
      <div className="rounded-xl border border-[#cfe3f7] bg-[#f7fbff] p-3 space-y-2">
        <div className="flex items-start gap-2">
          <Sparkles size={15} className="text-[#1d4ed8] mt-2 shrink-0" />
          <textarea ref={inputRef} value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={2}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") askAi(); }}
            placeholder={'Tell me what to change — e.g. "add that the partner gets a free month if we miss the guarantee", "change the price to $997 × 3", "remove the exit interview line"'}
            className="flex-1 px-3 py-2 rounded-lg border border-[#d7e0ea] bg-white text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE] resize-y" />
          <button onClick={askAi} disabled={busy === "ai" || !instruction.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-[#1d4ed8] text-white disabled:opacity-50 shrink-0">
            {busy === "ai" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Apply
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-[#697a91]">
          <span>⌘/Ctrl+Enter to apply · click any paragraph below to edit it by hand</span>
          <span className="ml-auto flex items-center gap-1.5">
            {history.length > 0 && (
              <button onClick={undo} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-[#d7e0ea] bg-white text-[#34568a] font-semibold"><Undo2 size={11} /> Undo</button>
            )}
            {isModified && (
              <>
                <button onClick={() => { if (standard) { setDoc(standard); setChanges([]); setHistory([]); setNote(null); } }}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-[#d7e0ea] bg-white text-[#34568a] font-semibold"><RotateCcw size={11} /> Back to standard</button>
                <button onClick={saveAgreement} disabled={busy === "save"}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-[#a7e3df] bg-[#e6f7f5] text-[#0e8f88] font-semibold"><Save size={11} /> Save this version</button>
                <button onClick={makeStandard} disabled={busy === "template"}
                  title="Every new agreement will start from this text"
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-[#fcd9a8] bg-[#fff7ec] text-[#b45309] font-semibold"><FileText size={11} /> Make this the standard</button>
              </>
            )}
          </span>
        </div>
        {err && <p className="text-[12px] text-[#e11d48] bg-[#fde8ee] border border-[#f5c2cf] rounded-lg px-2.5 py-1.5">{err}</p>}
        {note && <p className="text-[12px] text-[#15803d] bg-[#e6f7ee] border border-[#c7edd4] rounded-lg px-2.5 py-1.5">{note}</p>}
        {changes.length > 0 && (
          <ol className="text-[11px] text-[#34568a] list-decimal pl-5 space-y-0.5">
            {changes.map((c, i) => <li key={i}>{c}</li>)}
          </ol>
        )}
      </div>

      <div className="grid lg:grid-cols-[1fr_260px] gap-3 items-start">
        {/* The document — reads like the page, every block editable in place */}
        <div className="rounded-xl border border-[#e4ebf2] bg-white shadow-sm">
          <div className="h-3 bg-[#2EC4C6] rounded-t-xl" />
          <div className="px-8 py-6 max-w-[760px]">
            <h2 className="text-[15px] font-bold text-[#171717] mb-4">{doc.title}</h2>
            {doc.blocks.map((b, i) => {
              const isEd = editing === i;
              const wrap = (child: React.ReactNode) => (
                <div key={i} onClick={() => !isEd && b.type !== "signature" && setEditing(i)}
                  className={cn("rounded px-1 -mx-1", b.type !== "signature" && "cursor-text hover:bg-[#f7fbff]")}>{child}</div>
              );
              if (isEd && (b.type === "heading" || b.type === "paragraph")) {
                return (
                  <div key={i} className="my-1">
                    <textarea autoFocus defaultValue={b.text} rows={b.type === "heading" ? 1 : 4}
                      onBlur={(e) => { setEditing(null); if (e.target.value !== b.text) editBlock(i, { ...b, text: e.target.value }); }}
                      className="w-full px-2 py-1 rounded border border-[#15B7AE] text-[13px] text-[#171717] font-sans" />
                  </div>
                );
              }
              if (isEd && (b.type === "bullets" || b.type === "numbered")) {
                return (
                  <div key={i} className="my-1">
                    <textarea autoFocus defaultValue={b.items.join("\n")} rows={Math.max(3, b.items.length + 1)}
                      onBlur={(e) => { setEditing(null); const items = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean); if (items.join("\n") !== b.items.join("\n")) editBlock(i, { ...b, items }); }}
                      className="w-full px-2 py-1 rounded border border-[#15B7AE] text-[13px] text-[#171717] font-sans" />
                    <p className="text-[10px] text-[#8595a8]">one item per line</p>
                  </div>
                );
              }
              if (b.type === "heading") return wrap(<h3 className="text-[13px] font-bold text-[#171717] mt-4 mb-1">{b.text}</h3>);
              if (b.type === "paragraph") return wrap(<p className="text-[13px] text-[#171717] leading-relaxed mb-2">{b.text}</p>);
              if (b.type === "bullets" || b.type === "numbered") {
                const L = b.type === "bullets" ? "ul" : "ol";
                return wrap(<L className={cn("text-[13px] text-[#171717] leading-relaxed mb-2 pl-5", b.type === "bullets" ? "list-disc" : "list-decimal")}>{b.items.map((it, n) => <li key={n} className="mb-0.5">{it}</li>)}</L>);
              }
              return wrap(
                <div className="mt-8 space-y-5 text-[12px] text-[#171717]">
                  {["Partner Full Name", "Partner Signature", "Date"].map((l) => (
                    <div key={l}><div className="w-[150px] border-b border-dashed border-[#171717] mb-1" />{l}{l === "Partner Full Name" && partner ? `: ${partner}` : ""}</div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* Saved agreements */}
        <div className="rounded-xl border border-[#e4ebf2] bg-white p-3">
          <h3 className="text-[12px] font-bold text-[#1f3559] mb-2">Saved agreements</h3>
          {saved.length === 0 ? (
            <p className="text-[11px] text-[#8595a8]">None yet. Press &ldquo;Save this version&rdquo; after making changes and it will appear here to reopen later.</p>
          ) : (
            <ul className="space-y-1">
              {saved.map((sv) => (
                <li key={sv.id}>
                  <button onClick={() => openSaved(sv.id)} className="w-full text-left rounded-lg border border-[#eef3f8] px-2 py-1.5 hover:border-[#15B7AE]">
                    <div className="text-[12px] font-semibold text-[#1f3559] truncate">{sv.partner_name || "Untitled"}</div>
                    <div className="text-[10px] text-[#8595a8]">{new Date(sv.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}{sv.created_by ? ` · ${sv.created_by.split("@")[0]}` : ""}</div>
                    {sv.changes && <div className="text-[10px] text-[#697a91] line-clamp-2">{sv.changes}</div>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
