import { getAppAgencyToken, getAppLocationToken } from "@/lib/ghl-app";
import { POOL_NAME_RE, discoverPool } from "@/lib/ghl-claim";
import { poolReadiness } from "@/lib/pool-readiness";
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
  funnels: number;
};

// Is the Demo snapshot on the account? The setup fills EXISTING "CC - "
// custom values and the funnel rides on the template workflows, so these
// are what "snapshot loaded" means — the same things the Mac Mini verifies
// on screen after a load.
export type SnapshotCheck = {
  ccValues: number;          // custom values whose name starts "CC - "
  fanbasisWorkflow: boolean; // "FanBasis to GHL workflow"
  surveyWorkflow: boolean;   // "CC- Funnel Survey -> (V1 / V2 / V3)"
  present: boolean;
};

export type InspectResult = {
  id: string;
  name: string;
  counts: CleanupCounts;
  snapshot: SnapshotCheck;
  protected: boolean;
  isPool: boolean;
};

export function snapshotCheck(cvNames: string[], workflowNames: string[]): SnapshotCheck {
  const ccValues = cvNames.filter((n) => /^cc\s*-/i.test(n.trim())).length;
  const fanbasisWorkflow = workflowNames.some((n) => /fanbasis\s*to\s*ghl/i.test(n));
  const surveyWorkflow = workflowNames.some((n) => /funnel\s*survey/i.test(n));
  // Lenient on the workflow names (they may be renamed in a future snapshot):
  // CC values plus at least one of the two template workflows.
  return { ccValues, fanbasisWorkflow, surveyWorkflow, present: ccValues > 0 && (fanbasisWorkflow || surveyWorkflow) };
}

async function getJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers });
  const text = await r.text();
  if (!r.ok) throw new Error(`${url.replace(GHL, "")} HTTP ${r.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

// GHL's contact listing reads a search index that can keep a contact after it
// is deleted: the list and its total still show it, but GET /contacts/{id}
// says "not found" and DELETE is a no-op, so finalize would refuse forever
// (Neo Beauty Bar, 2026-09-30). When only a few are listed, each one is
// checked by id and 400/404 ghosts are not counted. Any other failure keeps
// the listed total — unknown never becomes a reassuring zero.
async function countLiveContacts(locationId: string, tok: string, listed: number): Promise<number> {
  if (listed <= 0 || listed > 25) return listed;
  try {
    const page = await getJson(`${GHL}/contacts/?locationId=${locationId}&limit=25`, locHeaders(tok));
    const ids = ((page.contacts as Array<{ id?: string }>) ?? []).map((c) => c.id).filter(Boolean) as string[];
    if (ids.length !== listed) return listed;
    let live = 0;
    for (const id of ids) {
      const r = await fetch(`${GHL}/contacts/${id}`, { headers: locHeaders(tok) });
      if (r.ok || (r.status !== 400 && r.status !== 404)) live++;
    }
    return live;
  } catch {
    return listed;
  }
}

export async function inspectLocation(locationId: string): Promise<InspectResult> {
  const lt = await getAppLocationToken(locationId);
  if (!lt.token) throw new Error(lt.error ?? "could not mint location token");
  const tok = lt.token;

  const [locDetail, contacts, cvs, cfs, cals, users, workflows, convos, pipelines, funnels] = await Promise.all([
    getJson(`${GHL}/locations/${locationId}`, locHeaders(tok)),
    getJson(`${GHL}/contacts/?locationId=${locationId}&limit=1`, locHeaders(tok)),
    getJson(`${GHL}/locations/${locationId}/customValues`, locHeaders(tok)),
    getJson(`${GHL}/locations/${locationId}/customFields`, locHeaders(tok)),
    getJson(`${GHL}/calendars/?locationId=${locationId}`, locHeaders(tok, V_CONVO)),
    getJson(`${GHL}/users/?locationId=${locationId}`, locHeaders(tok)),
    getJson(`${GHL}/workflows/?locationId=${locationId}`, locHeaders(tok)).catch(() => ({ workflows: [] })),
    getJson(`${GHL}/conversations/search?locationId=${locationId}&limit=1`, locHeaders(tok, V_CONVO)).catch(() => ({ total: 0 })),
    getJson(`${GHL}/opportunities/pipelines?locationId=${locationId}`, locHeaders(tok)).catch(() => ({ pipelines: [] })),
    // Funnels can't be deleted through GHL's API (no such route) — counted so
    // the wipe never silently leaves the previous client's pages behind.
    // Reading them needs funnel scopes the app doesn't have yet, so a failure
    // means "unknown" (-1), never a reassuring zero.
    getJson(`${GHL}/funnels/funnel/list?locationId=${locationId}&limit=100`, locHeaders(tok)).catch(() => ({ funnels: null })),
  ]);

  const name = String((locDetail.location as { name?: string } | undefined)?.name ?? "").trim();
  const listedContacts = Number((contacts.meta as { total?: number } | undefined)?.total ?? 0);
  return {
    id: locationId,
    name,
    counts: {
      contacts: await countLiveContacts(locationId, tok, listedContacts),
      customValues: ((cvs.customValues as unknown[]) ?? []).length,
      customFields: ((cfs.customFields as unknown[]) ?? []).length,
      calendars: ((cals.calendars as unknown[]) ?? []).length,
      users: ((users.users as unknown[]) ?? []).length,
      workflows: ((workflows.workflows as unknown[]) ?? []).length,
      conversations: Number(convos.total ?? 0),
      pipelines: ((pipelines.pipelines as unknown[]) ?? []).length,
      funnels: funnels.funnels === null ? -1 : ((funnels.funnels as unknown[]) ?? []).length,
    },
    snapshot: snapshotCheck(
      ((cvs.customValues as Array<{ name?: string }>) ?? []).map((c) => String(c.name ?? "")),
      ((workflows.workflows as Array<{ name?: string }>) ?? []).map((w) => String(w.name ?? "")),
    ),
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
// Contacts only — the previous client's data. Shared by the full wipe and
// the setup run's first step (check & clean), which must never touch the
// custom values, fields, calendars or automations the snapshot brought.
export async function deleteAllContacts(locationId: string, tok: string): Promise<StepResult> {
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
  return step;
}

export async function cleanLocation(locationId: string): Promise<CleanResult> {
  if (isProtectedLocation(locationId)) throw new Error("Refusing to clean protected location");
  const lt = await getAppLocationToken(locationId);
  if (!lt.token) throw new Error(lt.error ?? "could not mint location token");
  const tok = lt.token;
  const out: CleanResult = {};

  // Contacts — paginate then delete; cap guards the serverless time limit.
  try {
    out.contacts = await deleteAllContacts(locationId, tok);
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
  a2p: string; // "approved" | "pending" — A2P isn't in any API, so it's tracked by hand
  // Cleanliness, filled in by refreshPoolCleanliness(). null = never checked.
  workflows: number | null; // automations in it (the snapshot brings 18 — expected, not dirt)
  dirty: number | null;     // CLIENT data left: contacts
  clean_checked_at: string | null;
  clean_note: string | null;
  // Snapshot reload (supabase/pool-snapshot.sql, 10/15/2026). An account is
  // offered for a setup only with snapshot_loaded_at set — see lib/pool-snapshot.
  snapshot_task_id: string | null;   // latest AI Agent card
  snapshot_queued_at: string | null;
  snapshot_loaded_at: string | null; // confirmed loaded (AI Agent done, or a Re-check saw the template)
  snapshot_note: string | null;
};

// Readiness lives in lib/pool-readiness (pure, shared with the Cleanup tab).
export { poolReadiness, poolBlocker, type PoolReadiness } from "@/lib/pool-readiness";

// Re-inspect pool accounts and store what's in each. Batched by the caller:
// one inspect is ~10 GHL calls, so checking the whole pool in a single
// request would outrun the serverless limit.
//
// Dirt = the previous client's data (contacts). Custom values, fields,
// calendars, pipelines and automations are what the Demo snapshot brings and
// what a setup NEEDS, so seeing them marks the snapshot as loaded — that is
// how the pre-provisioned accounts (4–50, created from the snapshot and
// never wiped) and anything loaded by hand become ready without a Mac Mini
// task. Seeing none clears the mark: the Mini's "done" never outranks what
// the API shows.
export async function refreshPoolCleanliness(locationIds: string[]): Promise<PoolRow[]> {
  const svc = createServiceClient();
  const now = new Date().toISOString();
  const { data: before } = await svc.from("pool_accounts").select("location_id, snapshot_loaded_at, snapshot_task_id, snapshot_note").in("location_id", locationIds);
  const prior = new Map(((before ?? []) as Array<Pick<PoolRow, "location_id" | "snapshot_loaded_at" | "snapshot_task_id" | "snapshot_note">>).map((r) => [r.location_id, r]));
  const results = await Promise.all(
    locationIds.map(async (id) => {
      const was = prior.get(id);
      try {
        const inspect = await inspectLocation(id);
        const c = inspect.counts;
        const s = inspect.snapshot;
        const dirty = c.contacts;
        const bits: string[] = [];
        if (c.contacts) bits.push(`${c.contacts} contacts left`);
        if (s.present) bits.push(`snapshot ✓ ${s.ccValues} CC values, ${c.workflows} automations`);
        else if (c.customValues || c.workflows) bits.push(`${c.customValues} custom values, ${c.workflows} automations — not the Demo snapshot`);
        else bits.push("empty — waiting for snapshot");
        const snapshot: Partial<PoolRow> = s.present
          ? (was?.snapshot_loaded_at ? {} : { snapshot_loaded_at: now, snapshot_note: `snapshot found on Re-check ${new Date(now).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })}` })
          : (was?.snapshot_loaded_at ? { snapshot_loaded_at: null, snapshot_note: `✗ Re-check sees no snapshot (${s.ccValues} CC values, ${c.workflows} automations) — load it again` } : {});
        return { location_id: id, workflows: c.workflows, dirty, clean_checked_at: now, clean_note: bits.join(" · "), ...snapshot };
      } catch (e) {
        return {
          location_id: id, workflows: null, dirty: null, clean_checked_at: now,
          clean_note: `couldn't check: ${e instanceof Error ? e.message : "failed"}`,
        };
      }
    })
  );
  for (const r of results) {
    const { location_id, ...upd } = r;
    await svc.from("pool_accounts").update(upd).eq("location_id", location_id);
  }
  const { data } = await svc.from("pool_accounts").select("*").in("location_id", locationIds);
  return (data ?? []) as PoolRow[];
}

// The accounts a setup may take right now: snapshot loaded, no client data,
// A2P approved — lowest number first.
export async function listReadyPool(): Promise<PoolRow[]> {
  const svc = createServiceClient();
  const { data } = await svc.from("pool_accounts").select("*").eq("status", "available");
  const rows = (data ?? []) as PoolRow[];
  const num = (n: string) => Number(n.replace(/\D+/g, "")) || 0;
  return rows.filter((r) => poolReadiness(r) === "ready").sort((a, b) => num(a.pool_name) - num(b.pool_name));
}

// A2P registration status isn't exposed anywhere in GHL's API (checked the
// location record and the phone-system endpoints), so it's tracked here and
// toggled from the tab.
export async function setPoolA2p(locationId: string, a2p: string, by: string | null): Promise<void> {
  const svc = createServiceClient();
  await svc
    .from("pool_accounts")
    .update({ a2p: a2p === "approved" ? "approved" : "pending", a2p_updated_at: new Date().toISOString(), a2p_updated_by: by })
    .eq("location_id", locationId);
}

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
