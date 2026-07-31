import { getAppAgencyToken, getAppLocationToken } from "@/lib/ghl-app";
import { POOL_NAME_RE, discoverPool } from "@/lib/ghl-claim";
import { createServiceClient } from "@/lib/supabase/server";

// Sub-account cleanup: wipe an offboarded client's location (contacts, custom
// values, custom fields, calendars, location-only users, conversations) so it
// can be renamed into the "Clean New Account N" pool and reused — these
// accounts keep their A2P approval, which is the whole point of recycling.
//
// Workflows/automations can NOT be deleted through the public API (readonly
// scope only) — the tab surfaces the count so they can be removed by hand.

const GHL = "https://services.leadconnectorhq.com";
const V = "2021-07-28";
const V_CONVO = "2021-04-15";

// Same hard blocklist as ghl-claim: the main agency sub-account is never touched.
const PROTECTED_LOCATIONS = new Set([
  "SfpNMJ5YU9lBkxss47lK", // PMU Bookings On Demand — view-only, always
]);

function agencyHeaders(): Record<string, string> {
  const token = process.env.GHL_AGENCY_TOKEN;
  if (!token) throw new Error("GHL_AGENCY_TOKEN not set");
  return { Authorization: `Bearer ${token}`, Version: V, Accept: "application/json" };
}

function locHeaders(token: string, version = V): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Version: version, Accept: "application/json" };
}

export function isProtectedLocation(locationId: string): boolean {
  return PROTECTED_LOCATIONS.has(locationId);
}

// ── Location search ─────────────────────────────────────────────────────────

export type LocationHit = { id: string; name: string };

export async function listAllLocations(): Promise<LocationHit[]> {
  const agency = await getAppAgencyToken();
  if (!agency) throw new Error("marketplace app not connected");
  const all: LocationHit[] = [];
  let skip = 0;
  for (;;) {
    const r = await fetch(
      `${GHL}/locations/search?companyId=${encodeURIComponent(agency.companyId)}&limit=100&skip=${skip}`,
      { headers: locHeaders(agency.token) }
    );
    const j = (await r.json()) as { locations?: Array<{ id?: string; _id?: string; name?: string }> };
    if (!r.ok) throw new Error(`locations/search HTTP ${r.status}`);
    const batch = (j.locations ?? []).map((l) => ({ id: String(l.id ?? l._id ?? ""), name: String(l.name ?? "").trim() }));
    all.push(...batch);
    if (batch.length < 100) break;
    skip += 100;
  }
  return all;
}

export async function searchLocations(q: string): Promise<LocationHit[]> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nq = norm(q);
  if (!nq) return [];
  const all = await listAllLocations();
  const exact = all.filter((l) => norm(l.name) === nq);
  const partial = all.filter((l) => norm(l.name) !== nq && norm(l.name).includes(nq));
  return [...exact, ...partial].slice(0, 8);
}

// ── Inspect ─────────────────────────────────────────────────────────────────

export type CleanupCounts = {
  contacts: number;
  customValues: number;
  customFields: number;
  calendars: number;
  users: number;
  workflows: number;
  conversations: number;
  pipelines: number;
};

export type InspectResult = {
  id: string;
  name: string;
  counts: CleanupCounts;
  protected: boolean;
  isPool: boolean;
};

async function getJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers });
  const text = await r.text();
  if (!r.ok) throw new Error(`${url.replace(GHL, "")} HTTP ${r.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export async function inspectLocation(locationId: string): Promise<InspectResult> {
  const lt = await getAppLocationToken(locationId);
  if (!lt.token) throw new Error(lt.error ?? "could not mint location token");
  const tok = lt.token;

  const [locDetail, contacts, cvs, cfs, cals, users, workflows, convos, pipelines] = await Promise.all([
    getJson(`${GHL}/locations/${locationId}`, locHeaders(tok)),
    getJson(`${GHL}/contacts/?locationId=${locationId}&limit=1`, locHeaders(tok)),
    getJson(`${GHL}/locations/${locationId}/customValues`, locHeaders(tok)),
    getJson(`${GHL}/locations/${locationId}/customFields`, locHeaders(tok)),
    getJson(`${GHL}/calendars/?locationId=${locationId}`, locHeaders(tok, V_CONVO)),
    getJson(`${GHL}/users/?locationId=${locationId}`, locHeaders(tok)),
    getJson(`${GHL}/workflows/?locationId=${locationId}`, locHeaders(tok)).catch(() => ({ workflows: [] })),
    getJson(`${GHL}/conversations/search?locationId=${locationId}&limit=1`, locHeaders(tok, V_CONVO)).catch(() => ({ total: 0 })),
    getJson(`${GHL}/opportunities/pipelines?locationId=${locationId}`, locHeaders(tok)).catch(() => ({ pipelines: [] })),
  ]);

  const name = String((locDetail.location as { name?: string } | undefined)?.name ?? "").trim();
  return {
    id: locationId,
    name,
    counts: {
      contacts: Number((contacts.meta as { total?: number } | undefined)?.total ?? 0),
      customValues: ((cvs.customValues as unknown[]) ?? []).length,
      customFields: ((cfs.customFields as unknown[]) ?? []).length,
      calendars: ((cals.calendars as unknown[]) ?? []).length,
      users: ((users.users as unknown[]) ?? []).length,
      workflows: ((workflows.workflows as unknown[]) ?? []).length,
      conversations: Number(convos.total ?? 0),
      pipelines: ((pipelines.pipelines as unknown[]) ?? []).length,
    },
    protected: isProtectedLocation(locationId),
    isPool: POOL_NAME_RE.test(name),
  };
}

// ── Clean ───────────────────────────────────────────────────────────────────

export type StepResult = { found: number; deleted: number; failed: number; error?: string };
export type CleanResult = Record<string, StepResult>;

async function del(url: string, headers: Record<string, string>): Promise<{ ok: boolean; gone: boolean; status: number; body: string }> {
  const r = await fetch(url, { method: "DELETE", headers });
  const body = r.ok ? "" : (await r.text()).slice(0, 120);
  // 400/404 on DELETE = the item is already gone (pagination race with an
  // earlier pass, or a stale id in GHL's listing) — that's success, not failure.
  const gone = !r.ok && (r.status === 400 || r.status === 404);
  return { ok: r.ok, gone, status: r.status, body };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Deletes everything the API allows. Each step reports found/deleted/failed so
// a missing scope shows up as a per-step error instead of a silent skip.
export async function cleanLocation(locationId: string): Promise<CleanResult> {
  if (isProtectedLocation(locationId)) throw new Error("Refusing to clean protected location");
  const lt = await getAppLocationToken(locationId);
  if (!lt.token) throw new Error(lt.error ?? "could not mint location token");
  const tok = lt.token;
  const out: CleanResult = {};

  // Contacts — paginate then delete; cap guards the serverless time limit.
  try {
    const step: StepResult = { found: 0, deleted: 0, failed: 0 };
    const first = await getJson(`${GHL}/contacts/?locationId=${locationId}&limit=1`, locHeaders(tok));
    step.found = Number((first.meta as { total?: number } | undefined)?.total ?? 0);
    let firstError = "";
    for (let round = 0; round < 30; round++) {
      const page = await getJson(`${GHL}/contacts/?locationId=${locationId}&limit=100`, locHeaders(tok));
      const batch = (page.contacts as Array<{ id?: string }>) ?? [];
      if (batch.length === 0) break;
      let pageDeleted = 0;
      for (const c of batch) {
        const r = await del(`${GHL}/contacts/${c.id}`, locHeaders(tok));
        if (r.ok) { step.deleted++; pageDeleted++; }
        else if (!r.gone) { step.failed++; if (!firstError) firstError = `HTTP ${r.status}: ${r.body}`; }
        await sleep(60);
      }
      // No successful delete in a whole page — either missing scope (401s) or
      // the listing is stale (all already gone). Either way, stop looping.
      if (pageDeleted === 0) break;
    }
    if (firstError) step.error = firstError;
    out.contacts = step;
  } catch (e) {
    out.contacts = { found: 0, deleted: 0, failed: 0, error: e instanceof Error ? e.message : "failed" };
  }

  // Custom values
  try {
    const j = await getJson(`${GHL}/locations/${locationId}/customValues`, locHeaders(tok));
    const items = (j.customValues as Array<{ id?: string }>) ?? [];
    const step: StepResult = { found: items.length, deleted: 0, failed: 0 };
    for (const it of items) {
      const r = await del(`${GHL}/locations/${locationId}/customValues/${it.id}`, locHeaders(tok));
      if (r.ok) step.deleted++; else if (!r.gone) { step.failed++; if (!step.error) step.error = `HTTP ${r.status}: ${r.body}`; }
      await sleep(60);
    }
    out.customValues = step;
  } catch (e) {
    out.customValues = { found: 0, deleted: 0, failed: 0, error: e instanceof Error ? e.message : "failed" };
  }

  // Custom fields
  try {
    const j = await getJson(`${GHL}/locations/${locationId}/customFields`, locHeaders(tok));
    const items = (j.customFields as Array<{ id?: string }>) ?? [];
    const step: StepResult = { found: items.length, deleted: 0, failed: 0 };
    for (const it of items) {
      const r = await del(`${GHL}/locations/${locationId}/customFields/${it.id}`, locHeaders(tok));
      if (r.ok) step.deleted++; else if (!r.gone) { step.failed++; if (!step.error) step.error = `HTTP ${r.status}: ${r.body}`; }
      await sleep(60);
    }
    out.customFields = step;
  } catch (e) {
    out.customFields = { found: 0, deleted: 0, failed: 0, error: e instanceof Error ? e.message : "failed" };
  }

  // Calendars
  try {
    const j = await getJson(`${GHL}/calendars/?locationId=${locationId}`, locHeaders(tok, V_CONVO));
    const items = (j.calendars as Array<{ id?: string }>) ?? [];
    const step: StepResult = { found: items.length, deleted: 0, failed: 0 };
    for (const it of items) {
      const r = await del(`${GHL}/calendars/${it.id}`, locHeaders(tok, V_CONVO));
      if (r.ok) step.deleted++; else if (!r.gone) { step.failed++; if (!step.error) step.error = `HTTP ${r.status}: ${r.body}`; }
      await sleep(60);
    }
    out.calendars = step;
  } catch (e) {
    out.calendars = { found: 0, deleted: 0, failed: 0, error: e instanceof Error ? e.message : "failed" };
  }

  // Users — ONLY users scoped to this single location. Agency/multi-location
  // staff (admins, VAs) keep their access untouched.
  try {
    const j = await getJson(`${GHL}/users/?locationId=${locationId}`, locHeaders(tok));
    const items = (j.users as Array<{ id?: string; roles?: { locationIds?: string[] } }>) ?? [];
    const onlyHere = items.filter((u) => {
      const locs = u.roles?.locationIds ?? [];
      return locs.length === 1 && locs[0] === locationId;
    });
    const step: StepResult = { found: onlyHere.length, deleted: 0, failed: 0 };
    for (const u of onlyHere) {
      const r = await del(`${GHL}/users/${u.id}`, locHeaders(tok));
      if (r.ok) step.deleted++; else if (!r.gone) { step.failed++; if (!step.error) step.error = `HTTP ${r.status}: ${r.body}`; }
      await sleep(60);
    }
    out.users = step;
  } catch (e) {
    out.users = { found: 0, deleted: 0, failed: 0, error: e instanceof Error ? e.message : "failed" };
  }

  // Pipelines (opportunities) — the DELETE endpoint exists but GHL rejects it
  // even with opportunities.write granted (verified live), so expect the
  // attempt to fail and surface the manual path instead of a cryptic 401.
  try {
    const j = await getJson(`${GHL}/opportunities/pipelines?locationId=${locationId}`, locHeaders(tok));
    const items = (j.pipelines as Array<{ id?: string }>) ?? [];
    const step: StepResult = { found: items.length, deleted: 0, failed: 0 };
    for (const it of items) {
      const r = await del(`${GHL}/opportunities/pipelines/${it.id}`, locHeaders(tok));
      if (r.ok) step.deleted++; else if (!r.gone) { step.failed++; if (!step.error) step.error = `HTTP ${r.status}: ${r.body}`; }
      await sleep(60);
    }
    if (step.failed > 0 && step.deleted === 0) {
      step.error = "GHL doesn't allow pipeline deletion via API — delete it in Settings → Opportunities & Pipelines (or ask Claude to do it in the browser)";
    }
    out.pipelines = step;
  } catch (e) {
    out.pipelines = { found: 0, deleted: 0, failed: 0, error: e instanceof Error ? e.message : "failed" };
  }

  // Conversations — whatever the search API returns (GMB-review threads are
  // not returned by this endpoint and need the GHL UI).
  try {
    const step: StepResult = { found: 0, deleted: 0, failed: 0 };
    for (let round = 0; round < 20; round++) {
      const j = await getJson(`${GHL}/conversations/search?locationId=${locationId}&limit=100`, locHeaders(tok, V_CONVO));
      const items = (j.conversations as Array<{ id?: string }>) ?? [];
      if (round === 0) step.found = Number(j.total ?? items.length);
      if (items.length === 0) break;
      let pageDeleted = 0;
      for (const c of items) {
        const r = await del(`${GHL}/conversations/${c.id}`, locHeaders(tok, V_CONVO));
        if (r.ok) { step.deleted++; pageDeleted++; }
        else if (!r.gone) { step.failed++; if (!step.error) step.error = `HTTP ${r.status}: ${r.body}`; }
        await sleep(60);
      }
      if (pageDeleted === 0) break;
    }
    out.conversations = step;
  } catch (e) {
    out.conversations = { found: 0, deleted: 0, failed: 0, error: e instanceof Error ? e.message : "failed" };
  }

  return out;
}

// ── Finalize: rename into the clean-account pool ────────────────────────────

export async function nextPoolName(): Promise<string> {
  const pool = await discoverPool();
  let max = 0;
  for (const p of pool) {
    const m = p.name.match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Clean New Account ${max + 1}`;
}

// ── Pool inventory ──────────────────────────────────────────────────────────
// Every "Clean New Account N" is recorded once. A recorded account whose GHL
// name no longer matches the pool pattern was claimed for a client setup, so
// it flips to `used` with the name it became — that's how the available count
// stays honest without anyone updating a list by hand.

export type PoolRow = {
  location_id: string;
  pool_name: string;
  status: string;
  used_as: string | null;
  used_at: string | null;
  first_seen_at: string;
};

export async function syncPool(): Promise<{ available: PoolRow[]; used: PoolRow[] }> {
  const svc = createServiceClient();
  const live = await listAllLocations();
  const nameById = new Map(live.map((l) => [l.id, l.name]));
  const now = new Date().toISOString();

  // Anything currently named like a pool account is available (and newly
  // pooled accounts get inserted here the first time they're seen).
  const currentPool = live.filter((l) => POOL_NAME_RE.test(l.name));
  if (currentPool.length) {
    await svc.from("pool_accounts").upsert(
      currentPool.map((l) => ({
        location_id: l.id,
        pool_name: l.name,
        status: "available",
        used_as: null,
        used_at: null,
        last_checked_at: now,
      })),
      { onConflict: "location_id" }
    );
  }

  // Recorded-but-renamed = claimed for a setup.
  const { data: recorded } = await svc.from("pool_accounts").select("*");
  for (const row of (recorded ?? []) as PoolRow[]) {
    const liveName = nameById.get(row.location_id);
    const stillPool = liveName ? POOL_NAME_RE.test(liveName) : false;
    if (!stillPool && row.status !== "used") {
      await svc
        .from("pool_accounts")
        .update({
          status: "used",
          used_as: liveName ?? "(removed from GHL)",
          used_at: now,
          last_checked_at: now,
        })
        .eq("location_id", row.location_id);
    }
  }

  const { data: fresh } = await svc
    .from("pool_accounts")
    .select("*")
    .order("pool_name", { ascending: true });
  const rows = (fresh ?? []) as PoolRow[];
  const numOf = (n: string) => Number((n.match(/(\d+)\s*$/) ?? [])[1] ?? 0);
  return {
    available: rows.filter((r) => r.status === "available").sort((a, b) => numOf(a.pool_name) - numOf(b.pool_name)),
    used: rows
      .filter((r) => r.status === "used")
      .sort((a, b) => String(b.used_at ?? "").localeCompare(String(a.used_at ?? ""))),
  };
}

export async function renameToPool(locationId: string): Promise<{ oldName: string; poolName: string }> {
  if (isProtectedLocation(locationId)) throw new Error("Refusing to rename protected location");
  const detail = await getJson(`${GHL}/locations/${locationId}`, agencyHeaders());
  const oldName = String((detail.location as { name?: string } | undefined)?.name ?? "").trim();
  if (POOL_NAME_RE.test(oldName)) return { oldName, poolName: oldName }; // already in the pool
  const poolName = await nextPoolName();
  const r = await fetch(`${GHL}/locations/${locationId}`, {
    method: "PUT",
    headers: { ...agencyHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name: poolName, companyId: (await getAppAgencyToken())?.companyId }),
  });
  if (!r.ok) throw new Error(`rename HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return { oldName, poolName };
}
