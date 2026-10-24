import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dashboardUrl } from "@/lib/agent-notify";
import { fileAlert } from "@/lib/alerts";

/* ── CloseBot ↔ V3 weekly check (owner, 10/24/2026) ─────────────────────────
   Every V3 client needs a CloseBot source with a live job flow, and nobody
   else should have one. On 10/24 five Live V3 clients had no working bot
   (About Face, Maria Blanco, Malaroy, Browzandbeauties, Sally Nails — Sally's
   source still pointed at her OLD, recycled sub-account) and 7 non-V3
   accounts still had the slay agent switched on.

   CloseBot's API key is dead (401) and the owner keeps it that way, so the
   list comes from the CloseBot UI: once a week the AI Agent (Mac Mini) opens
   Sources, runs SOURCES_SCRIPT, and the page POSTs every source (GHL location
   id + job flows) straight to /api/closebot/coverage — no list ever passes
   through the agent's own words. The comparison then files one alert per
   client on the Alerts tab and closes the ones that got fixed. */

type Svc = SupabaseClient;
const now = () => new Date().toISOString();
const usDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

export const CB_CONV_ID = "closebot:coverage_check";
export const CB_LOCATION = "closebot"; // not a GHL sub-account — the worker's prompt switches on it
export const SNAPSHOT_KEY = "closebot_sources";
export const isCloseBotCheck = (conversationId: string | null | undefined) => conversationId === CB_CONV_ID;
const DEMO_LOCATION = "asaIf2fxizaCNJ71iywk"; // Demo (V3) — protected test account, always connected

export type CbFlow = { a: string; on: boolean; t: string[] };
export type CbSource = { id: string; k: string; n: string; c: boolean; f: CbFlow[] };
export type CbSnapshot = { at: string; task: string; total: number; sources: CbSource[] };

/* The POST is authenticated by a signature of the card id: the link only
   works for the one check card that carries it. */
function secret(): string {
  const s = process.env.AGENT_WORKER_SECRET || process.env.CRON_SECRET;
  if (!s) throw new Error("AGENT_WORKER_SECRET / CRON_SECRET not set");
  return s;
}
export const signTask = (taskId: string) => createHmac("sha256", secret()).update(`closebot:${taskId}`).digest("hex").slice(0, 40);
export function verifyTask(taskId: string, sig: string): boolean {
  const want = Buffer.from(signTask(taskId));
  const got = Buffer.from(String(sig ?? ""));
  return want.length === got.length && timingSafeEqual(want, got);
}

/* Runs inside app.closebot.com/settings/sources (browser_evaluate). Reads
   each page's rows from the table's React props (the only place the GHL
   location id is shown), pages through all of them, then POSTs the list.
   Returns one line the agent copies into its report. */
export function sourcesScript(postUrl: string): string {
  return `async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = () => document.body.innerText;
  const label = () => (text().match(/(\\d+)-(\\d+) of (\\d+)/) || [])[0];
  const rows = () => { const tr = document.querySelector("table tbody tr"); if (!tr) return null; const fk = Object.keys(tr).find((k) => k.startsWith("__reactFiber")); let f = fk && tr[fk], d = 0; while (f && d < 15) { const p = f.memoizedProps; if (p && Array.isArray(p.data)) return p.data; f = f.return; d++; } return null; };
  const btn = (re) => [...document.querySelectorAll("button")].find((b) => re.test(b.getAttribute("aria-label") || ""));
  for (let k = 0; k < 75 && !rows(); k++) await sleep(200);
  if (!rows()) return "CLOSEBOT: ERROR — the Sources table did not load";
  const total = Number((text().match(/Total Sources\\s*(\\d+)/) || [])[1] || 0);
  while (btn(/previous/i) && !btn(/previous/i).disabled) { const l = label(); btn(/previous/i).click(); for (let k = 0; k < 50 && label() === l; k++) await sleep(200); }
  const all = new Map();
  for (let i = 0; i < 60; i++) {
    await sleep(800);
    for (const s of rows() || []) all.set(s.sourceId, { id: s.sourceId, k: s.key, n: s.name, c: !!s.connected, f: (s.bots || []).map((b) => ({ a: b.botName, on: !!b.enabled, t: (b.tags || []).map((t) => t.name) })) });
    const nx = btn(/next/i);
    if (!nx || nx.disabled) break;
    const l = label(); nx.click(); for (let k = 0; k < 75 && label() === l; k++) await sleep(200);
  }
  const sources = [...all.values()];
  const r = await fetch(${JSON.stringify(postUrl)}, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ total, sources }) });
  const body = await r.text();
  return "CLOSEBOT: " + (r.ok ? "SAVED " : "ERROR ") + sources.length + "/" + total + " — " + body.slice(0, 200);
}`;
}

function checkPlan(postUrl: string): string[] {
  return [
    `Open https://app.closebot.com/settings/sources and wait until the Sources table shows rows ("Total Sources" at the top). This is a READ-ONLY check: never click Save, Publish, Connect, Disconnect, Delete or any switch.`,
    `Run this exact function with the browser's evaluate tool (browser_evaluate) on that page — copy it unchanged:\n${sourcesScript(postUrl)}`,
    `Screenshot the Sources page as after-1.png.`,
    `Report. Your summary must be the exact line the function returned (it starts with "CLOSEBOT:"). Status "done" when it says SAVED; "failed" when it says ERROR. If CloseBot shows a sign-in page instead of Sources, type nothing: status "needs_teammate", summary "Mac Mini is not signed in to CloseBot".`,
  ];
}

export type QueueResult = { taskId: string; reused: boolean };

const LINK_DAYS = 3; // the signed link (and so the card) is good this long

/* Queue the check; an open card is reused (one check at a time) unless its
   link has expired — a card stuck through a Mini outage would otherwise be
   reused every week and fail every week. */
export async function queueCloseBotCheck(svc: Svc, by: string): Promise<QueueResult> {
  const { data: open } = await svc.from("agent_proposals").select("id, created_at")
    .eq("conversation_id", CB_CONV_ID).in("status", ["queued_browser", "running"]);
  for (const o of (open ?? []) as Array<{ id: string; created_at: string }>) {
    if (Date.now() - Date.parse(o.created_at) < LINK_DAYS * 86_400_000) return { taskId: o.id, reused: true };
    await svc.from("agent_proposals").update({ status: "failed", result: "✗ Expired before the AI Agent got to it — replaced by a new check" })
      .eq("id", o.id).in("status", ["queued_browser", "running"]);
  }
  const { count } = await svc.from("agent_proposals").select("id", { count: "exact", head: true }).eq("conversation_id", CB_CONV_ID);
  const id = randomUUID();
  const postUrl = `${dashboardUrl()}/api/closebot/coverage?task=${id}&sig=${signTask(id)}`;
  const { error } = await svc.from("agent_proposals").insert({
    id,
    conversation_id: CB_CONV_ID,
    message_id: `coverage#${(count ?? 0) + 1}`,
    contact_id: null,
    contact_name: "CloseBot weekly check",
    channel: null,
    client_message: `Weekly check: which V3 clients have no CloseBot agent, and which non-V3 accounts still have one. Read-only, queued by ${by} on ${usDate(now())}.`,
    summary: "CloseBot: read every source and its job flows (read-only)",
    action_type: "account_change",
    proposed_reply: null,
    action_detail: "Open CloseBot → Sources and send the list of sources and their job flows to the dashboard. Change nothing. The Alerts tab is filled from this list.",
    action_plan: checkPlan(postUrl).map((what) => ({ type: "manual", what })),
    location_id: CB_LOCATION,
    status: "queued_browser",
    decided_by: `${by} (CloseBot check)`,
    decided_at: now(),
    executed_at: now(),
    result: "⏳ Waiting for the AI Agent (CloseBot check)",
  });
  if (error) throw new Error(`could not queue the CloseBot check: ${error.message}`);
  return { taskId: id, reused: false };
}

/* ── Who is who ───────────────────────────────────────────────────────────── */
type ClientRow = { business: string; owner: string; version: string; status: string };
type LocInfo = { label: string; client: ClientRow | null; pool: string | null; setup: boolean };

const RANK: Record<string, number> = { live: 0, paused: 1, onboarding: 2 };
const rank = (status: string) => RANK[status.toLowerCase()] ?? 3;
export const isV3 = (version: string) => version.toLowerCase().replace(/[^a-z0-9.]/g, "") === "v3";
const activeStatus = (status: string) => ["live", "paused", "onboarding"].includes(status.toLowerCase());
const normBiz = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const SETUP_DAYS = 60; // a box handed to a client this recently is still "being set up"

// PostgREST caps a read at 1,000 rows (the deposits chart lost rows to it).
async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(`could not read clients: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}

/* Clients Master is the truth for version + status. Who owns a sub-account:
   - a pool box handed to a client (pool_accounts "used", used_as = their
     business) belongs to that client from used_at on — during setup they
     have no ghl_sync_status row yet (ingest only syncs Live/Paused), and the
     box's only rows are its OLD owners';
   - otherwise ghl_sync_status (what ingest keeps current) ties an owner to
     it; several owners on one box (recycled) → the most alive one;
   - a pool box not handed out belongs to nobody. */
export async function loadDirectory(svc: Svc): Promise<{ byLocation: Map<string, LocInfo>; v3: Array<ClientRow & { locationId: string | null }> }> {
  const [cm, sync, pool] = await Promise.all([
    readAll<{ business_name: string | null; version: string | null; owner_name: string | null; client_status: string | null }>((a, b) =>
      svc.from("client_program_rows").select("sheet_row, business_name, version, owner_name, client_status").order("sheet_row").range(a, b)),
    readAll<{ owner_key: string; location_id: string; last_success_at: string | null }>((a, b) =>
      svc.from("ghl_sync_status").select("owner_key, location_id, last_success_at").order("location_id").order("owner_key").range(a, b)),
    readAll<{ location_id: string; pool_name: string; status: string; used_as: string | null; used_at: string | null }>((a, b) =>
      svc.from("pool_accounts").select("location_id, pool_name, status, used_as, used_at").order("location_id").range(a, b)),
  ]);
  if (!cm.length || !sync.length) throw new Error("clients list came back empty");

  const byOwner = new Map<string, ClientRow>();
  const byBiz = new Map<string, ClientRow>();
  for (const r of cm) {
    const owner = String(r.owner_name ?? "").trim();
    const business = String(r.business_name ?? "").trim() || owner;
    if (!business) continue;
    const row = { business, owner, version: String(r.version ?? "").trim(), status: String(r.client_status ?? "").trim() };
    const better = (prev?: ClientRow) => !prev || rank(row.status) < rank(prev.status);
    if (owner && better(byOwner.get(owner.toLowerCase()))) byOwner.set(owner.toLowerCase(), row);
    if (better(byBiz.get(normBiz(business)))) byBiz.set(normBiz(business), row);
  }
  // used_as is the business name typed at setup: exact, else ONE prefix match.
  const findBiz = (name: string): ClientRow | null => {
    const key = normBiz(name);
    if (key.length < 3) return null;
    const exact = byBiz.get(key);
    if (exact) return exact;
    if (key.length < 8) return null;
    const hits = [...byBiz.entries()].filter(([k]) => k.length >= 8 && (k.startsWith(key) || key.startsWith(k)));
    return hits.length === 1 ? hits[0][1] : null;
  };

  const poolByLoc = new Map<string, string>();
  const handed = new Map<string, { client: ClientRow; at: number }>();
  for (const p of pool) {
    if (p.status !== "used") { poolByLoc.set(p.location_id, p.pool_name); continue; }
    const client = p.used_as ? findBiz(p.used_as) : null;
    if (client) handed.set(p.location_id, { client, at: p.used_at ? Date.parse(p.used_at) : 0 });
  }

  type Cand = { client: ClientRow; at: number };
  const candByLoc = new Map<string, Cand[]>();
  const add = (loc: string, c: Cand) => { if (!candByLoc.has(loc)) candByLoc.set(loc, []); candByLoc.get(loc)!.push(c); };
  for (const s of sync) {
    const client = byOwner.get(String(s.owner_key ?? "").trim().toLowerCase());
    if (!client || !s.location_id || poolByLoc.has(s.location_id)) continue;
    const at = s.last_success_at ? Date.parse(s.last_success_at) : 0;
    const h = handed.get(s.location_id);
    if (h && client !== h.client && at < h.at) continue; // an owner from before the box was recycled
    add(s.location_id, { client, at });
  }
  for (const [loc, h] of handed) add(loc, h);

  const byLocation = new Map<string, LocInfo>();
  const locsByOwner = new Map<string, Array<{ loc: string; at: number }>>();
  for (const [loc, cands] of candByLoc) {
    const best = cands.sort((a, b) => rank(a.client.status) - rank(b.client.status) || b.at - a.at)[0];
    const h = handed.get(loc);
    const setup = !!h && h.client === best.client && Date.now() - h.at < SETUP_DAYS * 86_400_000;
    byLocation.set(loc, { label: best.client.business, client: best.client, pool: null, setup });
    const key = best.client.owner.toLowerCase() || normBiz(best.client.business);
    if (!locsByOwner.has(key)) locsByOwner.set(key, []);
    locsByOwner.get(key)!.push({ loc, at: Math.max(...cands.filter((c) => c.client === best.client).map((c) => c.at)) });
  }
  for (const [loc, name] of poolByLoc) byLocation.set(loc, { label: name, client: null, pool: name, setup: false });

  const v3: Array<ClientRow & { locationId: string | null }> = [];
  const seen = new Set<ClientRow>();
  for (const c of [...byOwner.values(), ...byBiz.values()]) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (!isV3(c.version) || !["live", "paused"].includes(c.status.toLowerCase())) continue;
    // The sub-account this client owns now: the freshest one that resolves back to them.
    const mine = (locsByOwner.get(c.owner.toLowerCase() || normBiz(c.business)) ?? []).sort((a, b) => b.at - a.at);
    v3.push({ ...c, locationId: mine[0]?.loc ?? null });
  }
  return { byLocation, v3 };
}

/* ── Compare + alerts ────────────────────────────────────────────────────── */
type Finding = { type: "closebot_missing" | "closebot_not_v3"; key: string; severity: "high" | "medium"; title: string; detail: string; meta: Record<string, unknown> };

const flowNames = (fl: CbFlow[]) => [...new Set(fl.map((f) => f.a))].join(", ");

export function compareCoverage(snap: CbSnapshot, dir: Awaited<ReturnType<typeof loadDirectory>>): Finding[] {
  const out: Finding[] = [];
  const byLoc = new Map<string, CbSource[]>();
  for (const s of snap.sources) { if (!byLoc.has(s.k)) byLoc.set(s.k, []); byLoc.get(s.k)!.push(s); }
  const working = (s: CbSource) => s.c && s.f.some((f) => f.on);

  for (const c of dir.v3) {
    const live = c.status.toLowerCase() === "live";
    const base = { business: c.business, owner: c.owner, version: c.version, status: c.status, location_id: c.locationId };
    if (!c.locationId) {
      out.push({ type: "closebot_missing", key: `cb-missing:owner:${c.owner.toLowerCase()}`, severity: live ? "high" : "medium",
        title: `${c.business} (V3, ${c.status}): sub-account not found — CloseBot can't be checked`,
        detail: `${c.business} is V3 on the Clients sheet, but the dashboard can't tell which GoHighLevel sub-account is theirs (no synced account for owner "${c.owner}"), so CloseBot was not checked. Check the owner name on the Clients sheet / keys sheet.`,
        meta: base });
      continue;
    }
    const srcs = byLoc.get(c.locationId) ?? [];
    if (srcs.some(working)) continue;
    let why: string, fix: string;
    if (!srcs.length) {
      why = "has no CloseBot source at all — the AI never answers their leads";
      fix = "In CloseBot → Sources → Add New Source (HighLevel), connect THIS sub-account, then connect the agent's job flow (tags (v3) + ai on).";
    } else if (srcs.every((s) => !s.c)) {
      why = `has a CloseBot source ("${srcs[0].n}") but it is Disconnected`;
      fix = "Reconnect the source in CloseBot → Sources.";
    } else if (srcs.every((s) => !s.f.length)) {
      why = `has a CloseBot source ("${srcs[0].n}") but no agent is connected to it (0 job flows)`;
      fix = "In CloseBot → Agents → the agent → Sources, add this source with tags (v3) + ai on.";
    } else {
      why = `has a CloseBot source ("${srcs[0].n}") but its job flow is switched OFF (${flowNames(srcs.flatMap((s) => s.f))})`;
      fix = "Switch the job flow back on in CloseBot.";
    }
    out.push({ type: "closebot_missing", key: `cb-missing:${c.locationId}`, severity: live ? "high" : "medium",
      title: `${c.business} (V3, ${c.status}): not connected to a CloseBot agent`,
      detail: `${c.business} ${why}. ${fix} Clears itself on the next weekly check once fixed.`,
      meta: { ...base, sources: srcs.map((s) => ({ name: s.n, connected: s.c, flows: s.f })) } });
  }

  for (const [loc, srcs] of byLoc) {
    const live = srcs.filter(working);
    if (!live.length || loc === DEMO_LOCATION) continue;
    const who = dir.byLocation.get(loc);
    const c = who?.client ?? null;
    // V3 and active — or V3 on a box handed to them for setup (sheet may still say Offboarded for a returning client).
    if (c && isV3(c.version) && (activeStatus(c.status) || who?.setup)) continue;
    const on = live.flatMap((s) => s.f.filter((f) => f.on));
    const names = live.map((s) => `"${s.n}"`).join(" and ");
    let what: string, severity: "high" | "medium" = "medium";
    if (who?.pool) { what = `${who.pool} — a wiped pool account (the old client's box)`; severity = "high"; }
    else if (!c) what = "a sub-account the dashboard doesn't know (not on the Clients sheet)";
    else if (!activeStatus(c.status) && !who?.setup) { what = `${c.business} — ${c.status || "no status"} on the Clients sheet`; severity = "high"; }
    else what = `${c.business} — ${c.version || "no version"} (${c.status || "no status"}), not V3`;
    out.push({ type: "closebot_not_v3", key: `cb-not-v3:${loc}`, severity,
      title: `CloseBot agent is ON for ${who?.label ?? live[0].n}, which is not a V3 client`,
      detail: `CloseBot source ${names} has ${flowNames(on)} switched on, but the account is ${what}. Only active V3 clients should have a CloseBot agent. If that's wrong, disconnect the job flow in CloseBot → Sources → ${names}; if the client is really V3, fix the Version / status on the Clients sheet. Clears itself on the next weekly check once fixed.`,
      meta: { source_names: live.map((s) => s.n), location_id: loc, flows: on, business: c?.business ?? null, version: c?.version ?? null, status: c?.status ?? null, pool: who?.pool ?? null } });
  }
  return out;
}

/* One open alert per client: refreshed while the problem lasts, closed by
   the next good snapshot once it's gone. Never closes anything on a list
   that didn't come back whole (the empty-list trap, see pmu-alerts-tab). */
export async function scanCloseBotCoverage(svc: Svc, snap: CbSnapshot): Promise<{ filed: number; updated: number; resolved: number; findings: number }> {
  if (!snap.total || snap.sources.length !== snap.total) throw new Error(`incomplete CloseBot list (${snap.sources.length}/${snap.total})`);
  const dir = await loadDirectory(svc);
  const findings = compareCoverage(snap, dir);
  let filed = 0, updated = 0, resolved = 0;
  for (const f of findings) {
    const { data: open } = await svc.from("alerts").select("id").eq("type", f.type).eq("source_key", f.key).eq("status", "open").limit(1).maybeSingle();
    if (open) {
      await svc.from("alerts").update({ title: f.title.slice(0, 300), detail: f.detail.slice(0, 2000), severity: f.severity, meta: f.meta }).eq("id", (open as { id: string }).id);
      updated++;
      continue;
    }
    if (await fileAlert(svc, { type: f.type, severity: f.severity, title: f.title, detail: f.detail, source_key: f.key, meta: f.meta, resurfaceAfterDays: 1 })) filed++;
  }
  const keep = new Set(findings.map((f) => `${f.type}|${f.key}`));
  const { data: openAll } = await svc.from("alerts").select("id, type, source_key").in("type", ["closebot_missing", "closebot_not_v3"]).eq("status", "open");
  const close = ((openAll ?? []) as Array<{ id: string; type: string; source_key: string }>).filter((a) => !keep.has(`${a.type}|${a.source_key}`)).map((a) => a.id);
  if (close.length) {
    await svc.from("alerts").update({ status: "resolved", resolved_by: `system (CloseBot check ${usDate(snap.at)})`, resolved_at: now() }).in("id", close);
    resolved = close.length;
  }
  return { filed, updated, resolved, findings: findings.length };
}

/* The page POSTed the list. Validate, keep it, compare. A teammate may run
   the same function by hand while the card is still waiting — that closes
   the card so the Mini doesn't do it twice. */
export async function ingestCloseBotSources(svc: Svc, taskId: string, raw: unknown): Promise<{ ok: boolean; error?: string; saved?: number; total?: number; scan?: Awaited<ReturnType<typeof scanCloseBotCoverage>> }> {
  const { data: card } = await svc.from("agent_proposals").select("id, status, conversation_id, created_at").eq("id", taskId).maybeSingle();
  const c = card as { id: string; status: string; conversation_id: string; created_at: string } | null;
  if (!c || !isCloseBotCheck(c.conversation_id)) return { ok: false, error: "unknown check" };
  if (!["queued_browser", "running"].includes(c.status)) return { ok: false, error: `this check is already ${c.status}` };
  if (Date.now() - Date.parse(c.created_at) > LINK_DAYS * 86_400_000) return { ok: false, error: "this check link expired" };

  const body = raw as { total?: unknown; sources?: unknown } | null;
  const total = Number(body?.total);
  const list = Array.isArray(body?.sources) ? (body!.sources as unknown[]) : null;
  if (!Number.isInteger(total) || total <= 0 || !list) return { ok: false, error: "no sources in the list" };
  const sources: CbSource[] = [];
  for (const x of list) {
    const s = x as Record<string, unknown>;
    const k = String(s?.k ?? ""), id = String(s?.id ?? "");
    if (!/^[A-Za-z0-9]{10,40}$/.test(k) || !id) return { ok: false, error: "a source is missing its location id" };
    const flows = Array.isArray(s.f) ? (s.f as Array<Record<string, unknown>>) : [];
    sources.push({ id: id.slice(0, 60), k, n: String(s.n ?? "").slice(0, 120), c: !!s.c,
      f: flows.slice(0, 20).map((f) => ({ a: String(f?.a ?? "").slice(0, 120), on: !!f?.on, t: Array.isArray(f?.t) ? (f.t as unknown[]).map((t) => String(t).slice(0, 60)).slice(0, 20) : [] })) });
  }
  if (sources.length !== total) return { ok: false, error: `got ${sources.length} of ${total} sources — page again` };

  const snap: CbSnapshot = { at: now(), task: taskId, total, sources };
  const scan = await scanCloseBotCoverage(svc, snap);
  // Saved only once the alerts are up to date: onCloseBotCheckClosed reads it as "this week ran".
  await svc.from("app_settings").upsert({ key: SNAPSHOT_KEY, value: snap, updated_by: "closebot check", updated_at: snap.at });
  await resolveCheckAlert(svc);
  if (c.status === "queued_browser") {
    await svc.from("agent_proposals").update({
      status: "done", executed_at: snap.at,
      result: `✓ CLOSEBOT: SAVED ${sources.length}/${total} (sent by hand) — ${scan.findings} problem${scan.findings === 1 ? "" : "s"} on the Alerts tab`,
    }).eq("id", taskId).eq("status", "queued_browser");
  }
  return { ok: true, saved: sources.length, total, scan };
}

async function resolveCheckAlert(svc: Svc): Promise<void> {
  await svc.from("alerts").update({ status: "resolved", resolved_by: "system (CloseBot check ran)", resolved_at: now() })
    .eq("type", "closebot_check").eq("status", "open");
}

/* The Mini closed the card. Done + this card's list arrived = fine; anything
   else means the week's check didn't happen, which the owner must see
   (otherwise "no alerts" would look like "all synced"). */
export async function onCloseBotCheckClosed(svc: Svc, p: { id: string; status: string; result: string | null; reason?: string }): Promise<void> {
  const { data } = await svc.from("app_settings").select("value").eq("key", SNAPSHOT_KEY).maybeSingle();
  const snap = (data?.value ?? null) as CbSnapshot | null;
  if (snap?.task === p.id) { await resolveCheckAlert(svc); return; }
  const lines = String(p.result ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^(🤖|⏳)/u.test(l));
  const said = (p.reason || lines[lines.length - 1] || "").replace(/^(?:✓|✗|👤|•)\s*/u, "").slice(0, 200);
  const signedOut = /sign(ed)? ?in|log ?in/i.test(said);
  await fileAlert(svc, {
    type: "closebot_check", severity: "high", source_key: "closebot-weekly-check", resurfaceAfterDays: 6,
    title: "The weekly CloseBot check could not run",
    detail: `The AI Agent could not read CloseBot this week, so the V3 ↔ CloseBot alerts may be out of date. It said: "${said || p.status}". ${signedOut
      ? "On the Mac Mini, in Terminal: node ~/.pmu-agent/agent-worker.mjs login → sign in to CloseBot in the tab it opens → quit Chrome with Cmd+Q."
      : "Check the card on the AI tab."} ${snap ? `Last good list: ${usDate(snap.at)}.` : ""}`.trim(),
  });
}
