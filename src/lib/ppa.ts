import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { normalizeOwnerKey } from "@/lib/normalizers";

// ── V3 Pay-Per-Appointment billing helpers ───────────────────────────────────
// Reads only (clients_master, ghl_opportunities, deposits, stage cache);
// writes go to the dashboard-only tables ppa_config / ppa_charges. Nothing
// here ever touches Google Sheets.

const BASE = "https://services.leadconnectorhq.com";

export interface AuthInfo { userId: string; email: string | null; role: string | null }

// Current signed-in user + role (RLS lets a user read their own role row).
export async function getAuth(): Promise<AuthInfo | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", user.id).single();
  return { userId: user.id, email: user.email ?? null, role: (data?.role as string) ?? null };
}

export interface V3Client {
  ownerKey: string;   // Owner Full Name, trimmed + lowercased (matches ghl_* tables)
  ownerName: string;
  business: string;
  bizNorm: string;    // business name, alphanumerics only, lowercased
  status: string;     // live | paused
  version: string;
  assigned: string;   // Clients Master "Assigned" — the coach who owns this client
  sheetNotes: string | null; // financing-sheet notes for this client's row
  sheetFee: number | null;   // per-show fee parsed from those notes
}

// The per-show fee lives in the financing sheet's free-text notes ("$50
// deposit + $40 per show", "$45 + $50 - PPS", "V3 - $50 for deposit + $30").
// $50 is always the client deposit and anything over $60 is a retainer/plan
// amount, so after dropping those, the one amount left is the fee. Two
// different leftovers (or none) = the sheet doesn't clearly state it → null,
// and callers fall back to the dashboard-entered fee.
export function feeFromNotes(notes: string | null | undefined): number | null {
  const amounts = [...String(notes ?? "").matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => n > 0 && n <= 60 && n !== 50);
  const distinct = [...new Set(amounts)];
  return distinct.length === 1 ? distinct[0] : null;
}

// The PPA roster: clients marked "PPA" (pay-per-appointment) in the financing
// sheet's latest month tab (synced to client_payments by the 15-min cron).
// The Version column is NOT the signal — some PPA clients are (V2) and some
// (V3) clients pay monthly. Matched to Clients Master by normalized owner name.
// missingFromMaster = PPA names in the financing sheet with no Clients Master
// row — surfaced in the tab so nobody silently drops off billing.
export async function getV3Roster(): Promise<V3Client[]> {
  return (await getPpaRoster()).clients;
}

export async function getPpaRoster(): Promise<{ clients: V3Client[]; missingFromMaster: string[] }> {
  const svc = createServiceClient();
  const [{ data }, { data: pay }] = await Promise.all([
    svc.from("clients_master").select("data"),
    svc.from("client_payments").select("client_name, owner_key, payment_status, notes"),
  ]);
  type PayRow = { client_name: string; notes: string | null };
  const ppaByKey = new Map<string, PayRow>(); // normalized owner key → financing-sheet row
  for (const p of (pay ?? []) as Array<{ client_name: string; owner_key: string; payment_status: string; notes: string | null }>) {
    // The team renamed the financing-sheet mark from "PPA" to "PPS" (pay-per-
    // show) — accept both so a sheet-side rename never empties the roster.
    const status = String(p.payment_status ?? "").toLowerCase();
    if (!status.includes("ppa") && !status.includes("pps")) continue;
    const row: PayRow = { client_name: p.client_name, notes: p.notes };
    ppaByKey.set(p.owner_key, row);
    // The parenthetical is a name too: the financing sheet had "Ah Ra Cho
    // (Estee Cho)" while Clients Master says "Estee Cho" — normalizeOwnerKey
    // drops parentheses, so she never matched. Accept either name order.
    for (const m of String(p.client_name ?? "").matchAll(/\(([^)]+)\)/g)) {
      const alias = normalizeOwnerKey(m[1]);
      if (alias && !ppaByKey.has(alias)) ppaByKey.set(alias, row);
    }
  }
  // Matches are tracked by the SHEET name, not the key — one sheet row can
  // register several keys, and matching any of them means the client is found.
  const matched = new Set<string>();
  const seen = new Set<string>();
  const out: V3Client[] = [];
  for (const r of data ?? []) {
    const d = (r as { data: Record<string, unknown> }).data ?? {};
    const version = String(d["Version"] ?? "");
    const status = String(d["col_1"] ?? "").toLowerCase();
    const rawOwner = String(d["Owner Full Name"] ?? "");
    const normKey = normalizeOwnerKey(rawOwner);
    // Clients Master also carries nicknames in parentheses — "Kim Nguyen
    // (Ngoc)" is "Ngoc Nguyen" on the financing sheet, "Annie Luong (Xuan)" is
    // "Xuan Luong" (owner, 2026-10-27). Try the nickname with the last name,
    // and the nickname on its own when it is already a full name.
    const candidates = [normKey];
    const last = normKey.split(" ").pop() ?? "";
    for (const m of rawOwner.matchAll(/\(([^)]+)\)/g)) {
      const nick = normalizeOwnerKey(m[1]);
      if (!nick) continue;
      candidates.push(nick);
      if (last && !nick.includes(" ")) candidates.push(`${nick} ${last}`);
    }
    const payRow = candidates.map((k) => (k ? ppaByKey.get(k) : undefined)).find(Boolean);
    if (!payRow) continue;
    matched.add(payRow.client_name);
    if (status !== "live" && status !== "paused") continue;
    const ownerName = String(d["Owner Full Name"] ?? "").trim();
    if (!ownerName) continue;
    const ownerKey = ownerName.toLowerCase();
    if (seen.has(ownerKey)) continue;
    seen.add(ownerKey);
    const business = String(d["Business Name"] ?? "").trim();
    out.push({
      ownerKey,
      ownerName,
      business,
      bizNorm: business.toLowerCase().replace(/[^a-z0-9]/g, ""),
      status,
      version,
      assigned: String(d["Assigned"] ?? "").trim(),
      sheetNotes: payRow.notes,
      sheetFee: feeFromNotes(payRow.notes),
    });
  }
  out.sort((a, b) => a.ownerName.localeCompare(b.ownerName));
  const missingFromMaster = [...new Set([...ppaByKey.values()].map((r) => r.client_name))]
    .filter((name) => !matched.has(name))
    .sort();
  return { clients: out, missingFromMaster };
}

// Run an async worker over items with a bounded number running at once.
async function mapWithConcurrency<I>(items: I[], limit: number, worker: (item: I) => Promise<void>): Promise<void> {
  let next = 0;
  async function lane() { while (next < items.length) { const i = next++; await worker(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
}

// GHL returns appointment times like "2026-08-07 14:00:00" (no timezone).
function parseGhlTime(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Pull calendar appointments into ghl_appointments, one calendar at a time.
//
// History: this used to walk every deposit lead AND every opportunity contact
// since June through GHL's per-contact appointments endpoint — 11,000+ calls
// per run. The cron has a 5-minute budget, so each run died part-way, always
// in the same order, and the clients at the tail (Sima: last synced 08/14)
// never got their appointments. Paid leads then sat in "No appt" and were
// never billed. The calendar events endpoint returns every appointment on a
// calendar for a date window (~80 calls for the whole roster), so the pull is
// complete in well under a minute and finds appointments even for leads whose
// deposit row never matched a contact.
// Optionally scope to specific clients (drill-down refresh); otherwise all.
const APPTS_SINCE = Date.UTC(2026, 5, 1); // 2026-06-01: when PPA billing started
const APPTS_AHEAD_MS = 400 * 86400000;     // far-future bookings count as upcoming
const APPTS_CHUNK_MS = 62 * 86400000;      // GHL caps the events window at ~2 months

export type IngestReport = {
  locations: number; calendars: number; appointments: number;
  failed: Array<{ location_id: string; owner_key: string; error: string }>;
};

async function ghlGet(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${token}`, Version: "2021-04-15", Accept: "application/json" } });
}

export async function ingestAppointments(ownerKeys?: string[]): Promise<IngestReport> {
  const svc = createServiceClient();
  const keys = ownerKeys && ownerKeys.length ? ownerKeys : (await getPpaRoster()).clients.map((c) => c.ownerKey);

  // owner -> sub-account(s); ghl_sync_status is the maintained mapping.
  const { data: locRows } = await svc
    .from("ghl_sync_status").select("owner_key, location_id").in("owner_key", keys).not("location_id", "is", null);
  const locs = new Map<string, string>();
  for (const r of (locRows ?? []) as Array<{ owner_key: string; location_id: string }>) locs.set(r.location_id, r.owner_key);

  const report: IngestReport = { locations: locs.size, calendars: 0, appointments: 0, failed: [] };
  const now = new Date().toISOString();
  const windowEnd = Date.now() + APPTS_AHEAD_MS;

  await mapWithConcurrency([...locs.entries()], 6, async ([locationId, ownerKey]) => {
    const fail = (error: string) => { report.failed.push({ location_id: locationId, owner_key: ownerKey, error }); };
    try {
      let tok = (await getAppLocationToken(locationId)).token;
      if (!tok) return fail("no token");
      let r = await ghlGet(`${BASE}/calendars/?locationId=${locationId}`, tok);
      if (r.status === 401) {
        // Stored token rejected by GHL ("Invalid JWT") — mint a fresh one once.
        tok = (await getAppLocationToken(locationId, true)).token;
        if (!tok) return fail("no token after 401");
        r = await ghlGet(`${BASE}/calendars/?locationId=${locationId}`, tok);
      }
      if (!r.ok) return fail(`calendars HTTP ${r.status}`);
      const cals = ((await r.json()) as { calendars?: Array<{ id: string }> }).calendars ?? [];
      for (const cal of cals) {
        report.calendars++;
        for (let from = APPTS_SINCE; from < windowEnd; from += APPTS_CHUNK_MS) {
          const to = Math.min(from + APPTS_CHUNK_MS, windowEnd);
          const er = await ghlGet(`${BASE}/calendars/events?locationId=${locationId}&calendarId=${cal.id}&startTime=${from}&endTime=${to}`, tok);
          if (!er.ok) { fail(`events ${cal.id} HTTP ${er.status}`); continue; }
          const events = ((await er.json()) as { events?: Array<Record<string, unknown>> }).events ?? [];
          // Blocked slots come back on the same endpoint without a contact.
          const appts = events.filter((e) => e.contactId).map((e) => ({
            id: String(e.id),
            location_id: String(e.locationId ?? locationId),
            owner_key: ownerKey,
            contact_id: String(e.contactId),
            calendar_id: (e.calendarId ?? cal.id) as string,
            start_time: parseGhlTime(e.startTime),
            end_time: parseGhlTime(e.endTime),
            status: (e.appointmentStatus ?? e.appoinmentStatus ?? null) as string | null, // GHL ships both spellings
            title: (e.title ?? null) as string | null,
            raw: e,
            synced_at: now,
          }));
          if (!appts.length) continue;
          const { error } = await svc.from("ghl_appointments").upsert(appts, { onConflict: "id" });
          if (error) { fail(`upsert: ${error.message}`); continue; }
          report.appointments += appts.length;
        }
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });
  if (report.failed.length) console.warn("[ppa-appointments] failures", JSON.stringify(report.failed));
  return report;
}

// Ensure ghl_stage_map has stage names for the given locations. Skips locations
// already cached (unless force). Best-effort — a location that fails just stays
// unmapped and its stage counts read as "unmapped" until the next warm/ingest.
export async function warmStageMap(locationIds: string[], force = false): Promise<number> {
  const svc = createServiceClient();
  let todo = Array.from(new Set(locationIds.filter(Boolean)));
  if (!force && todo.length) {
    const { data: existing } = await svc.from("ghl_stage_map").select("location_id").in("location_id", todo);
    const have = new Set((existing ?? []).map((r) => (r as { location_id: string }).location_id));
    todo = todo.filter((l) => !have.has(l));
  }
  if (!todo.length) return 0;
  const now = new Date().toISOString();
  let warmed = 0;
  await mapWithConcurrency(todo, 6, async (locationId) => {
    const tok = await getAppLocationToken(locationId);
    if (!tok.token) return;
    try {
      const r = await fetch(`${BASE}/opportunities/pipelines?locationId=${locationId}`, {
        headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" },
      });
      if (!r.ok) return;
      const j = (await r.json()) as { pipelines?: Array<Record<string, unknown>> };
      const rows: Array<Record<string, unknown>> = [];
      for (const p of j.pipelines ?? []) {
        const stages = (p.stages as Array<Record<string, unknown>>) ?? [];
        stages.forEach((s, idx) => rows.push({
          location_id: locationId,
          stage_id: String(s.id),
          pipeline_id: String(p.id ?? ""),
          stage_name: String(s.name ?? s.id),
          position: idx,
          updated_at: now,
        }));
      }
      if (rows.length) {
        await svc.from("ghl_stage_map").upsert(rows, { onConflict: "location_id,stage_id" });
        warmed++;
      }
    } catch { /* best-effort */ }
  });
  return warmed;
}
