"use client";
import { useState, useCallback, useRef, useEffect } from "react";
import { Edit2, Save, X, MessageSquare, TrendingUp, ChevronDown, Clock, Copy, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge, statusVariant } from "@/components/ui/Badge";
import { GhlNotes } from "./GhlNotes";
import { StepTracker } from "./StepTracker";
import { ActivityTabs } from "./ActivityTabs";
import { formatCurrency, formatPercent, userColor, cn } from "@/lib/utils";
import type { ClientRecord, PaymentRecord, UserRole } from "@/lib/types";

interface ClientProfileProps {
  client: ClientRecord;
  role: UserRole | null;
  deposits: Record<string, unknown>[];
  bookings: Record<string, unknown>[];
  leads: Record<string, unknown>[];
  calls: Record<string, unknown>[];
  performance: Record<string, unknown>[];
  payment?: PaymentRecord | null;
  onUpdate?: (updated: ClientRecord) => void;
}

// Selectable client statuses (written back to the sheet's col_1).
const STATUS_OPTIONS = ["Live", "Paused", "Offboarded", "Lost"];
const VERSION_OPTIONS = ["(V3)", "(V2.3)", "(V1)", "Not Interested"];
const TEAM_OPTIONS = ["Francisco", "Stephanie", "Nicolas", "Dana", "Marie"];
function statusColors(s: string): { bg: string; color: string; border: string } {
  const u = s.toLowerCase();
  if (u === "live") return { bg: "#e6f7ee", color: "#15803d", border: "#86efac" };
  if (u === "paused") return { bg: "#fff7ec", color: "#d97706", border: "#fcd9a8" };
  if (u === "lost") return { bg: "#fde8ee", color: "#e11d48", border: "#f5c2cf" };
  return { bg: "#f1f5f9", color: "#64748b", border: "#d7e0ea" }; // offboarded / other
}

// Fields editable in the edit panel
// Edit Profile only changes the two name fields; everything else is changed via
// the inline dropdowns in the header.
const EDIT_FIELDS = [
  { key: "business_name",   label: "Business Name",     sheetKey: "Business Name" },
  { key: "owner_name",      label: "Owner Full Name",   sheetKey: "Owner Full Name" },
];

const GHL_LOCATION = process.env.NEXT_PUBLIC_GHL_LOCATION_ID ?? "SfpNMJ5YU9lBkxss47lK";

// Current GMT offset for a time zone, e.g. "GMT-5" (DST-aware for today's date).
function gmtOffset(tz: string): string | null {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = name.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
    if (!m) return name || null;
    const h = parseInt(m[1], 10);
    const min = m[2] && m[2] !== "00" ? `:${m[2]}` : "";
    return `GMT${h >= 0 ? "+" : ""}${h}${min}`;
  } catch {
    return null;
  }
}

export function ClientProfile({
  client, role, deposits, bookings, leads, calls, performance, payment, onUpdate,
}: ClientProfileProps) {
  const [localClient, setLocalClient] = useState<ClientRecord>(client);
  const [editMode, setEditMode] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const payRef = useRef<HTMLDivElement>(null);

  // Close the payment popover on outside click
  useEffect(() => {
    if (!showPayment) return;
    function onClick(e: MouseEvent) {
      if (payRef.current && !payRef.current.contains(e.target as Node)) setShowPayment(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showPayment]);

  const canEdit = role === "admin" || role === "editor";
  const ghlContactId = String(localClient._id2 ?? "");
  const ghlUrl = ghlContactId
    ? `https://app.gohighlevel.com/v2/location/${GHL_LOCATION}/contacts/detail/${ghlContactId}`
    : null;

  // Client's time zone (from GoHighLevel) + their current local time.
  const [tz, setTz] = useState<string | null>(null);
  useEffect(() => {
    setTz(null);
    if (!ghlContactId) return;
    let cancelled = false;
    fetch(`/api/ghl/contact/${ghlContactId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.timezone) setTz(d.timezone); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ghlContactId]);
  const tzTime = tz
    ? (() => { try { return new Date().toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }); } catch { return null; } })()
    : null;
  const tzOffset = tz ? gmtOffset(tz) : null;

  const rowNumber = Number(localClient._row_number ?? localClient.row_number ?? 0);

  const perfRecord = performance.find(
    (p) => String(p.client_name ?? "").toLowerCase() === String(localClient.business_name ?? "").toLowerCase()
  ) as Record<string, unknown> | undefined;

  // Price comes from the financing sheet's latest month (client_payments).
  // Fall back to the clients sheet "p" column if there's no payment record.
  const hasPayment = payment?.usd != null;
  const priceDisplay = hasPayment
    ? formatCurrency(String(payment!.usd))
    : formatCurrency(String(localClient.p ?? ""));

  // ── Edit panel ──────────────────────────────────────────────────────────
  function openEdit() {
    const vals: Record<string, string> = {};
    EDIT_FIELDS.forEach(({ key }) => { vals[key] = String(localClient[key] ?? ""); });
    setEditValues(vals);
    setEditMode(true);
  }

  const saveEdit = useCallback(async () => {
    if (!rowNumber) { toast.error("Row number missing — re-sync first"); return; }
    setSaving(true);

    // Build updated record merging both normalized keys and original sheet keys
    const updated: ClientRecord = { ...localClient };
    EDIT_FIELDS.forEach(({ key, sheetKey }) => {
      updated[key] = editValues[key];
      updated[sheetKey] = editValues[key];
    });
    // Keep col_1 in sync with status
    updated["col_1"] = editValues["status"] ?? updated["col_1"];

    setLocalClient(updated);
    setEditMode(false);

    try {
      const res = await fetch("/api/sync/clients_master", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber, rowData: updated, columns: EDIT_FIELDS.map((f) => f.sheetKey) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      if (json.sheetsUpdated) {
        toast.success("Saved — Supabase + Google Sheet updated ✓");
      } else if (json.sheetsError) {
        toast.success("Saved to dashboard (Sheets: " + json.sheetsError + ")");
      } else {
        toast.success("Saved to dashboard");
      }
      onUpdate?.(updated);
    } catch (e) {
      toast.error(`Save failed: ${e}`);
      setLocalClient(client);
    } finally {
      setSaving(false);
    }
  }, [rowNumber, localClient, editValues, client, onUpdate]);

  // ── Step tracker save ────────────────────────────────────────────────────
  const saveStep = useCallback(async (stepIndex: number, key: string, value: boolean | string) => {
    if (!rowNumber) { toast.error("Row number missing — re-sync first"); return; }
    // key is the actual field name e.g. "Launch Call", "A2P Verified" etc.
    const updated: ClientRecord = {
      ...localClient,
      [key]: value,
    };
    setLocalClient(updated);
    try {
      const res = await fetch("/api/sync/clients_master", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber, rowData: updated, columns: [key] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      const msg = typeof value === "boolean"
        ? `${key} ${value ? "checked" : "unchecked"}`
        : `${key} updated`;
      toast.success(msg);
      onUpdate?.(updated);
    } catch (e) {
      toast.error(`Failed: ${e}`);
      setLocalClient(client);
    }
  }, [rowNumber, localClient, client, onUpdate]);

  // ── Quick status change (writes col_1 back to the sheet) ──────────────────
  const [statusSaving, setStatusSaving] = useState(false);
  const saveStatus = useCallback(async (newStatus: string) => {
    if (!rowNumber) { toast.error("Row number missing — re-sync first"); return; }
    if (newStatus === String(localClient.status ?? "")) return;
    const updated: ClientRecord = { ...localClient, status: newStatus, col_1: newStatus };
    setLocalClient(updated);
    setStatusSaving(true);
    try {
      const res = await fetch("/api/sync/clients_master", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber, rowData: updated, columns: ["col_1"] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      toast.success(json.sheetsUpdated ? `Status → ${newStatus} — Sheet updated ✓` : `Status → ${newStatus}`);
      onUpdate?.(updated);
    } catch (e) {
      toast.error(`Status save failed: ${e}`);
      setLocalClient(client);
    } finally {
      setStatusSaving(false);
    }
  }, [rowNumber, localClient, client, onUpdate]);

  // ── Quick version change (writes "Version" back to the sheet) ─────────────
  const [versionSaving, setVersionSaving] = useState(false);
  const saveVersion = useCallback(async (newVersion: string) => {
    if (!rowNumber) { toast.error("Row number missing — re-sync first"); return; }
    if (newVersion === String(localClient.version ?? "")) return;
    const updated: ClientRecord = { ...localClient, version: newVersion, Version: newVersion };
    setLocalClient(updated);
    setVersionSaving(true);
    try {
      const res = await fetch("/api/sync/clients_master", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber, rowData: updated, columns: ["Version"] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      toast.success(json.sheetsUpdated ? `Version → ${newVersion} — Sheet updated ✓` : `Version → ${newVersion}`);
      onUpdate?.(updated);
    } catch (e) {
      toast.error(`Version save failed: ${e}`);
      setLocalClient(client);
    } finally {
      setVersionSaving(false);
    }
  }, [rowNumber, localClient, client, onUpdate]);

  // ── Quick assign change (Assigned / Media Buyer) — writes that one column ──────
  const [assignSaving, setAssignSaving] = useState<string | null>(null);
  const saveTeam = useCallback(async (normKey: "assigned" | "media_buyer", sheetKey: string, value: string) => {
    if (!rowNumber) { toast.error("Row number missing — re-sync first"); return; }
    if (value === String(localClient[normKey] ?? "")) return;
    const updated: ClientRecord = { ...localClient, [normKey]: value, [sheetKey]: value };
    setLocalClient(updated);
    setAssignSaving(sheetKey);
    try {
      const res = await fetch("/api/sync/clients_master", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber, rowData: updated, columns: [sheetKey] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      toast.success(json.sheetsUpdated ? `${sheetKey} → ${value || "—"} — Sheet updated ✓` : `${sheetKey} → ${value || "—"}`);
      onUpdate?.(updated);
    } catch (e) {
      toast.error(`${sheetKey} save failed: ${e}`);
      setLocalClient(client);
    } finally {
      setAssignSaving(null);
    }
  }, [rowNumber, localClient, client, onUpdate]);

  // ── Detail box save (one column at a time, field-scoped write-back) ────────
  const [detailSaving, setDetailSaving] = useState<string | null>(null);
  const saveDetail = useCallback(async (sheetKey: string, value: string) => {
    if (!rowNumber) { toast.error("Row number missing — re-sync first"); return; }
    if (value === String((localClient as Record<string, unknown>)[sheetKey] ?? "")) return;
    const updated: ClientRecord = { ...localClient, [sheetKey]: value };
    // Keep the normalized keys used elsewhere (header, notes) in sync.
    const alias = DETAIL_ALIAS[sheetKey];
    if (alias) updated[alias] = value;
    setLocalClient(updated);
    setDetailSaving(sheetKey);
    try {
      const res = await fetch("/api/sync/clients_master", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber, rowData: updated, columns: [sheetKey] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      toast.success(json.sheetsUpdated ? `${sheetKey} updated — Sheet ✓` : `${sheetKey} updated`);
      onUpdate?.(updated);
    } catch (e) {
      toast.error(`${sheetKey} save failed: ${e}`);
      setLocalClient(client);
    } finally {
      setDetailSaving(null);
    }
  }, [rowNumber, localClient, client, onUpdate]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="h-full overflow-y-auto">
      {/* ── Header ── */}
      <div className="sticky top-0 z-10 px-6 pt-5 pb-4 border-b border-[#e4ebf2] bg-[#eef2f7]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-bold text-[#1f3559] truncate">{localClient.business_name || "—"}</h2>
              {localClient.business_name && <CopyButton value={String(localClient.business_name)} title="Copy business name" />}
              {tz && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#e6f7f5] text-[#0e8f88] border border-[#a7e3df] whitespace-nowrap"
                  title={`Client time zone (from GoHighLevel): ${tz}`}>
                  <Clock size={11} />
                  {tz.split("/").pop()?.replace(/_/g, " ")}{tzOffset ? ` (${tzOffset})` : ""}{tzTime ? ` · ${tzTime} local` : ""}
                </span>
              )}
            </div>
            <p className="text-sm text-[#697a91] mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span className="truncate">{localClient.owner_name || "—"}</span>
              {localClient.owner_name && <CopyButton value={String(localClient.owner_name)} title="Copy client full name" />}
              {localClient.ad_account_name && <span className="text-[#8595a8] truncate">· {String(localClient.ad_account_name)}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {ghlUrl && (
              <a href={ghlUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#e6f7f5] text-[#0e8f88] border border-[#a7e3df] hover:bg-[#e6f7f5] transition-colors">
                <MessageSquare size={12} /> Click To Chat
              </a>
            )}
            {canEdit && !editMode && (
              <button onClick={openEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#e4ebf2] hover:bg-[#dbe5ef] text-[#1e2a3a] border border-[#d7e0ea] transition-colors">
                <Edit2 size={12} /> Edit Profile
              </button>
            )}
            {canEdit && editMode && (
              <>
                <button onClick={saveEdit} disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-[#1f3559] transition-colors disabled:opacity-60"
                  style={{ background: "#15B7AE" }}>
                  <Save size={12} /> {saving ? "Saving…" : "Save All"}
                </button>
                <button onClick={() => setEditMode(false)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#e4ebf2] hover:bg-[#dbe5ef] text-[#34568a] border border-[#d7e0ea] transition-colors">
                  <X size={12} /> Cancel
                </button>
              </>
            )}
          </div>
        </div>

        {/* Status badges row — or edit panel */}
        {editMode ? (
          <div className="mt-4 grid grid-cols-2 gap-3">
            {EDIT_FIELDS.map(({ key, label }) => (
              <div key={key}>
                <label className="block text-xs text-[#697a91] mb-1">{label}</label>
                {key === "notes" ? (
                  <textarea rows={2} value={editValues[key] ?? ""}
                    onChange={(e) => setEditValues((v) => ({ ...v, [key]: e.target.value }))}
                    className="w-full px-3 py-2 bg-white border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE] resize-none col-span-2" />
                ) : (
                  <input type="text" value={editValues[key] ?? ""}
                    onChange={(e) => setEditValues((v) => ({ ...v, [key]: e.target.value }))}
                    className="w-full px-3 py-2 bg-white border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {canEdit ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="text-xs text-[#697a91]">Status:</span>
                {(() => { const c = statusColors(String(localClient.status ?? "")); return (
                  <select
                    value={STATUS_OPTIONS.includes(String(localClient.status ?? "")) ? String(localClient.status ?? "") : ""}
                    onChange={(e) => saveStatus(e.target.value)}
                    disabled={statusSaving}
                    title="Change status — writes back to the Google Sheet"
                    className="px-2 py-1 rounded-md text-xs font-bold border cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#15B7AE]/30 disabled:opacity-60"
                    style={{ background: c.bg, color: c.color, borderColor: c.border }}
                  >
                    {!STATUS_OPTIONS.includes(String(localClient.status ?? "")) && (
                      <option value="">{localClient.status || "—"}</option>
                    )}
                    {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                ); })()}
              </span>
            ) : (
              <Badge variant={statusVariant(String(localClient.status ?? ""))}>
                Status: <strong className="ml-1">{localClient.status || "—"}</strong>
              </Badge>
            )}
            {canEdit ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="text-xs text-[#697a91]">Version:</span>
                <select
                  value={VERSION_OPTIONS.includes(String(localClient.version ?? "")) ? String(localClient.version ?? "") : ""}
                  onChange={(e) => saveVersion(e.target.value)}
                  disabled={versionSaving}
                  title="Change version — writes back to the Google Sheet"
                  className="px-2 py-1 rounded-md text-xs font-bold border border-[#d7e0ea] bg-white text-[#34568a] cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#15B7AE]/30 disabled:opacity-60"
                >
                  {!VERSION_OPTIONS.includes(String(localClient.version ?? "")) && (
                    <option value="" disabled>{localClient.version || "—"}</option>
                  )}
                  {VERSION_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </span>
            ) : (
              <Badge variant="gray">Version: <strong className="ml-1">{localClient.version || "—"}</strong></Badge>
            )}
            {canEdit ? (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-xs text-[#697a91]">Assigned:</span>
                  <select
                    value={String(localClient.assigned ?? "")}
                    onChange={(e) => saveTeam("assigned", "Assigned", e.target.value)}
                    disabled={assignSaving === "Assigned"}
                    title="Assign a user — writes back to the Google Sheet"
                    className="px-2 py-1 rounded-md text-xs font-bold border border-[#d7e0ea] bg-white text-[#34568a] cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#15B7AE]/30 disabled:opacity-60"
                  >
                    <option value="">—</option>
                    {localClient.assigned && !TEAM_OPTIONS.includes(String(localClient.assigned)) && <option value={String(localClient.assigned)}>{String(localClient.assigned)}</option>}
                    {TEAM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-xs text-[#697a91]">Media Buyer:</span>
                  <select
                    value={String(localClient.media_buyer ?? "")}
                    onChange={(e) => saveTeam("media_buyer", "Media Buyer", e.target.value)}
                    disabled={assignSaving === "Media Buyer"}
                    title="Assign a media buyer — writes back to the Google Sheet"
                    className="px-2 py-1 rounded-md text-xs font-bold border border-[#d7e0ea] bg-white text-[#34568a] cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#15B7AE]/30 disabled:opacity-60"
                  >
                    <option value="">—</option>
                    {localClient.media_buyer && !TEAM_OPTIONS.includes(String(localClient.media_buyer)) && <option value={String(localClient.media_buyer)}>{String(localClient.media_buyer)}</option>}
                    {TEAM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </span>
              </>
            ) : (
              <>
                <Badge variant="gray">Assigned: <strong className="ml-1">{localClient.assigned || "—"}</strong></Badge>
                <Badge variant="gray">Media Buyer: <strong className="ml-1">{localClient.media_buyer || "—"}</strong></Badge>
              </>
            )}
            <Badge variant="gray">Campaign: <strong className="ml-1">{localClient.campaign_status || "—"}</strong></Badge>
            {payment ? (
              <div className="relative" ref={payRef}>
                <button
                  type="button"
                  onClick={() => setShowPayment((s) => !s)}
                  className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df] hover:bg-[#d4f1ee] transition-colors cursor-pointer"
                >
                  Price: <strong className="ml-1">{priceDisplay}</strong>
                  {payment.month && <span className="ml-1 font-normal opacity-70">({payment.month})</span>}
                  <ChevronDown size={12} className={`ml-1 transition-transform ${showPayment ? "rotate-180" : ""}`} />
                </button>

                {showPayment && (
                  <div className="absolute left-0 top-full mt-2 z-30 w-72 bg-white border border-[#e4ebf2] rounded-xl p-3 text-left"
                    style={{ boxShadow: "var(--shadow-md)" }}>
                    <p className="text-xs font-semibold text-[#34568a] mb-2">
                      Payment{payment.month ? ` — ${payment.month}` : ""}
                    </p>
                    <div className="space-y-1.5 text-xs">
                      <PayRow label="Status">
                        <span className={`font-semibold ${paymentStatusColor(payment.payment_status)}`}>
                          {payment.payment_status || "—"}
                        </span>
                      </PayRow>
                      <PayRow label="Date of Payment">{payment.pay_day || "—"}</PayRow>
                      <PayRow label="Billing">{payment.billing_status || "—"}</PayRow>
                    </div>
                    <div className="mt-2 pt-2 border-t border-[#eef3f8]">
                      <p className="text-xs text-[#697a91] mb-1">Notes</p>
                      <p className="text-xs text-[#34568a] whitespace-pre-line">
                        {payment.notes && payment.notes.trim()
                          ? payment.notes
                          : <span className="text-[#a6b3c4]">No payment notes</span>}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <Badge variant="teal">Price: <strong className="ml-1">{priceDisplay}</strong></Badge>
            )}
            <UserChip label="Assigned" name={String(localClient.assigned ?? "")} />
            <UserChip label="Media Buyer" name={String(localClient.media_buyer ?? "")} />
            {(() => {
              const v = String(localClient.version ?? "");
              const vs = versionStyle(v);
              return (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border"
                  style={{ background: vs.bg, color: vs.text, borderColor: vs.border }}>
                  Version: <strong className="ml-1">{v || "—"}</strong>
                </span>
              );
            })()}
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="px-6 py-4 space-y-5">

        {/* GHL Notes (top) */}
        {ghlContactId && <GhlNotes contactId={ghlContactId} />}

        {/* Activity */}
        <Section icon={null} title="Activity — Deposits, Bookings, Leads & Calls">
          <ActivityTabs
            clientName={String(localClient.business_name ?? "")}
            deposits={deposits}
            bookings={bookings}
            leads={leads}
            calls={calls}
          />
        </Section>

        {/* Performance stats */}
        {perfRecord && (
          <Section icon={<TrendingUp size={14} />} title="Performance">
            <div className="grid grid-cols-3 gap-3 mb-3">
              <StatCard label="Daily Budget" value={formatCurrency(String(perfRecord.daily_budget ?? ""))} />
              <StatCard label="Booking %" value={formatPercent(perfRecord.booking_pct as string | number | null | undefined)} />
              <StatCard label="Total Leads" value={String(perfRecord.leads ?? "—")} />
            </div>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: "3-Day", val: perfRecord.leads_3day },
                { label: "7-Day", val: perfRecord.leads_7day },
                { label: "14-Day", val: perfRecord.leads_14day },
                { label: "30-Day", val: perfRecord.leads_30day },
              ].map(({ label, val }) => (
                <div key={label} className="bg-[#f1f5f9] rounded-lg px-2 py-2 text-center">
                  <p className="text-sm font-semibold text-[#0e8f88]">{String(val ?? "—")}</p>
                  <p className="text-xs text-[#8595a8]">{label} Leads</p>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* 7-Step tracker */}
        <Section icon={null} title="">
          <StepTracker
            data={(localClient as Record<string, unknown>)}
            canEdit={canEdit}
            onChange={(i, key, val) => saveStep(i, key, val)}
          />
        </Section>

        {/* All business & client details from the Master Sheet */}
        <ClientDetails client={localClient} canEdit={canEdit} onSave={saveDetail} savingKey={detailSaving} />

        {/* Notes */}
        {localClient.notes && String(localClient.notes).trim() && (
          <Section icon={null} title="Notes">
            <p className="text-sm text-[#34568a] whitespace-pre-line">{String(localClient.notes)}</p>
          </Section>
        )}

      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="border border-[#e4ebf2] rounded-xl p-4 bg-white">
      {title && (
        <h3 className="text-sm font-semibold text-[#34568a] mb-3 flex items-center gap-2">
          {icon}
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

function UserChip({ label, name }: { label: string; name: string }) {
  const c = userColor(name);
  const style = c
    ? { background: c.bg, color: c.text, borderColor: c.border }
    : { background: "#f1f5f9", color: "#64748b", borderColor: "#d7e0ea" };
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border"
      style={style}
    >
      {label}: <strong className="ml-1">{name || "—"}</strong>
    </span>
  );
}

function PayRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[#697a91]">{label}</span>
      <span className="text-[#1f3559] text-right">{children}</span>
    </div>
  );
}

// The exact sheet columns shown in the details box, in order.
const DETAIL_FIELDS: { key: string; label: string }[] = [
  { key: "Owner Full Name", label: "Owner Full Name" },
  { key: "Ad account Name", label: "Ad Account Name" },
  { key: "Business Name", label: "Business Name" },
  { key: "Original Price", label: "Original Price" },
  { key: "Discounted Price", label: "Discounted Price" },
  { key: "PMU Services", label: "PMU Services" },
  { key: "Campaign Type", label: "Campaign Type" },
  { key: "Offer", label: "Offer" },
  { key: "Email", label: "Email" },
  { key: "Phone", label: "Phone" },
  { key: "Generate New Business Number?", label: "Generate New Business Number?" },
  { key: "Location (Full adress)", label: "Location (Full Address)" },
  { key: "FB Page link", label: "FB Page Link" },
  { key: "Content Source", label: "Content Source" },
  { key: "Languages", label: "Languages" },
  { key: "Ad Spent", label: "Ad Spent" },
  { key: "IG Page link", label: "IG Page Link" },
  { key: "IG Followers", label: "IG Followers" },
  { key: "Notes", label: "Notes" },
  { key: "Want V3?", label: "Want V3?" },
];

// Detail-box sheet keys that also have a normalized alias used elsewhere in the
// profile (header, notes), so an edit keeps both in sync.
const DETAIL_ALIAS: Record<string, string> = {
  "Business Name": "business_name",
  "Owner Full Name": "owner_name",
  "Ad account Name": "ad_account_name",
  "Email": "email",
  "Phone": "phone",
  "Notes": "notes",
};

// Fields that get a multi-line textarea (full width) when editing.
const DETAIL_LONG_KEYS = new Set(["Notes", "Offer", "PMU Services", "Location (Full adress)"]);
// Fields edited as a Yes/No toggle (stored as TRUE/FALSE in the sheet).
const DETAIL_BOOL_KEYS = new Set(["Generate New Business Number?"]);

function boolToSelect(v: unknown): "Yes" | "No" | "" {
  const s = String(v).toLowerCase();
  if (v === true || s === "true" || s === "yes") return "Yes";
  if (v === false || s === "false" || s === "no") return "No";
  return "";
}

function isEmptyVal(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === "";
}

function DetailValue({ value }: { value: unknown }) {
  const s = String(value).trim();
  if (value === true || s === "true" || s === "TRUE") return <p className="text-sm text-[#0e8f88] font-medium">Yes</p>;
  if (value === false || s === "false" || s === "FALSE") return <p className="text-sm text-[#697a91]">No</p>;
  if (/^https?:\/\//i.test(s)) {
    return (
      <a href={s} target="_blank" rel="noopener noreferrer" className="text-sm text-[#0e8f88] underline break-all">
        {s}
      </a>
    );
  }
  return <p className="text-sm text-[#1f3559] break-words whitespace-pre-line">{s}</p>;
}

function ClientDetails({
  client, canEdit, onSave, savingKey,
}: {
  client: ClientRecord;
  canEdit: boolean;
  onSave: (sheetKey: string, value: string) => void;
  savingKey: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const data = client as Record<string, unknown>;

  // Read mode: only non-empty fields. Edit mode: all fields, so blanks (e.g. a
  // missing address) can be filled in.
  const readEntries = DETAIL_FIELDS
    .map((f) => ({ key: f.key, label: f.label, value: data[f.key] }))
    .filter((f) => !isEmptyVal(f.value));
  if (!editing && readEntries.length === 0 && !canEdit) return null;

  return (
    <div className="border border-[#e4ebf2] rounded-xl bg-white">
      <div className="w-full flex items-center justify-between px-4 py-3 gap-2">
        <button onClick={() => setOpen((o) => !o)} className="flex-1 min-w-0 text-left">
          <h3 className="text-sm font-semibold text-[#34568a]">
            Business &amp; client details — captured at onboarding signup
            <span className="ml-2 text-xs font-normal text-[#8595a8]">({editing ? DETAIL_FIELDS.length : readEntries.length})</span>
            <span className="block text-[11px] font-normal text-[#8595a8]">
              {editing ? "Editing — changes save automatically to the Google Sheet." : "These are the original sign-up details; the offer may change later."}
            </span>
          </h3>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {canEdit && open && (
            <button onClick={() => setEditing((e) => !e)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-[#e4ebf2] hover:bg-[#dbe5ef] text-[#1e2a3a] border border-[#d7e0ea] transition-colors">
              {editing ? <><Check size={12} /> Done</> : <><Edit2 size={12} /> Edit</>}
            </button>
          )}
          <button onClick={() => setOpen((o) => !o)} aria-label="Toggle details">
            <ChevronDown size={16} className={`text-[#697a91] transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>
      {open && (editing ? (
        <div className="px-4 pb-4 grid grid-cols-2 gap-x-4 gap-y-3">
          {DETAIL_FIELDS.map((f) => (
            <DetailEditField key={f.key} fieldKey={f.key} label={f.label}
              value={String(data[f.key] ?? "")}
              saving={savingKey === f.key} onSave={(v) => onSave(f.key, v)} />
          ))}
        </div>
      ) : readEntries.length === 0 ? (
        <div className="px-4 pb-4 text-sm text-[#8595a8]">No details captured yet — click <strong>Edit</strong> to add them.</div>
      ) : (
        <div className="px-4 pb-4 grid grid-cols-2 gap-x-4 gap-y-3">
          {readEntries.map((f) => (
            <div key={f.key} className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-[#8595a8]">{f.label}</p>
              <DetailValue value={f.value} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function DetailEditField({
  fieldKey, label, value, saving, onSave,
}: {
  fieldKey: string;
  label: string;
  value: string;
  saving: boolean;
  onSave: (value: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);

  const isLong = DETAIL_LONG_KEYS.has(fieldKey);
  const isBool = DETAIL_BOOL_KEYS.has(fieldKey);
  const commit = () => { if (v !== value) onSave(v); };
  const inputCls = "w-full px-2.5 py-1.5 bg-white border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]";

  return (
    <div className={cn("min-w-0", isLong && "col-span-2")}>
      <label className="text-[11px] uppercase tracking-wide text-[#8595a8] flex items-center gap-1.5 mb-0.5">
        {label}
        {saving && <Loader2 size={11} className="animate-spin text-[#94a3b8]" />}
      </label>
      {isBool ? (
        <select value={boolToSelect(v)}
          onChange={(e) => { const sel = e.target.value; const out = sel === "Yes" ? "TRUE" : sel === "No" ? "FALSE" : ""; setV(out); onSave(out); }}
          className={inputCls}>
          <option value="">—</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      ) : isLong ? (
        <textarea rows={2} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit}
          className={cn(inputCls, "resize-y")} />
      ) : (
        <input type="text" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit}
          className={inputCls} />
      )}
    </div>
  );
}

function versionStyle(v: string): { bg: string; text: string; border: string } {
  const u = v.toLowerCase();
  if (u.includes("not interested")) return { bg: "#fde8ee", text: "#e11d48", border: "#f5c2cf" };
  if (u.includes("v2.3") || u.includes("v2.2")) return { bg: "#f3e8ff", text: "#7e22ce", border: "#e3cffb" }; // purple
  if (u.includes("v3")) return { bg: "#1d4ed8", text: "#ffffff", border: "#1d4ed8" }; // blue
  if (u.includes("v2")) return { bg: "#dcf5e0", text: "#15803d", border: "#bce6c8" }; // green
  return { bg: "#f1f5f9", text: "#64748b", border: "#d7e0ea" }; // V1 / other / empty
}

function paymentStatusColor(status: string | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s.includes("paid")) return "text-[#0e8f88]";
  if (s.includes("pending") || s.includes("grace")) return "text-[#d97706]";
  if (s.includes("attention") || s.includes("overdue") || s.includes("late")) return "text-[#e11d48]";
  return "text-[#1f3559]";
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#f1f5f9] rounded-lg p-3 text-center">
      <p className="text-lg font-bold text-[#1f3559]">{value}</p>
      <p className="text-xs text-[#697a91] mt-0.5">{label}</p>
    </div>
  );
}

// Small inline "copy to clipboard" button with a brief check confirmation.
function CopyButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Copied");
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Couldn't copy");
    }
  };
  return (
    <button type="button" onClick={copy} title={title}
      className="inline-flex items-center justify-center w-5 h-5 rounded text-[#94a3b8] hover:text-[#0e8f88] hover:bg-[#e6f7f5] transition-colors flex-shrink-0">
      {copied ? <Check size={12} className="text-[#0e8f88]" /> : <Copy size={12} />}
    </button>
  );
}
