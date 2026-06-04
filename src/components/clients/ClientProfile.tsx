"use client";
import { useState, useCallback } from "react";
import { Edit2, Save, X, MessageSquare, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { Badge, statusVariant } from "@/components/ui/Badge";
import { GhlNotes } from "./GhlNotes";
import { StepTracker } from "./StepTracker";
import { ActivityTabs } from "./ActivityTabs";
import { formatCurrency, formatPercent } from "@/lib/utils";
import type { ClientRecord, UserRole } from "@/lib/types";

interface ClientProfileProps {
  client: ClientRecord;
  role: UserRole | null;
  deposits: Record<string, unknown>[];
  bookings: Record<string, unknown>[];
  leads: Record<string, unknown>[];
  calls: Record<string, unknown>[];
  performance: Record<string, unknown>[];
  onUpdate?: (updated: ClientRecord) => void;
}

// Fields editable in the edit panel
const EDIT_FIELDS = [
  { key: "status",          label: "Status",           sheetKey: "col_1" },
  { key: "campaign_status", label: "Campaign Status",   sheetKey: "Campaign Status" },
  { key: "p",               label: "Monthly Price",     sheetKey: "p" },
  { key: "assigned",        label: "Assigned To",       sheetKey: "Assigned" },
  { key: "media_buyer",     label: "Media Buyer",       sheetKey: "Media Buyer" },
  { key: "version",         label: "Version",           sheetKey: "Version" },
  { key: "notes",           label: "Notes",             sheetKey: "Notes" },
];

const GHL_LOCATION = process.env.NEXT_PUBLIC_GHL_LOCATION_ID ?? "SfpNMJ5YU9lBkxss47lK";

export function ClientProfile({
  client, role, deposits, bookings, leads, calls, performance, onUpdate,
}: ClientProfileProps) {
  const [localClient, setLocalClient] = useState<ClientRecord>(client);
  const [editMode, setEditMode] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const canEdit = role === "admin" || role === "editor";
  const ghlContactId = String(localClient._id2 ?? "");
  const ghlUrl = ghlContactId
    ? `https://app.gohighlevel.com/v2/location/${GHL_LOCATION}/contacts/detail/${ghlContactId}`
    : null;

  const rowNumber = Number(localClient._row_number ?? localClient.row_number ?? 0);

  const perfRecord = performance.find(
    (p) => String(p.client_name ?? "").toLowerCase() === String(localClient.business_name ?? "").toLowerCase()
  ) as Record<string, unknown> | undefined;

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
        body: JSON.stringify({ rowNumber, rowData: updated }),
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
  const saveStep = useCallback(async (stepIndex: number, key: string, value: boolean) => {
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
        body: JSON.stringify({ rowNumber, rowData: updated }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      toast.success(`Step ${stepIndex + 1} ${value ? "checked" : "unchecked"}`);
      onUpdate?.(updated);
    } catch (e) {
      toast.error(`Failed: ${e}`);
      setLocalClient(client);
    }
  }, [rowNumber, localClient, client, onUpdate]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="h-full overflow-y-auto">
      {/* ── Header ── */}
      <div className="sticky top-0 z-10 px-6 pt-5 pb-4 border-b border-slate-700 bg-slate-900">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-white truncate">{localClient.business_name || "—"}</h2>
            <p className="text-sm text-slate-400 mt-0.5 truncate">
              {localClient.owner_name || "—"}
              {localClient.ad_account_name && <> · <span className="text-slate-500">{String(localClient.ad_account_name)}</span></>}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {ghlUrl && (
              <a href={ghlUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-teal-900/40 text-teal-300 border border-teal-700 hover:bg-teal-800/50 transition-colors">
                <MessageSquare size={12} /> GHL
              </a>
            )}
            {canEdit && !editMode && (
              <button onClick={openEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600 transition-colors">
                <Edit2 size={12} /> Edit Profile
              </button>
            )}
            {canEdit && editMode && (
              <>
                <button onClick={saveEdit} disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-60"
                  style={{ background: "#00B4A6" }}>
                  <Save size={12} /> {saving ? "Saving…" : "Save All"}
                </button>
                <button onClick={() => setEditMode(false)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600 transition-colors">
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
                <label className="block text-xs text-slate-400 mb-1">{label}</label>
                {key === "notes" ? (
                  <textarea rows={2} value={editValues[key] ?? ""}
                    onChange={(e) => setEditValues((v) => ({ ...v, [key]: e.target.value }))}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:border-teal-500 resize-none col-span-2" />
                ) : (
                  <input type="text" value={editValues[key] ?? ""}
                    onChange={(e) => setEditValues((v) => ({ ...v, [key]: e.target.value }))}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:border-teal-500" />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 mt-3">
            <Badge variant={statusVariant(String(localClient.status ?? ""))}>
              Status: <strong className="ml-1">{localClient.status || "—"}</strong>
            </Badge>
            <Badge variant="gray">Campaign: <strong className="ml-1">{localClient.campaign_status || "—"}</strong></Badge>
            <Badge variant="teal">Price: <strong className="ml-1">{formatCurrency(String(localClient.p ?? ""))}</strong></Badge>
            <Badge variant="blue">Assigned: <strong className="ml-1">{localClient.assigned || "—"}</strong></Badge>
            <Badge variant="gray">Media Buyer: <strong className="ml-1">{localClient.media_buyer || "—"}</strong></Badge>
            <Badge variant="gray">v: <strong className="ml-1">{localClient.version || "—"}</strong></Badge>
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="px-6 py-4 space-y-5">

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
                <div key={label} className="bg-slate-900/60 rounded-lg px-2 py-2 text-center">
                  <p className="text-sm font-semibold text-teal-300">{String(val ?? "—")}</p>
                  <p className="text-xs text-slate-500">{label} Leads</p>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* GHL Notes */}
        {ghlContactId && <GhlNotes contactId={ghlContactId} />}

        {/* 7-Step tracker */}
        <Section icon={null} title="">
          <StepTracker
            data={(localClient as Record<string, unknown>)}
            canEdit={canEdit}
            onChange={(i, key, val) => saveStep(i, key, val)}
          />
        </Section>

        {/* Notes */}
        {localClient.notes && String(localClient.notes).trim() && (
          <Section icon={null} title="Notes">
            <p className="text-sm text-slate-300 whitespace-pre-line">{String(localClient.notes)}</p>
          </Section>
        )}

        {/* Activity */}
        <Section icon={null} title="Activity">
          <ActivityTabs
            clientName={String(localClient.business_name ?? "")}
            deposits={deposits}
            bookings={bookings}
            leads={leads}
            calls={calls}
          />
        </Section>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="border border-slate-700 rounded-xl p-4 bg-slate-800/20">
      {title && (
        <h3 className="text-sm font-semibold text-slate-300 mb-3 flex items-center gap-2">
          {icon}
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900/70 rounded-lg p-3 text-center">
      <p className="text-lg font-bold text-white">{value}</p>
      <p className="text-xs text-slate-400 mt-0.5">{label}</p>
    </div>
  );
}
