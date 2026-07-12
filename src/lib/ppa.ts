import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

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
}

// The V3 roster: live/paused clients whose Version contains "v3".
export async function getV3Roster(): Promise<V3Client[]> {
  const svc = createServiceClient();
  const { data } = await svc.from("clients_master").select("data");
  const seen = new Set<string>();
  const out: V3Client[] = [];
  for (const r of data ?? []) {
    const d = (r as { data: Record<string, unknown> }).data ?? {};
    const version = String(d["Version"] ?? "");
    const status = String(d["col_1"] ?? "").toLowerCase();
    if (!version.toLowerCase().includes("v3")) continue;
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
    });
  }
  out.sort((a, b) => a.ownerName.localeCompare(b.ownerName));
  return out;
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

// Pull calendar appointments for deposit leads into ghl_appointments (via the
// per-contact endpoint — the only calendar endpoint the app token can read).
// Optionally scope to specific clients (drill-down refresh); otherwise all.
export async function ingestAppointments(ownerKeys?: string[]): Promise<{ contacts: number; appointments: number }> {
  const svc = createServiceClient();
  let q = svc.from("ppa_deposit_contacts").select("contact_id, location_id, owner_key");
  if (ownerKeys && ownerKeys.length) q = q.in("owner_key", ownerKeys);
  const { data } = await q;
  const rows = (data ?? []) as Array<{ contact_id: string; location_id: string; owner_key: string }>;
  const tokenByLoc = new Map<string, string | null>();
  const now = new Date().toISOString();
  let appointments = 0;
  await mapWithConcurrency(rows, 8, async (row) => {
    if (!row.contact_id || !row.location_id) return;
    if (!tokenByLoc.has(row.location_id)) {
      const t = await getAppLocationToken(row.location_id);
      tokenByLoc.set(row.location_id, t.token ?? null);
    }
    const tok = tokenByLoc.get(row.location_id);
    if (!tok) return;
    try {
      const r = await fetch(`${BASE}/contacts/${row.contact_id}/appointments`, {
        headers: { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" },
      });
      if (!r.ok) return;
      const j = (await r.json()) as { events?: Array<Record<string, unknown>> };
      const events = j.events ?? [];
      if (!events.length) return;
      const appts = events.map((e) => ({
        id: String(e.id),
        location_id: String(e.locationId ?? row.location_id),
        owner_key: row.owner_key,
        contact_id: String(e.contactId ?? row.contact_id),
        calendar_id: (e.calendarId ?? null) as string | null,
        start_time: parseGhlTime(e.startTime),
        end_time: parseGhlTime(e.endTime),
        status: (e.appointmentStatus ?? e.appoinmentStatus ?? null) as string | null, // GHL ships both spellings
        title: (e.title ?? null) as string | null,
        raw: e,
        synced_at: now,
      }));
      await svc.from("ghl_appointments").upsert(appts, { onConflict: "id" });
      appointments += appts.length;
    } catch { /* best-effort */ }
  });
  return { contacts: rows.length, appointments };
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
