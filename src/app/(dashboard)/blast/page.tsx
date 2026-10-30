"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Megaphone, Users, Clock, Send, X, RefreshCw, AlertTriangle, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { templateProblem, autoFixTemplate } from "@/lib/blast-template";

// Admin text-blast tab. Human-only by design: the AI tab can't reach this —
// an admin picks the audience, sees the exact list, and presses the button.

type Client = { locationId: string; ownerKey: string; label: string; senderFirstName: string; serviceWord: string };
type Stage = { pipeline_id: string; stage_id: string; stage_name: string; position: number };
type Recipient = { contactId: string; name: string; firstName: string; phone: string };
type Job = {
  id: string; client_label: string | null; status: string; total: number; sent: number; failed: number;
  send_at: string; created_at: string; stage_names: string[]; message_template: string; timezone?: string | null;
  error?: string | null; fail_reasons?: Array<{ reason: string; n: number }>;
  replies_total?: number; replies_positive?: number;
  positive_replies?: Array<{ name: string | null; text: string | null; at: string | null }>;
};

/* Blast times are the CLIENT's time (owner, 10/19/2026). A datetime-local
   value has no zone, so it is read as wall-clock time in the client's IANA
   zone and converted to UTC here; the browser's own zone never matters. */
function zonedToIso(local: string, tz: string): string {
  const [d, t] = local.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = (t ?? "00:00").split(":").map(Number);
  const wall = Date.UTC(y, m - 1, day, hh, mm);
  const offsetAt = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
    const g = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - ms;
  };
  let ms = wall - offsetAt(wall);
  ms = wall - offsetAt(ms); // second pass settles DST edges
  return new Date(ms).toISOString();
}
function fmtInTz(iso: string, tz: string | null | undefined): string {
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: tz || undefined, month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return new Date(iso).toLocaleString("en-US"); }
}
const tzCity = (tz: string | null | undefined) => tz ? tz.split("/").pop()!.replace(/_/g, " ") : "your computer's time";

export default function BlastPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [defaultTemplate, setDefaultTemplate] = useState("");
  const [client, setClient] = useState<Client | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [clientTz, setClientTz] = useState<string | null>(null); // the picked client's GHL time zone
  const [stagesLoading, setStagesLoading] = useState(false);
  const [selStages, setSelStages] = useState<Set<string>>(new Set());
  const [senderName, setSenderName] = useState("");
  const [serviceWord, setServiceWord] = useState("");
  const [template, setTemplate] = useState("");
  const [preview, setPreview] = useState<{ recipients: Recipient[]; noPhone: number; eligible: number; excludedRecent: number } | null>(null);
  const [excludeDays, setExcludeDays] = useState(10);
  const [maxContacts, setMaxContacts] = useState(250);
  const [maxAllowed, setMaxAllowed] = useState(250); // 500 for admins (server decides)
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [sendAt, setSendAt] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  // Type-to-find instead of scrolling ~100 clients — matches business name AND
  // owner first/last name (labels carry both: "Business — Owner Name").
  const [clientSearch, setClientSearch] = useState("");

  useEffect(() => {
    fetch("/api/blast").then((r) => r.json()).then((j) => {
      setClients(j.clients ?? []);
      setDefaultTemplate(j.defaultTemplate ?? "");
      setTemplate(j.defaultTemplate ?? "");
      if (Number(j.maxContactsAllowed) > 0) setMaxAllowed(Number(j.maxContactsAllowed));
    }).catch(() => {});
    loadJobs();
  }, []);

  const loadJobs = () => fetch("/api/blast?jobs=1").then((r) => r.json()).then((j) => setJobs(j.jobs ?? [])).catch(() => {});
  useEffect(() => {
    if (!jobs.some((j) => j.status === "sending" || j.status === "scheduled")) return;
    const t = setInterval(loadJobs, 10000);
    return () => clearInterval(t);
  }, [jobs]);

  const pickClient = useCallback((loc: string) => {
    const c = clients.find((x) => x.locationId === loc) ?? null;
    setClient(c); setPreview(null); setSelStages(new Set()); setStages([]); setClientTz(null);
    if (!c) return;
    setSenderName(c.senderFirstName);
    setServiceWord(c.serviceWord);
    setStagesLoading(true);
    fetch(`/api/blast?locationId=${c.locationId}`).then((r) => r.json())
      .then((j) => { setStages(j.stages ?? []); setClientTz(j.timezone ?? null); })
      .finally(() => setStagesLoading(false));
  }, [clients]);

  const toggleStage = (id: string) => {
    setPreview(null);
    setSelStages((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const loadPreview = useCallback(async () => {
    if (!client || selStages.size === 0) return;
    setPreviewLoading(true); setPreview(null);
    try {
      const r = await fetch(`/api/blast?locationId=${client.locationId}&stages=${[...selStages].join(",")}&excludeDays=${excludeDays}&maxContacts=${maxContacts}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      setPreview({ recipients: j.recipients ?? [], noPhone: j.noPhone ?? 0, eligible: j.eligible ?? (j.recipients ?? []).length, excludedRecent: j.excludedRecent ?? 0 });
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally {
      setPreviewLoading(false);
    }
  }, [client, selStages, excludeDays, maxContacts]);

  const sampleMessage = useMemo(() => {
    const first = preview?.recipients[0];
    return template
      .replaceAll("{{contact.first_name}}", first?.firstName || "Maria")
      .replaceAll("{{user.first_name}}", senderName || "…")
      .replaceAll("{{service}}", serviceWord || "…");
  }, [template, senderName, serviceWord, preview]);

  // Live check of the message — the same rule the API enforces, shown while
  // typing so a broken tag never reaches the Send button.
  const problem = useMemo(() => templateProblem(template), [template]);

  const schedule = useCallback(async () => {
    if (!client || !preview) return;
    setScheduling(true);
    try {
      const stageNames = stages.filter((s) => selStages.has(s.stage_id)).map((s) => s.stage_name);
      const r = await fetch("/api/blast", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule", locationId: client.locationId, ownerKey: client.ownerKey, clientLabel: client.label,
          senderName, serviceWord, stageIds: [...selStages], stageNames, template,
          sendAt: when === "later" && sendAt ? (clientTz ? zonedToIso(sendAt, clientTz) : new Date(sendAt).toISOString()) : undefined,
          timezone: clientTz ?? undefined,
          expectedCount: preview.recipients.length,
          excludeDays, maxContacts,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to schedule");
      toast.success(when === "now" ? `Blast queued — sending to ${j.total} people` : `Blast scheduled for ${sendAt.replace("T", " ")} ${tzCity(clientTz)} time`);
      setConfirmOpen(false); setChecked(false); setPreview(null); setSelStages(new Set());
      loadJobs();
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally {
      setScheduling(false);
    }
  }, [client, preview, senderName, serviceWord, template, when, sendAt, stages, selStages, excludeDays, maxContacts, clientTz]);

  // Reschedule flow: pick date+time, then confirm — nothing sends until then.
  const [reschedId, setReschedId] = useState<string | null>(null);
  const [openReplies, setOpenReplies] = useState<string | null>(null);
  const [reschedAt, setReschedAt] = useState("");
  // The message is editable here so the team can fix a typo (a broken tag)
  // and resend on their own — the Violet Zherka blast, 2026-10-12.
  const [reschedTemplate, setReschedTemplate] = useState("");
  const [reschedTz, setReschedTz] = useState<string | null>(null);
  const [reschedBusy, setReschedBusy] = useState(false);
  const reschedProblem = useMemo(() => templateProblem(reschedTemplate), [reschedTemplate]);
  const openResched = (j: Job) => {
    const d = new Date(Date.now() + 24 * 3600 * 1000); // default: tomorrow, same time
    d.setMinutes(0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    setReschedAt(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`);
    setReschedTemplate(j.message_template ?? "");
    setReschedTz(j.timezone ?? null);
    setReschedId(j.id);
  };
  const confirmResched = async () => {
    if (!reschedId || !reschedAt || reschedProblem || reschedBusy) return;
    setReschedBusy(true);
    try {
      const res = await fetch("/api/blast", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry", jobId: reschedId, sendAt: reschedTz ? zonedToIso(reschedAt, reschedTz) : new Date(reschedAt).toISOString(), template: reschedTemplate }) });
      const j = await res.json();
      if (!res.ok) { toast.error(j.error ?? "Reschedule failed"); return; }
      toast.success(`Rescheduled for ${reschedAt.replace("T", " ")} ${tzCity(reschedTz)} time — ${j.requeued} people will get it${j.skipped ? ` (${j.skipped} skipped: already got it, DND or unsubscribed)` : ""}`);
      setReschedId(null);
      loadJobs();
    } finally {
      setReschedBusy(false);
    }
  };
  const removeJob = async (id: string) => {
    if (!window.confirm("Remove this blast from the list? (Nothing is sent or unsent — it just deletes the record.)")) return;
    await fetch("/api/blast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove", jobId: id }) });
    loadJobs();
  };
  const cancelJob = async (id: string) => {
    await fetch("/api/blast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel", jobId: id }) });
    loadJobs();
  };

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6 space-y-4">
      <div>
        <h1 className="text-xl font-bold text-[#1f3559] flex items-center gap-2"><Megaphone size={18} className="text-[#15B7AE]" /> Text Blast</h1>
      </div>

      {/* 1. Client + message */}
      <div className="rounded-xl border border-[#e4ebf2] bg-white p-4 space-y-3">
        <label className="block text-xs font-bold text-[#34568a]">Client</label>
        {(() => {
          // Search results render as a CLICKABLE LIST, not a native <select> —
          // the phone select showed a stale, unfiltered option wheel.
          const q = clientSearch.trim().toLowerCase();
          const filtered = q ? clients.filter((c) => c.label.toLowerCase().includes(q)) : [];
          return (
            <div className="space-y-2">
              {client ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-[#a7e3df] bg-[#e6f7f5] px-3 py-2">
                  <span className="text-sm font-semibold text-[#0e8f88] truncate">{client.label}</span>
                  <button onClick={() => { pickClient(""); setClientSearch(""); }}
                    className="shrink-0 text-xs font-bold text-[#34568a] px-2 py-1 rounded-md border border-[#d7e0ea] bg-white">
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <input
                    value={clientSearch}
                    onChange={(e) => setClientSearch(e.target.value)}
                    placeholder="🔍 Search by business or client name…"
                    className="w-full text-sm border border-[#d7e0ea] rounded-lg px-3 py-2 bg-white text-[#1f3559]"
                  />
                  {q ? (
                    filtered.length ? (
                      <div className="rounded-lg border border-[#d7e0ea] divide-y divide-[#eef3f8] max-h-64 overflow-y-auto">
                        {filtered.slice(0, 30).map((c) => (
                          <button key={c.locationId} onClick={() => { pickClient(c.locationId); setClientSearch(""); }}
                            className="block w-full text-left px-3 py-2 text-sm text-[#1f3559] hover:bg-[#f0fbfa] active:bg-[#e6f7f5]">
                            {c.label}
                          </button>
                        ))}
                        {filtered.length > 30 && (
                          <div className="px-3 py-2 text-xs text-[#8595a8]">{filtered.length - 30} more — keep typing to narrow it down</div>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-[#8595a8] px-1">No client matches &ldquo;{clientSearch.trim()}&rdquo;.</p>
                    )
                  ) : (
                    <select value="" onChange={(e) => pickClient(e.target.value)}
                      className="w-full text-sm border border-[#d7e0ea] rounded-lg px-3 py-2 bg-white text-[#1f3559]">
                      <option value="">…or pick from the full list</option>
                      {clients.map((c) => <option key={c.locationId} value={c.locationId}>{c.label}</option>)}
                    </select>
                  )}
                </>
              )}
            </div>
          );
        })()}

        {client && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-[#34568a] mb-1">Sender name → {"{{user.first_name}}"}</label>
                <input value={senderName} onChange={(e) => setSenderName(e.target.value)}
                  className="w-full text-sm border border-[#d7e0ea] rounded-lg px-3 py-2 text-[#1f3559]" />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#34568a] mb-1">Service word → {"{{service}}"}</label>
                <input value={serviceWord} onChange={(e) => setServiceWord(e.target.value)}
                  className="w-full text-sm border border-[#d7e0ea] rounded-lg px-3 py-2 text-[#1f3559]" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-bold text-[#34568a] mb-1">Message</label>
              <textarea value={template} onChange={(e) => setTemplate(e.target.value)} rows={4}
                className="w-full text-sm border border-[#d7e0ea] rounded-lg px-3 py-2 text-[#1f3559] resize-y" />
              {problem && (
                <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] px-2.5 py-1.5">
                  <span className="text-[11px] font-semibold text-[#be123c]">⚠ {problem}</span>
                  <button onClick={() => setTemplate(autoFixTemplate(template))}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-[#f5c2cf] text-[10px] font-bold text-[#be123c] hover:bg-[#fff5f7]">
                    <Wrench size={10} /> Fix it
                  </button>
                </div>
              )}
              <div className="flex items-center justify-between mt-1">
                <p className="text-[10px] text-[#8595a8]">Placeholders: {"{{contact.first_name}}"} · {"{{user.first_name}}"} · {"{{service}}"}</p>
                <button onClick={() => setTemplate(defaultTemplate)} className="text-[10px] font-semibold text-[#0e8f88] hover:underline">Reset to default</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 2. Audience */}
      {client && (
        <div className="rounded-xl border border-[#e4ebf2] bg-white p-4 space-y-3">
          <label className="block text-xs font-bold text-[#34568a] flex items-center gap-1.5"><Users size={13} /> Audience — pipeline stages</label>
          {stagesLoading ? (
            <p className="text-xs text-[#8595a8] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Loading stages…</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {stages.map((s) => (
                <button key={s.stage_id} onClick={() => toggleStage(s.stage_id)}
                  className={cn("px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors",
                    selStages.has(s.stage_id)
                      ? "bg-[#15B7AE] border-[#15B7AE] text-white"
                      : "bg-white border-[#d7e0ea] text-[#34568a] hover:border-[#15B7AE]")}>
                  {s.stage_name}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[#34568a] mb-1">Skip anyone we engaged with in the last … days</label>
              <input type="number" min={0} max={90} value={excludeDays}
                onChange={(e) => { setExcludeDays(Math.max(0, Math.min(90, Number(e.target.value) || 0))); setPreview(null); }}
                className="w-full text-sm border border-[#d7e0ea] rounded-lg px-3 py-2 text-[#1f3559]" />
              <p className="text-[10px] text-[#8595a8] mt-0.5">Any message in the conversation (theirs or ours) counts as engagement.</p>
            </div>
            <div>
              <label className="block text-xs font-bold text-[#34568a] mb-1">Max contacts (up to {maxAllowed})</label>
              <input type="number" min={1} max={maxAllowed} value={maxContacts}
                onChange={(e) => { setMaxContacts(Math.max(1, Math.min(maxAllowed, Number(e.target.value) || 1))); setPreview(null); }}
                className="w-full text-sm border border-[#d7e0ea] rounded-lg px-3 py-2 text-[#1f3559]" />
              <p className="text-[10px] text-[#8595a8] mt-0.5">If more are eligible, the most recently engaged (outside the skip window) are kept.</p>
            </div>
          </div>
          <button onClick={loadPreview} disabled={selStages.size === 0 || previewLoading}
            className="px-3 py-2 rounded-lg bg-[#34568a] hover:bg-[#1f3559] text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
            {previewLoading ? <Loader2 size={13} className="animate-spin" /> : <Users size={13} />} Preview exact recipient list
          </button>
          <p className="text-[10px] text-[#8595a8]">Only contacts with a phone number are included (no-phone = IG bookings). Duplicated phones are sent once.</p>

          {preview && (
            <div className="rounded-lg border border-[#a7e3df] bg-[#f7fdfc] p-3 space-y-2">
              <p className="text-sm font-bold text-[#0e8f88]">
                {preview.recipients.length} recipients
                {preview.eligible > preview.recipients.length ? ` (capped from ${preview.eligible} eligible)` : ""}
                {preview.excludedRecent > 0 ? ` · ${preview.excludedRecent} skipped (engaged in last ${excludeDays}d)` : ""}
                {preview.noPhone > 0 ? ` · ${preview.noPhone} skipped (no phone)` : ""}
              </p>
              <div className="max-h-48 overflow-y-auto text-xs text-[#1f3559] space-y-0.5">
                {preview.recipients.map((r) => <div key={r.contactId}>{r.name} — {r.phone}</div>)}
              </div>
              <div className="rounded-lg border border-[#e4ebf2] bg-white p-2.5">
                <p className="text-[10px] font-bold uppercase text-[#8595a8] mb-1">Message preview (first recipient)</p>
                <p className="text-sm text-[#1f3559] whitespace-pre-wrap">{sampleMessage}</p>
              </div>
              <div className="flex items-center gap-3 pt-1">
                <label className="flex items-center gap-1.5 text-xs text-[#34568a]">
                  <input type="radio" checked={when === "now"} onChange={() => setWhen("now")} /> Send now
                </label>
                <label className="flex items-center gap-1.5 text-xs text-[#34568a]">
                  <input type="radio" checked={when === "later"} onChange={() => setWhen("later")} /> <Clock size={12} /> Schedule
                </label>
                {when === "later" && (
                  <>
                    <input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)}
                      className="text-xs border border-[#d7e0ea] rounded-lg px-2 py-1 text-[#1f3559]" />
                    <span className="text-[10px] font-semibold text-[#0e8f88]">🕒 {clientTz ? `client's time (${tzCity(clientTz)})` : "your computer's time — client zone unknown"}</span>
                  </>
                )}
              </div>
              <button onClick={() => setConfirmOpen(true)} disabled={preview.recipients.length === 0 || (when === "later" && !sendAt) || !!problem}
                title={problem ?? undefined}
                className="px-4 py-2 rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white text-sm font-bold flex items-center gap-1.5 disabled:opacity-50">
                <Send size={14} /> {when === "now" ? `Send to ${preview.recipients.length} people…` : `Schedule for ${preview.recipients.length} people…`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Confirm modal */}
      {confirmOpen && preview && client && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 space-y-3">
            <p className="text-sm font-bold text-[#1f3559] flex items-center gap-1.5"><AlertTriangle size={15} className="text-[#f0a742]" /> Confirm blast</p>
            <p className="text-sm text-[#34568a]">
              Send this text to <b>{preview.recipients.length} real clients</b> of <b>{client.label}</b>
              {when === "later" && sendAt ? <> at <b>{sendAt.replace("T", " ")} {tzCity(clientTz)} time</b>{clientTz ? <span className="text-[#697a91]"> ({fmtInTz(zonedToIso(sendAt, clientTz), undefined)} on your clock)</span> : null}</> : " right now"}?
            </p>
            <label className="flex items-start gap-2 text-xs text-[#34568a]">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5" />
              I looked through the recipient list and the message preview.
            </label>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setConfirmOpen(false); setChecked(false); }} className="px-3 py-2 rounded-lg border border-[#d7e0ea] text-xs font-semibold text-[#34568a]">Cancel</button>
              <button onClick={schedule} disabled={!checked || scheduling}
                className="px-4 py-2 rounded-lg bg-[#e11d48] hover:bg-[#be123c] text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50">
                {scheduling ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Yes — {when === "now" ? "send now" : "schedule it"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Jobs */}
      <div className="rounded-xl border border-[#e4ebf2] bg-white p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold text-[#34568a]">Blasts</p>
          <button onClick={loadJobs} className="p-1 rounded text-[#8595a8] hover:text-[#0e8f88]"><RefreshCw size={13} /></button>
        </div>
        {jobs.length === 0 ? <p className="text-xs text-[#8595a8]">No blasts yet.</p> : (
          <div className="space-y-2">
            {jobs.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#eef3f8] px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[#1f3559] truncate">{j.client_label ?? j.id}</p>
                  <p className="text-[10px] text-[#8595a8]">
                    {(j.stage_names ?? []).join(", ")} · {fmtInTz(j.send_at, j.timezone)} {j.timezone ? `${tzCity(j.timezone)} time` : "your time"}
                  </p>
                  {/* Results (owner 10/30/2026): delivered / failed / positive replies. */}
                  {(j.sent > 0 || j.failed > 0) && (
                    <p className="text-[11px] mt-0.5 flex flex-wrap gap-x-3">
                      <span className="font-semibold text-[#0e8f88]">✅ {j.sent} got it</span>
                      {j.failed > 0 && <span className="font-semibold text-[#be123c]">❌ {j.failed} failed</span>}
                      <span className="font-semibold text-[#4f46e5]" title="Interested replies only (want to book, ask price or times). STOP / not interested don't count. Checked every 30 min for 7 days.">
                        💬 {j.replies_positive ?? 0} positive {(j.replies_positive ?? 0) === 1 ? "reply" : "replies"}
                        {j.sent > 0 ? ` (${(((j.replies_positive ?? 0) / j.sent) * 100).toFixed(1)}%)` : ""}
                      </span>
                      {(j.positive_replies?.length ?? 0) > 0 && (
                        <button onClick={() => setOpenReplies((o) => (o === j.id ? null : j.id))} className="text-[#4f46e5] underline">
                          {openReplies === j.id ? "hide" : "see who"}
                        </button>
                      )}
                    </p>
                  )}
                  {openReplies === j.id && (
                    <ul className="mt-1 space-y-0.5">
                      {(j.positive_replies ?? []).map((r, i) => (
                        <li key={i} className="text-[11px] text-[#34568a]"><b>{r.name || "—"}</b>: {r.text}</li>
                      ))}
                    </ul>
                  )}
                  {/* Why it failed, in words — so the fix is obvious without asking. */}
                  {(j.fail_reasons?.length || j.error) && (
                    <p className="text-[10px] font-semibold text-[#be123c] mt-0.5">
                      {j.error ? `Stopped: ${j.error}` : (j.fail_reasons ?? []).map((r) => `${r.n} ${r.reason}`).join(" · ")}
                      {j.fail_reasons?.some((r) => r.reason === "broken tag in message") && " — fix the message below and resend"}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold",
                    j.status === "done" && j.failed > 0 ? "bg-[#fff7e6] text-[#c2620a]"
                      : j.status === "done" ? "bg-[#e6f7f5] text-[#0e8f88]"
                        : j.status === "sending" ? "bg-[#fff7e6] text-[#c2620a]"
                          : j.status === "cancelled" ? "bg-[#f1f5f9] text-[#8595a8]"
                            : j.status === "failed" || j.status === "error" ? "bg-[#fde8ee] text-[#e11d48]" : "bg-[#eef2ff] text-[#4f46e5]")}>
                    {j.status === "done" && j.failed > 0 ? "done, some failed" : j.status}
                  </span>
                  {(j.status === "scheduled" || j.status === "sending") && (
                    <button onClick={() => cancelJob(j.id)} title="Cancel" className="p-1 rounded text-[#8595a8] hover:text-[#e11d48]"><X size={13} /></button>
                  )}
                  {(j.status === "failed" || j.status === "error" || j.status === "cancelled" || (j.status === "done" && j.failed > 0)) && (
                    <button onClick={() => openResched(j)} title="Check or fix the message, pick a date & time, and send to everyone who hasn't received it"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-[#a7e3df] text-[#0e8f88] hover:bg-[#f7fdfc] text-[10px] font-semibold">
                      <Wrench size={10} /> Fix &amp; resend
                    </button>
                  )}
                  {!["scheduled", "sending"].includes(j.status) && (
                    <button onClick={() => removeJob(j.id)} title="Remove from the list" className="p-1 rounded text-[#8595a8] hover:text-[#e11d48]"><Trash2 size={13} /></button>
                  )}
                </div>
                {reschedId === j.id && (
                  <div className="w-full mt-2 space-y-2 rounded-lg border border-[#a7e3df] bg-[#f7fdfc] px-3 py-2.5">
                    <div>
                      <p className="text-[10px] font-bold text-[#0e8f88] mb-1">Message</p>
                      <textarea value={reschedTemplate} onChange={(e) => setReschedTemplate(e.target.value)} rows={4}
                        className={cn("w-full text-xs border rounded-lg px-2.5 py-2 text-[#1f3559] bg-white resize-y focus:outline-none",
                          reschedProblem ? "border-[#f5c2cf] focus:border-[#be123c]" : "border-[#a7e3df] focus:border-[#15B7AE]")} />
                      {reschedProblem ? (
                        <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] px-2.5 py-1.5">
                          <span className="text-[11px] font-semibold text-[#be123c]">⚠ {reschedProblem}</span>
                          <button onClick={() => setReschedTemplate(autoFixTemplate(reschedTemplate))}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-[#f5c2cf] text-[10px] font-bold text-[#be123c] hover:bg-[#fff5f7]">
                            <Wrench size={10} /> Fix it
                          </button>
                        </div>
                      ) : (
                        <p className="mt-1 text-[10px] text-[#0e8f88]">✓ Message looks good</p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] font-bold text-[#0e8f88]">Send on ({tzCity(reschedTz)} time):</span>
                      <input type="datetime-local" value={reschedAt} onChange={(e) => setReschedAt(e.target.value)}
                        className="px-2 py-1 bg-white border border-[#a7e3df] rounded text-xs text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
                      <button onClick={confirmResched} disabled={!reschedAt || !!reschedProblem || reschedBusy}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white text-[10px] font-bold disabled:opacity-50">
                        {reschedBusy ? <Loader2 size={10} className="animate-spin" /> : <Send size={10} />} Confirm
                      </button>
                      <button onClick={() => setReschedId(null)} className="px-2 py-1 rounded-lg text-[10px] font-semibold text-[#8595a8] hover:text-[#e11d48]">Cancel</button>
                      <span className="text-[9px] text-[#8595a8]">goes only to people who haven&apos;t received it · DND and unsubscribed numbers are skipped</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
