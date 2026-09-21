import { createServiceClient } from "@/lib/supabase/server";
import { getV3Accounts, type V3Account } from "@/lib/ghl-ingest";
import { getAppLocationToken } from "@/lib/ghl-app";
import { getThread } from "@/lib/ghl-conversations";
import { normalizeOwnerKey } from "@/lib/normalizers";

// ── Alerts center ────────────────────────────────────────────────────────────
// High-signal problems the CEO wants pushed at him instead of hunted for:
//   compliance_text — a client's account is appending carrier opt-out footers
//                     ("Reply STOP to unsubscribe") to lead texts, which makes
//                     the outreach look like a bot. Root cause is the
//                     sub-account's Phone → Advanced → SMS compliance toggles.
//   upset_client    — an agency client sounds like they want to leave / wants
//                     a refund / is repeatedly frustrated (filed by the CEO
//                     agent scan, see src/lib/agent.ts).
//   make_scenario   — a Make.com scenario is switched off or has incomplete
//                     executions piling up.
// Everything lands in the `alerts` table; the Alerts tab shows open ones.

export type AlertRow = {
  id: string;
  created_at: string;
  type: string;
  severity: string;
  title: string;
  detail: string | null;
  source_key: string;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  meta: Record<string, unknown> | null;
  /* "Don't show again": resolved AND never re-filed for this source_key,
     whatever resurfaceAfterDays says (owner request 2026-09-16). */
  muted?: boolean;
};

type Svc = ReturnType<typeof createServiceClient>;

export type NewAlert = {
  type: "compliance_text" | "upset_client" | "make_scenario" | "onboarding" | "data_quality" | "agreement" | "status";
  severity?: "high" | "medium";
  title: string;
  detail?: string;
  source_key: string;
  meta?: Record<string, unknown>;
  /** When set, a RESOLVED alert with the same key re-fires after this many
   *  days if the problem is still detected. Unset = one alert per key, ever
   *  (used for per-message keys that can never legitimately recur). */
  resurfaceAfterDays?: number;
};

// File an alert unless the same problem is already on the board. Dedupe is by
// (type, source_key): an OPEN twin always suppresses; a RESOLVED twin
// suppresses unless it's older than resurfaceAfterDays. The read-then-insert
// is additionally backstopped by the alerts_open_uniq partial unique index —
// a conflict there means the alert already exists, not a failure.
export async function fileAlert(svc: Svc, a: NewAlert): Promise<boolean> {
  const { data: existing } = await svc
    .from("alerts")
    .select("id, status, resolved_at, created_at, muted")
    .eq("type", a.type)
    .eq("source_key", a.source_key)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    if (existing.status === "open") return false;
    if (existing.muted) return false; // "don't show again" — stays quiet until reopened
    if (!a.resurfaceAfterDays) return false;
    const ref = existing.resolved_at ?? existing.created_at;
    if (Date.now() - new Date(ref).getTime() < a.resurfaceAfterDays * 86400_000) return false;
  }
  const { error } = await svc.from("alerts").insert({
    type: a.type,
    severity: a.severity ?? "high",
    title: a.title.slice(0, 300),
    detail: a.detail?.slice(0, 2000) ?? null,
    source_key: a.source_key,
    meta: a.meta ?? null,
  });
  return !error;
}

// One box per client: like fileAlert, but when an OPEN twin exists the new
// complaint is APPENDED to that box as a dated note instead of a second alert
// (user request 2026-09-01 — "one notification for one client"). `appendNote`
// is skipped when the box already contains it (same message seen twice).
export async function fileOrAppendAlert(
  svc: Svc,
  a: NewAlert,
  appendNote?: string
): Promise<"filed" | "appended" | "skipped"> {
  const { data: twin } = await svc
    .from("alerts")
    .select("id, detail")
    .eq("type", a.type)
    .eq("source_key", a.source_key)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (twin) {
    const note = (appendNote ?? "").trim();
    // Dedupe on the note's first quoted line — the message body itself.
    const probe = note.split("\n").find((l) => l.includes("“") || l.includes('"')) ?? note;
    if (!note || (probe && (twin.detail ?? "").includes(probe))) return "skipped";
    const detail = `${twin.detail ?? ""}\n\n${note}`.trim().slice(0, 2000);
    const { error } = await svc.from("alerts").update({ detail }).eq("id", twin.id);
    return error ? "skipped" : "appended";
  }
  return (await fileAlert(svc, a)) ? "filed" : "skipped";
}

// One-click deep link to a contact inside a GHL (sub-)account.
export function ghlContactUrl(locationId: string, contactId: string): string {
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${contactId}`;
}

// Who takes care of a client — "Assigned · Media buyer" from the Performance
// data, matched loosely by owner or business name. Loaded once per scan.
export type TeamOwners = { assigned: string | null; mediaBuyer: string | null };

export async function loadTeamLookup(svc: Svc): Promise<(name: string | null | undefined) => TeamOwners | null> {
  type Row = { owner_name: string | null; business_name: string | null; assigned: string | null; media_buyer: string | null };
  let rows: Row[] = [];
  try {
    const { data } = await svc.from("performance_overview").select("owner_name, business_name, assigned, media_buyer");
    rows = (data as Row[]) ?? [];
  } catch { /* alerts still file without the team chip */ }
  // performance_overview only covers LIVE clients, so onboarding alerts — the
  // ones most in need of a name to chase — had nobody on them. Clients Master
  // carries Assigned/Media Buyer for every client, launched or not.
  try {
    const { data: cm } = await svc.from("clients_master").select("data");
    for (const r of (cm ?? []) as Array<{ data: Record<string, unknown> }>) {
      const d = r.data ?? {};
      rows.push({
        owner_name: String(d["Owner Full Name"] ?? "") || null,
        business_name: String(d["Business Name"] ?? "") || null,
        assigned: String(d["Assigned"] ?? "") || null,
        media_buyer: String(d["Media Buyer"] ?? "") || null,
      });
    }
  } catch { /* the performance rows above are enough */ }
  return (name) => {
    const want = String(name ?? "").trim();
    if (!want || !rows.length) return null;
    const usable = (r: Row) => (r.assigned ?? "").trim() || (r.media_buyer ?? "").trim();
    const hit =
      rows.find((r) => usable(r) && nameMatches(r.owner_name ?? "", want)) ??
      rows.find((r) => usable(r) && nameMatches(r.business_name ?? "", want));
    if (!hit) return null;
    const assigned = (hit.assigned ?? "").trim() || null;
    const mediaBuyer = (hit.media_buyer ?? "").trim() || null;
    if (!assigned && !mediaBuyer) return null;
    return { assigned, mediaBuyer: mediaBuyer && mediaBuyer !== assigned ? mediaBuyer : null };
  };
}

// The footer GHL appends when a sub-account's SMS-compliance toggles are on.
const COMPLIANCE_RE = /(reply|txt|text)\s+"?stop"?\s+to\s+(unsubscribe|opt[\s-]*out|cancel)/i;

// A footer older than this is history, not a live setting: the account was
// probably already fixed. Both scans only look this far back.
const COMPLIANCE_FRESH_DAYS = 7;

const COMPLIANCE_FIX =
  "Open the sub-account in GHL → Settings → Phone Numbers → Advanced Settings → " +
  "turn OFF the SMS compliance / opt-out language toggles, so texts stop carrying the bot-looking footer.";

// ── Layer 1: cheap scan of already-synced conversations ─────────────────────
// Catches accounts where a recent conversation ENDED on the footer message.
export async function scanComplianceSynced(svc: Svc): Promise<number> {
  const since = new Date(Date.now() - COMPLIANCE_FRESH_DAYS * 86400_000).toISOString();
  const { data } = await svc
    .from("ghl_conversations")
    .select("owner_key, location_id, last_message_body, last_message_date, contact_id")
    .eq("last_message_direction", "outbound")
    .gte("last_message_date", since)
    .or(
      "last_message_body.ilike.%stop to unsubscribe%," +
      "last_message_body.ilike.%stop to opt out%," +
      "last_message_body.ilike.%stop to opt-out%," +
      "last_message_body.ilike.%stop to cancel%"
    )
    .limit(2000);
  const byOwner = new Map<string, { loc: string; n: number; sample: string; latest: string; contactId: string | null }>();
  for (const r of (data ?? []) as Array<{ owner_key: string; location_id: string; last_message_body: string; last_message_date: string; contact_id: string | null }>) {
    if (!COMPLIANCE_RE.test(r.last_message_body ?? "")) continue;
    const cur = byOwner.get(r.owner_key);
    if (cur) {
      cur.n++;
      if (r.last_message_date > cur.latest) { cur.latest = r.last_message_date; cur.sample = r.last_message_body; cur.contactId = r.contact_id ?? null; }
    } else {
      byOwner.set(r.owner_key, { loc: r.location_id, n: 1, sample: r.last_message_body, latest: r.last_message_date, contactId: r.contact_id ?? null });
    }
  }
  let filed = 0;
  for (const [owner, v] of byOwner) {
    let leadName = "";
    if (v.contactId) {
      const { data: ct } = await svc.from("ghl_contacts").select("contact_name").eq("id", v.contactId).maybeSingle();
      leadName = String((ct as { contact_name?: string } | null)?.contact_name ?? "").trim();
    }
    const ok = await fileAlert(svc, {
      type: "compliance_text",
      title: `${owner}: "Reply STOP" opt-out footer going to leads (${v.n} recent text${v.n === 1 ? "" : "s"})`,
      detail: `Latest, sent to ${leadName || "a lead"} on ${new Date(v.latest).toLocaleDateString()}: "${v.sample.slice(0, 400)}"\n\nFix: ${COMPLIANCE_FIX}`,
      source_key: `loc:${v.loc}`,
      meta: {
        owner_key: owner, location_id: v.loc, count: v.n, latest: v.latest, via: "synced",
        contact_id: v.contactId, contact_name: leadName || null,
        link: v.contactId ? ghlContactUrl(v.loc, v.contactId) : null,
      },
      resurfaceAfterDays: 7, // still on a week after "resolved" → say it again
    });
    if (ok) filed++;
  }
  return filed;
}

// ── Layer 2: deep scan — read actual threads round-robin ────────────────────
// The footer rides on the FIRST outbound SMS of a thread, so once the workflow
// sends message #2 the synced last-message view no longer shows it. This layer
// opens the newest few threads of a rotating batch of accounts and greps the
// early outbound messages, so the whole fleet gets covered every ~1-2 days.
const DEEP_ACCOUNTS_PER_RUN = 12;
const DEEP_CONVS_PER_ACCOUNT = 4;

export async function scanComplianceDeep(svc: Svc): Promise<{ accounts: number; filed: number }> {
  let accounts: V3Account[] = [];
  try { accounts = (await getV3Accounts()).sort((a, b) => a.ownerKey.localeCompare(b.ownerKey)); } catch { return { accounts: 0, filed: 0 }; }
  if (!accounts.length) return { accounts: 0, filed: 0 };

  const { data: st } = await svc.from("alert_scan_state").select("compliance_cursor").eq("id", 1).maybeSingle();
  const cursor = (st?.compliance_cursor ?? 0) % accounts.length;
  const batch: V3Account[] = [];
  for (let i = 0; i < Math.min(DEEP_ACCOUNTS_PER_RUN, accounts.length); i++) {
    batch.push(accounts[(cursor + i) % accounts.length]);
  }
  await svc.from("alert_scan_state").upsert({
    id: 1,
    compliance_cursor: (cursor + batch.length) % accounts.length,
    updated_at: new Date().toISOString(),
  });

  let filed = 0;
  for (const acct of batch) {
    try {
      // Newest conversations from the synced table (no extra API call).
      const { data: convs } = await svc
        .from("ghl_conversations")
        .select("id, last_message_date, contact_id")
        .eq("location_id", acct.locationId)
        .order("last_message_date", { ascending: false })
        .limit(DEEP_CONVS_PER_ACCOUNT);
      if (!convs?.length) continue;

      // Always prefer the marketplace-app token: keys-sheet private tokens
      // often lack conversations/message.readonly, and getThread then returns
      // [] — the account would look clean while sending footers all day.
      const app = await getAppLocationToken(acct.locationId);
      const token = app.token ?? (acct.viaAgency ? null : acct.token);
      if (!token) continue;
      for (const c of convs as Array<{ id: string; contact_id?: string | null }>) {
        const thread = await getThread({ locationId: acct.locationId, token }, c.id);
        // Only a RECENT footer proves the toggle is still on. Scanning whole
        // threads with no date check re-raised an August message weeks after
        // the account was fixed (linda deleon, user report 2026-09-06).
        const hit = thread.find(
          (m) =>
            m.direction === "outbound" &&
            COMPLIANCE_RE.test(m.body) &&
            !!m.dateAdded &&
            Date.now() - new Date(m.dateAdded).getTime() <= COMPLIANCE_FRESH_DAYS * 86400_000
        );
        if (!hit) continue;
        // Name the lead who actually received it — "which contact?" was the
        // first question this alert raised (user, 2026-09-05).
        let leadName = "";
        if (c.contact_id) {
          const { data: ct } = await svc.from("ghl_contacts").select("contact_name").eq("id", c.contact_id).maybeSingle();
          leadName = String((ct as { contact_name?: string } | null)?.contact_name ?? "").trim();
        }
        await fileAlert(svc, {
          type: "compliance_text",
          title: `${acct.ownerKey}: "Reply STOP" opt-out footer going to leads`,
          detail: `Sent to ${leadName || "a lead"} on ${new Date(hit.dateAdded!).toLocaleDateString()}: "${hit.body.slice(0, 400)}"\n\nFix: ${COMPLIANCE_FIX}`,
          source_key: `loc:${acct.locationId}`,
          meta: {
            owner_key: acct.ownerKey, location_id: acct.locationId, via: "deep", conversation_id: c.id,
            contact_id: c.contact_id ?? null,
            contact_name: leadName || null,
            link: c.contact_id ? ghlContactUrl(acct.locationId, c.contact_id) : null,
          },
          resurfaceAfterDays: 7,
        });
        filed++;
        break; // one alert per account is enough
      }
    } catch { /* one bad account never stops the sweep */ }
  }
  return { accounts: batch.length, filed };
}

// ── Duplicate leads ─────────────────────────────────────────────────────────
// Leads arrive twice — once by webhook, once by the sheet — and are reconciled
// by identityKeys(). That reconciliation silently broke once (a blank phone on
// one side split every lead in two, inflating 147 clients' lead counts for
// weeks before anyone noticed). This watchdog counts duplicates directly, so a
// regression shows up on the board within a day instead of by eye.
export async function scanDuplicateLeads(svc: Svc): Promise<number> {
  const { data, error } = await svc.rpc("duplicate_lead_count", { days: 7 });
  if (error) return 0;
  const rows = (data ?? []) as Array<{ biz: string; extra: number }>;
  const worst = rows.filter((r) => Number(r.extra) > 0).sort((a, b) => Number(b.extra) - Number(a.extra));
  const extra = worst.reduce((t, r) => t + Number(r.extra), 0);
  // A couple of stragglers is normal timing between the two writers; a real
  // regression shows up across many clients at once.
  if (worst.length < 5 || extra < 20) return 0;
  const ok = await fileAlert(svc, {
    type: "data_quality",
    severity: "high",
    title: `Duplicate leads are back — ${extra} extra rows across ${worst.length} clients (last 7 days)`,
    detail:
      `Lead counts on Performance and Cost/Deposit read high while this is happening.\n\n` +
      `Worst affected: ${worst.slice(0, 8).map((r) => `${r.biz} (+${r.extra})`).join(", ")}.\n\n` +
      `Cause to check first: the webhook copy and the sheet copy of a lead are no longer ` +
      `matching in identityKeys() — usually a field present on one side and blank on the other.`,
    source_key: "dupe-leads",
    resurfaceAfterDays: 3,
  });
  return ok ? 1 : 0;
}

// ── Ingestion health ────────────────────────────────────────────────────────
// The Google Sheets step was removed from both Make scenarios on 2026-09-08,
// so GHL -> Make -> /api/webhooks is now the ONLY path for leads and calls.
// If it stops, nothing else catches the data, so silence has to be loud.
//
// The rule needs no historical baseline: alert when a window is completely
// empty AND the previous day proves the pipeline was working. That cannot fire
// on a quiet night unless delivery has genuinely stopped.
const INGEST_WINDOW_HOURS = 6;
const INGEST_PROOF_OF_LIFE = 20; // rows in the prior 24h before we trust silence

export async function scanIngestHealth(svc: Svc): Promise<number> {
  const { data, error } = await svc.rpc("ingest_health", { hours: INGEST_WINDOW_HOURS });
  if (error) return 0;
  const rows = (data ?? []) as Array<{ source: string; recent: number; prior_24h: number }>;
  let filed = 0;
  for (const r of rows) {
    const recent = Number(r.recent), prior = Number(r.prior_24h);
    if (recent > 0 || prior < INGEST_PROOF_OF_LIFE) continue;
    const label = r.source === "calls" ? "Calls" : "Leads";
    const ok = await fileAlert(svc, {
      type: "data_quality",
      severity: "high",
      title: `${label} have stopped reaching the dashboard — nothing for ${INGEST_WINDOW_HOURS} hours`,
      detail:
        `${prior} ${r.source} arrived in the 24 hours before this window, then nothing.\n\n` +
        `Since the Google Sheet step was removed, GoHighLevel \u2192 Make \u2192 dashboard is the only ` +
        `path, so anything not delivered now is not recorded anywhere else.\n\n` +
        `Check the Make scenario (${r.source === "calls" ? "CC - Outgoing Call, 1227003" : "CC- Funnel Survey, 1250213"}): ` +
        `is it still Active, and does its "Incomplete executions" tab have items to replay?`,
      source_key: `ingest-stopped:${r.source}`,
      resurfaceAfterDays: 1,
    });
    if (ok) filed++;
  }
  return filed;
}

// ── Make.com: scenarios switched off or with incomplete executions ──────────
export async function scanMakeScenarios(svc: Svc): Promise<{ checked: number; filed: number; error?: string }> {
  const token = process.env.MAKE_API_TOKEN;
  if (!token) return { checked: 0, filed: 0, error: "MAKE_API_TOKEN not set" };
  const zones = process.env.MAKE_ZONE ? [process.env.MAKE_ZONE] : ["us1", "us2", "eu1", "eu2"];
  let zone = zones[0];
  const mk = async (path: string) => {
    const r = await fetch(`https://${zone}.make.com/api/v2${path}`, {
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
    });
    return { ok: r.ok, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };

  type Scenario = Record<string, unknown>;
  const scenarios: Scenario[] = [];
  const teamIds: string[] = [];
  for (const z of zones) {
    zone = z;
    const orgs = await mk(`/organizations`);
    const orgList = (orgs.json.organizations as Array<Record<string, unknown>> | undefined) ?? [];
    if (!orgs.ok || !orgList.length) continue;
    for (const o of orgList) {
      const teams = await mk(`/teams?organizationId=${o.id}`);
      for (const t of ((teams.json.teams as Array<Record<string, unknown>> | undefined) ?? [])) {
        teamIds.push(String(t.id));
        const sc = await mk(`/scenarios?teamId=${t.id}`);
        for (const s of ((sc.json.scenarios as Array<Record<string, unknown>> | undefined) ?? [])) scenarios.push(s);
      }
    }
    if (scenarios.length) break;
  }
  if (!scenarios.length) return { checked: 0, filed: 0, error: "no scenarios visible via the Make API" };

  let filed = 0;
  for (const s of scenarios) {
    const id = String(s.id ?? "");
    const name = String(s.name ?? `scenario ${id}`);
    // Off = automations silently not running. Make flips isActive/isPaused
    // depending on API version, so treat either signal as "off".
    const active = s.isActive === true && s.isPaused !== true;
    if (!active) {
      const ok = await fileAlert(svc, {
        type: "make_scenario",
        title: `Make.com: "${name}" is turned OFF`,
        detail: "The scenario is not running — anything it automates (deposits to the sheet, lead routing, notifications) is silently stopped. Turn it back on in the Make editor, or resolve this alert if it is off on purpose.",
        source_key: `make-off:${id}`,
        meta: { scenario_id: id, name, zone },
        // No resurface: resolving means "off on purpose" — many scenarios
        // (Make's auto-created Integration testers, retired experiments) stay
        // off forever and must not nag weekly. A scenario that gets turned ON
        // and later OFF again is a new problem, but a rare one; the DLQ alert
        // below still catches anything that breaks while running.
      });
      if (ok) filed++;
    }
  }

  // Incomplete executions (DLQ) = runs that ERRORED and are waiting. A few is
  // normal noise; alert when a scenario has a pile.
  const dlqByScenario = new Map<string, { name: string; n: number; reason: string }>();
  for (const tid of teamIds) {
    const dlq = await mk(`/dlqs?teamId=${tid}&pg%5Blimit%5D=100`);
    for (const d of ((dlq.json.dlqs as Array<Record<string, unknown>> | undefined) ?? [])) {
      const sc = (d.scenario as Record<string, unknown> | undefined) ?? {};
      const sid = String(d.scenarioId ?? sc.id ?? "");
      if (!sid) continue;
      const cur = dlqByScenario.get(sid) ?? { name: String(sc.name ?? `scenario ${sid}`), n: 0, reason: "" };
      cur.n++;
      if (!cur.reason && typeof d.reason === "string") cur.reason = d.reason;
      dlqByScenario.set(sid, cur);
    }
  }
  for (const [sid, v] of dlqByScenario) {
    if (v.n < 3) continue; // ignore one-off hiccups
    const ok = await fileAlert(svc, {
      type: "make_scenario",
      severity: "medium",
      title: `Make.com: "${v.name}" has ${v.n}+ failed runs waiting`,
      detail: `Incomplete executions are piling up${v.reason ? ` (latest error: ${v.reason.slice(0, 200)})` : ""}. Open the scenario's incomplete-executions list in Make to see what broke. Do NOT bulk-retry while the database is slow.`,
      source_key: `make-dlq:${sid}`,
      meta: { scenario_id: sid, name: v.name, count: v.n },
      resurfaceAfterDays: 2,
    });
    if (ok) filed++;
  }
  return { checked: scenarios.length, filed };
}

// ── Onboarding pipeline alerts (main sub-account) ───────────────────────────
// 1. onboarding_overdue: launch call happened 3+ BUSINESS days ago and the
//    client still isn't Live in Clients Master.
// 2. launch_call_missing: moved into 🎉 Closed Paying Client / 🧾 Pay Per
//    Appointment 7+ days ago with NO launch call on the 🚀 Launch Call
//    calendar (past or future).
const MAIN_LOC = "SfpNMJ5YU9lBkxss47lK";
const LAUNCH_CAL_ID = "cxvzMMBnJvcp0LK6CYsy";
const SALES_PIPELINE_ID = "YA9eFBz6BVKNN8381dbx";
const STAGE_CLOSED_PAYING = "7b9d4113-8bbb-4394-a736-024dea2c11bb";
const STAGE_PAY_PER_APPT = "867aa647-7ce0-48e1-90a9-c7d3674544c5";

const nameNorm = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
function nameMatches(a: string, b: string): boolean {
  const at = nameNorm(a).split(" ").filter((t) => t.length >= 2);
  const bt = nameNorm(b).split(" ").filter((t) => t.length >= 2);
  if (!at.length || !bt.length) return false;
  const [small, big] = at.length <= bt.length ? [at, bt] : [bt, at];
  const hits = small.filter((t) => big.includes(t)).length;
  return hits >= Math.min(2, small.length);
}
function businessDaysSince(iso: string): number {
  let n = 0;
  const cur = new Date(iso);
  const now = new Date();
  while (cur < now) {
    cur.setDate(cur.getDate() + 1);
    const w = cur.getDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

const GHL = "https://services.leadconnectorhq.com";
const ghlHeaders = (token: string, v: string) => ({ Authorization: `Bearer ${token}`, Version: v, Accept: "application/json" });

export async function scanOnboardingPipeline(svc: Svc): Promise<{ overdue: number; missingCall: number; resolved?: number; error?: string }> {
  const app = await getAppLocationToken(MAIN_LOC);
  if (!app.token) return { overdue: 0, missingCall: 0, error: `main token: ${app.error}` };
  const tok = app.token;
  const now = Date.now();
  const teamFor = await loadTeamLookup(svc);

  // Launch-call events: past 45d (for overdue checks) + next 60d (scheduled).
  const evR = await fetch(
    `${GHL}/calendars/events?locationId=${MAIN_LOC}&calendarId=${LAUNCH_CAL_ID}&startTime=${now - 90 * 86400_000}&endTime=${now + 60 * 86400_000}`,
    { headers: ghlHeaders(tok, "2021-04-15") }
  );
  const events = evR.ok
    ? (((await evR.json()).events ?? []) as Array<Record<string, unknown>>).filter(
        (e) => !/cancel/i.test(String(e.appointmentStatus ?? ""))
      )
    : [];
  // A dead or empty calendar read must not be mistaken for "nobody has a
  // launch call" — on 2026-09-19 one such blip filed 7 false "no launch call"
  // alerts (incl. clients who were long Live). Only trust a non-empty list.
  const eventsTrusted = evR.ok && events.length > 0;

  // Clients Master snapshot (owner -> status), for the "is it Live yet" check.
  const { data: cm } = await svc.from("clients_master").select("data");
  const clients = ((cm ?? []) as Array<{ data: Record<string, unknown> }>).map((r) => ({
    owner: String(r.data?.["Owner Full Name"] ?? "").trim(),
    status: String(r.data?.["col_1"] ?? "").trim().toLowerCase(),
  })).filter((c) => c.owner);

  // Match by 2-token overlap first; fall back to a UNIQUE long-token match
  // (handles GHL-vs-sheet name drift like "Henry Nordenflycht" vs
  // "Henry Von Norden").
  const findClient = (cname: string) => {
    let match = clients.find((c) => nameMatches(c.owner, cname));
    if (!match) {
      const toks = nameNorm(cname).split(" ").filter((t) => t.length >= 4);
      for (const t of toks) {
        const hits = clients.filter((c) => nameNorm(c.owner).split(" ").includes(t));
        if (hits.length === 1) { match = hits[0]; break; }
      }
    }
    return match;
  };
  // Any non-blank status (live/paused/offboarded/lost) means the account
  // was set up at some point — only blank/"onboarding" is truly stuck.
  const isStuck = (match: { status: string } | undefined) =>
    !match || match.status === "" || match.status === "onboarding";

  // 1. Overdue onboarding: confirmed launch call 3+ business days past, client not Live.
  let overdue = 0;
  const seenContacts = new Set<string>();
  for (const e of events) {
    const start = String(e.startTime ?? "");
    if (!start || new Date(start).getTime() > now) continue;
    // Only recent launches (21 days): an old call belongs to a client who
    // already launched and later paused/offboarded — not an onboarding case.
    if (now - new Date(start).getTime() > 21 * 86400_000) continue;
    const bd = businessDaysSince(start);
    // They get THREE FULL business days (Mon–Fri) after the launch call — the
    // alert fires on business day 4, not during day 3 (user request 2026-09-01).
    if (bd < 4) continue;
    const contactId = String(e.contactId ?? "");
    if (!contactId || seenContacts.has(contactId)) continue;
    seenContacts.add(contactId);
    // Resolve the contact's name for the clients-master match.
    let cname = String(e.title ?? "").replace(/launch call( with)?( -)?/i, "").trim();
    try {
      const cr = await fetch(`${GHL}/contacts/${contactId}`, { headers: ghlHeaders(tok, "2021-07-28") });
      if (cr.ok) {
        const cj = (await cr.json()) as { contact?: { firstName?: string; lastName?: string } };
        const full = `${cj.contact?.firstName ?? ""} ${cj.contact?.lastName ?? ""}`.trim();
        if (full) cname = full;
      }
    } catch { /* fall back to the event title */ }
    const match = findClient(cname);
    if (!isStuck(match)) continue;
    const ok = await fileAlert(svc, {
      type: "onboarding",
      title: `${cname}: not LIVE ${bd} business days after the launch call`,
      detail: `Launch call was ${start.slice(0, 10)}. The 3-business-day launch window has passed and Clients Master ${match ? `still shows status "${match.status || "(blank)"}"` : "has no row for them"}. Get the account live or update the status.`,
      source_key: `launch-overdue:${contactId}`,
      meta: {
        contact_id: contactId, contact_name: cname, launch_call: start,
        clients_master_status: match?.status ?? null,
        link: ghlContactUrl(MAIN_LOC, contactId),
        ...(() => { const t = teamFor(cname); return t ? { csm: t.assigned, media_buyer: t.mediaBuyer } : {}; })(),
      },
      resurfaceAfterDays: 3, // nags every few days until they're Live
    });
    if (ok) overdue++;
  }

  // 2. Missing launch call: 7+ days in Closed Paying Client / Pay Per Appointment, no launch call at all.
  let missingCall = 0;
  const eventContactIds = new Set(events.map((e) => String(e.contactId ?? "")));
  let page: string | null = `${GHL}/opportunities/search?location_id=${MAIN_LOC}&pipeline_id=${SALES_PIPELINE_ID}&limit=100`;
  const opps: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 5 && page; i++) {
    const r = await fetch(page, { headers: ghlHeaders(tok, "2021-07-28") });
    if (!r.ok) break;
    const j = (await r.json()) as { opportunities?: Array<Record<string, unknown>>; meta?: { nextPageUrl?: string } };
    opps.push(...(j.opportunities ?? []));
    page = j.meta?.nextPageUrl ?? null;
  }
  for (const o of opps) {
    if (!eventsTrusted) break; // can't tell who has a call — file nothing
    const stageId = String(o.pipelineStageId ?? "");
    if (stageId !== STAGE_CLOSED_PAYING && stageId !== STAGE_PAY_PER_APPT) continue;
    const entered = String(o.lastStageChangeAt ?? o.updatedAt ?? "");
    if (!entered) continue;
    const daysIn = (now - new Date(entered).getTime()) / 86400_000;
    // Only entries the 90-day event window fully covers: >7d overdue but
    // <45d old (older entries' launch calls can predate the window).
    if (daysIn < 7 || daysIn > 45) continue;
    const contactId = String(o.contactId ?? (o.contact as Record<string, unknown> | undefined)?.id ?? "");
    if (contactId && eventContactIds.has(contactId)) continue;
    const oname = String(o.name ?? (o.contact as Record<string, unknown> | undefined)?.name ?? "unknown");
    if (/test/i.test(oname)) continue; // internal test contacts
    // Name-level fallback (launch call sometimes booked under a second contact record).
    const byName = events.some((e) => nameMatches(String(e.title ?? ""), oname));
    if (byName) continue;
    const stageName = stageId === STAGE_CLOSED_PAYING ? "🎉 Closed Paying Client" : "🧾 Pay Per Appointment";
    const ok = await fileAlert(svc, {
      type: "onboarding",
      title: `${oname}: no launch call ${Math.floor(daysIn)} days after moving to ${stageName}`,
      detail: `They entered "${stageName}" on ${entered.slice(0, 10)} and there is NO 🚀 Launch Call booked for them (past or upcoming). Get their launch call scheduled.`,
      source_key: `launch-missing:${contactId || oname}`,
      meta: {
        contact_id: contactId, contact_name: oname, stage: stageName, entered,
        link: contactId ? ghlContactUrl(MAIN_LOC, contactId) : null,
        ...(() => { const t = teamFor(oname); return t ? { csm: t.assigned, media_buyer: t.mediaBuyer } : {}; })(),
      },
      resurfaceAfterDays: 7,
    });
    if (ok) missingCall++;
  }

  // 3. Clear alerts that stopped being true (owner request 2026-09-21: "at the
  //    moment their status went live it should remove those alerts").
  //    launch-overdue → the client now has a real status in Clients Master.
  //    launch-missing → a launch call exists for them now, or they're already
  //    set up (status not blank/onboarding) so the call no longer matters.
  let resolved = 0;
  const { data: open } = await svc.from("alerts").select("id, source_key, meta").eq("type", "onboarding").eq("status", "open");
  const toClose: Array<{ id: string; why: string }> = [];
  for (const a of (open ?? []) as Array<{ id: string; source_key: string; meta: Record<string, unknown> | null }>) {
    const cname = String(a.meta?.contact_name ?? "").trim();
    const contactId = String(a.meta?.contact_id ?? "").trim();
    const client = cname ? findClient(cname) : undefined;
    const setUp = !isStuck(client);
    if (a.source_key.startsWith("launch-overdue:")) {
      if (setUp) toClose.push({ id: a.id, why: `status is ${client!.status}` });
    } else if (a.source_key.startsWith("launch-missing:")) {
      const hasCall = eventsTrusted && (
        (!!contactId && eventContactIds.has(contactId)) ||
        (!!cname && events.some((e) => nameMatches(String(e.title ?? ""), cname)))
      );
      if (hasCall) toClose.push({ id: a.id, why: "launch call booked" });
      else if (setUp) toClose.push({ id: a.id, why: `status is ${client!.status}` });
    }
  }
  for (const c of toClose) {
    const { error } = await svc.from("alerts")
      .update({ status: "resolved", resolved_by: `system (${c.why})`, resolved_at: new Date().toISOString() })
      .eq("id", c.id).eq("status", "open");
    if (!error) resolved++;
  }
  return { overdue, missingCall, resolved };
}

/* ── Agreement not signed ──────────────────────────────────────────────
   A Standard-program client who goes LIVE from now on without a signed
   agreement gets an alert that stays open until it's signed (user request
   2026-09-14). "From now on" is real: the first run seeds every client
   already live as baseline and never alerts on them; only owners who turn
   Live after that are checked. Signed = Clients Master "Agreement" is
   true / a date, or a matching row in the Signed Agreements sheet. Program
   = the financing sheet's Payment Status (PPS/PPA → PPS; anything else,
   including no row, is Standard). */
export async function scanAgreementMissing(svc: Svc): Promise<{ seeded: number; newlyLive: number; filed: number; resolved: number }> {
  const [{ data: cm }, { data: seen }, { data: pay }, { data: signed }] = await Promise.all([
    svc.from("clients_master").select("data"),
    svc.from("client_live_seen").select("owner_key, baseline, first_seen_live_at"),
    svc.from("client_payments").select("owner_key, payment_status"),
    svc.from("signed_agreements").select("data"),
  ]);
  const live = ((cm ?? []) as Array<{ data: Record<string, unknown> }>)
    .map((r) => {
      const owner = String(r.data?.["Owner Full Name"] ?? "").trim();
      const agreement = String(r.data?.["Agreement"] ?? "").trim().toLowerCase();
      return {
        owner, key: normalizeOwnerKey(owner),
        business: String(r.data?.["Business Name"] ?? "").trim(),
        status: String(r.data?.["col_1"] ?? "").trim().toLowerCase(),
        assigned: String(r.data?.["Assigned"] ?? "").trim(),
        // "true" or a date = signed; "false" / blank = not signed.
        agreementSigned: agreement === "true" || /\d{1,2}\/\d{1,2}\/\d{4}/.test(agreement),
      };
    })
    .filter((c) => c.key && c.status === "live");

  const signedNames = ((signed ?? []) as Array<{ data: Record<string, unknown> }>)
    .map((r) => String(r.data?.["Full Name"] ?? "").trim()).filter(Boolean);
  const pps = new Set(((pay ?? []) as Array<{ owner_key: string; payment_status: string | null }>)
    .filter((p) => /pps|ppa/i.test(String(p.payment_status ?? ""))).map((p) => p.owner_key));
  const seenMap = new Map(((seen ?? []) as Array<{ owner_key: string; baseline: boolean; first_seen_live_at: string }>).map((r) => [r.owner_key, r]));

  // First run: everyone live today is the baseline — no alerts for them, ever.
  const firstRun = seenMap.size === 0;
  const unseen = live.filter((c) => !seenMap.has(c.key));
  if (unseen.length) {
    await svc.from("client_live_seen").upsert(
      unseen.map((c) => ({ owner_key: c.key, owner_name: c.owner, baseline: firstRun })),
      { onConflict: "owner_key" }
    );
  }
  if (firstRun) return { seeded: unseen.length, newlyLive: 0, filed: 0, resolved: 0 };

  let filed = 0, resolved = 0, newlyLive = 0;
  for (const c of live) {
    const rec = seenMap.get(c.key);
    if (rec?.baseline) continue; // was live before this check existed
    newlyLive++;
    const isSigned = c.agreementSigned || signedNames.some((n) => nameMatches(n, c.owner));
    const key = `agreement-missing:${c.key}`;
    if (isSigned || pps.has(c.key)) {
      // Signed since (or turned out to be PPS): close the open alert quietly.
      const { data: open } = await svc.from("alerts").select("id").eq("type", "agreement").eq("source_key", key).eq("status", "open");
      if (open?.length) {
        await svc.from("alerts").update({ status: "resolved", resolved_by: "system (agreement signed)", resolved_at: new Date().toISOString() })
          .in("id", open.map((o) => o.id));
        resolved += open.length;
      }
      continue;
    }
    const liveSince = String(rec?.first_seen_live_at ?? "").slice(0, 10);
    const ok = await fileAlert(svc, {
      type: "agreement",
      severity: "high",
      title: `${c.owner}${c.business ? ` — ${c.business}` : ""}: LIVE on Standard with NO signed agreement`,
      detail: `Went Live ${liveSince || "recently"} on the Standard program and the agreement is not signed (Clients Master "Agreement" is not true and no row in Signed Agreements). Get it signed — this alert clears itself once it is.`,
      source_key: key,
      meta: { owner: c.owner, business: c.business, live_since: liveSince, csm: c.assigned || null },
      resurfaceAfterDays: 3,
    });
    if (ok) filed++;
  }
  return { seeded: 0, newlyLive, filed, resolved };
}


/* Leads arriving for a client whose Clients-sheet status is NOT Live
   (Paused, blank, Offboarded): ads are running but nobody flipped the
   status, so the client is invisible to billing, coaching and the
   dashboards. Alert once leads have been coming in for 2+ days with the
   status unchanged (owner, 2026-09-21); clears itself when the status
   turns Live. Lead dates come from the sheet's own Date column — synced_at
   is not a lead date (the Sep-19 migration re-stamped it). */
export async function scanLeadsWhileNotLive(svc: Svc): Promise<{ checked: number; filed: number; resolved: number; error?: string }> {
  const { data: rows, error } = await svc.rpc("ask_ai_query", {
    q: `WITH cm AS (
           SELECT trim(data->>'Business Name') AS biz,
                  coalesce(nullif(trim(data->>'col_1'), ''), '(blank)') AS status,
                  trim(data->>'Owner Full Name') AS owner,
                  trim(data->>'Assigned') AS assigned
           FROM clients_master),
         l AS (
           SELECT trim(data->>'Business Name') AS biz, to_date(data->>'Date', 'DD/MM/YYYY') AS d
           FROM leads_master
           WHERE data->>'Date' ~ '^\\d{1,2}/\\d{1,2}/\\d{4}'),
         a AS (
           SELECT biz,
                  count(*) FILTER (WHERE d > current_date - 7)::int AS n7,
                  min(d) FILTER (WHERE d > current_date - 7) AS first7,
                  max(d) AS last
           FROM l GROUP BY biz)
         SELECT cm.status, cm.biz, cm.owner, cm.assigned, a.n7, a.first7::text AS first7, a.last::text AS last
         FROM cm JOIN a ON lower(a.biz) = lower(cm.biz)
         WHERE cm.status NOT IN ('Live', 'Onboarding') AND a.n7 > 0`,
  });
  if (error) return { checked: 0, filed: 0, resolved: 0, error: error.message };
  type R = { status: string; biz: string; owner: string; assigned: string; n7: number; first7: string; last: string };
  const list = (rows ?? []) as R[];
  let filed = 0, resolved = 0;
  const DAY = 86_400_000;
  const flagged = new Set<string>();
  for (const r of list) {
    const key = `leads-not-live:${r.biz.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const daysRunning = Math.floor((Date.now() - new Date(r.first7).getTime()) / DAY);
    const stale = Date.now() - new Date(r.last).getTime() > 3 * DAY; // leads stopped → nothing to chase
    if (daysRunning < 2 || stale) continue;
    flagged.add(key);
    const ok = await fileAlert(svc, {
      type: "status",
      severity: "high",
      title: `${r.biz}: getting leads but status is ${r.status === "(blank)" ? "EMPTY" : r.status.toUpperCase()}`,
      detail: `${r.n7} lead${r.n7 === 1 ? "" : "s"} in the last 7 days (since ${r.first7}, latest ${r.last}) while the Clients sheet says "${r.status}". Ads are running for a client nobody marked Live — set the status on the Clients tab (or pause the ads). Clears itself once the status is Live.`,
      source_key: key,
      meta: { business: r.biz, owner: r.owner || null, status: r.status, leads_7d: r.n7, first_lead: r.first7, last_lead: r.last, csm: r.assigned || null },
      resurfaceAfterDays: 7,
    });
    if (ok) filed++;
  }
  // Status turned Live (or leads stopped): close the open alerts quietly.
  const { data: open } = await svc.from("alerts").select("id, source_key").eq("type", "status").eq("status", "open");
  const toClose = (open ?? []).filter((o) => !flagged.has(String(o.source_key))).map((o) => o.id);
  if (toClose.length) {
    await svc.from("alerts").update({ status: "resolved", resolved_by: "system (status is Live / leads stopped)", resolved_at: new Date().toISOString() }).in("id", toClose);
    resolved = toClose.length;
  }
  return { checked: list.length, filed, resolved };
}
