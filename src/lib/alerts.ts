import { createServiceClient } from "@/lib/supabase/server";
import { getV3Accounts, type V3Account } from "@/lib/ghl-ingest";
import { getAppLocationToken } from "@/lib/ghl-app";
import { getThread } from "@/lib/ghl-conversations";

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
};

type Svc = ReturnType<typeof createServiceClient>;

export type NewAlert = {
  type: "compliance_text" | "upset_client" | "make_scenario";
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
    .select("id, status, resolved_at, created_at")
    .eq("type", a.type)
    .eq("source_key", a.source_key)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    if (existing.status === "open") return false;
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

// The footer GHL appends when a sub-account's SMS-compliance toggles are on.
const COMPLIANCE_RE = /(reply|txt|text)\s+"?stop"?\s+to\s+(unsubscribe|opt[\s-]*out|cancel)/i;

const COMPLIANCE_FIX =
  "Open the sub-account in GHL → Settings → Phone Numbers → Advanced Settings → " +
  "turn OFF the SMS compliance / opt-out language toggles, so texts stop carrying the bot-looking footer.";

// ── Layer 1: cheap scan of already-synced conversations ─────────────────────
// Catches accounts where a recent conversation ENDED on the footer message.
export async function scanComplianceSynced(svc: Svc): Promise<number> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data } = await svc
    .from("ghl_conversations")
    .select("owner_key, location_id, last_message_body, last_message_date")
    .eq("last_message_direction", "outbound")
    .gte("last_message_date", since)
    .or(
      "last_message_body.ilike.%stop to unsubscribe%," +
      "last_message_body.ilike.%stop to opt out%," +
      "last_message_body.ilike.%stop to opt-out%," +
      "last_message_body.ilike.%stop to cancel%"
    )
    .limit(2000);
  const byOwner = new Map<string, { loc: string; n: number; sample: string; latest: string }>();
  for (const r of (data ?? []) as Array<{ owner_key: string; location_id: string; last_message_body: string; last_message_date: string }>) {
    if (!COMPLIANCE_RE.test(r.last_message_body ?? "")) continue;
    const cur = byOwner.get(r.owner_key);
    if (cur) { cur.n++; if (r.last_message_date > cur.latest) { cur.latest = r.last_message_date; cur.sample = r.last_message_body; } }
    else byOwner.set(r.owner_key, { loc: r.location_id, n: 1, sample: r.last_message_body, latest: r.last_message_date });
  }
  let filed = 0;
  for (const [owner, v] of byOwner) {
    const ok = await fileAlert(svc, {
      type: "compliance_text",
      title: `${owner}: "Reply STOP" opt-out footer going to leads (${v.n} recent text${v.n === 1 ? "" : "s"})`,
      detail: `Latest example: "${v.sample.slice(0, 400)}"\n\nFix: ${COMPLIANCE_FIX}`,
      source_key: `loc:${v.loc}`,
      meta: { owner_key: owner, location_id: v.loc, count: v.n, latest: v.latest, via: "synced" },
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
        .select("id, last_message_date")
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
      for (const c of convs as Array<{ id: string }>) {
        const thread = await getThread({ locationId: acct.locationId, token }, c.id);
        const hit = thread.find((m) => m.direction === "outbound" && COMPLIANCE_RE.test(m.body));
        if (!hit) continue;
        await fileAlert(svc, {
          type: "compliance_text",
          title: `${acct.ownerKey}: "Reply STOP" opt-out footer going to leads`,
          detail: `Example text sent to a lead: "${hit.body.slice(0, 400)}"\n\nFix: ${COMPLIANCE_FIX}`,
          source_key: `loc:${acct.locationId}`,
          meta: { owner_key: acct.ownerKey, location_id: acct.locationId, via: "deep", conversation_id: c.id },
          resurfaceAfterDays: 7,
        });
        filed++;
        break; // one alert per account is enough
      }
    } catch { /* one bad account never stops the sweep */ }
  }
  return { accounts: batch.length, filed };
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
        resurfaceAfterDays: 7,
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
