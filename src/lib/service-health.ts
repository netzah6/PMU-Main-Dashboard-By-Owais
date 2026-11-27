import Anthropic from "@anthropic-ai/sdk";
import { fileAlert } from "@/lib/alerts";
import { getAppLocationToken } from "@/lib/ghl-app";
import { getTabNames } from "@/lib/sheets";
import type { createServiceClient } from "@/lib/supabase/server";

/* Outside-service health (owner, 11/27/2026): "if any other software or
   anything doesn't work on our dashboard, you have to let me know" — after the
   picture service ran out of money for 3 days unnoticed.

   Every 30 minutes (alerts-scan) each paid/keyed service gets one cheap read.
   A service must fail TWICE IN A ROW before a box opens (one blip is not
   proof); the box closes by itself on the first good answer. One box per
   service, type `service_down`, with a button to where it is fixed. */

type Svc = ReturnType<typeof createServiceClient>;
type Probe = { ok: true; note?: string; warn?: string } | { ok: false; why: string };
type Check = { key: string; name: string; does: string; link: string; run: () => Promise<Probe> };

const STATE_KEY = "service_health";
const FAILS_TO_ALERT = 2;

async function http(url: string, init: RequestInit = {}, ms = 20_000): Promise<{ status: number; text: string }> {
  const r = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(ms) });
  // Full body (the Apify limits reply is ~1 KB of JSON); callers trim for display.
  return { status: r.status, text: (await r.text()).slice(0, 20_000) };
}
function fromHttp(r: { status: number; text: string }): Probe {
  return r.status >= 200 && r.status < 300 ? { ok: true } : { ok: false, why: `HTTP ${r.status}: ${r.text.slice(0, 240)}` };
}
const has = (k: string) => !!process.env[k];

/* Plain words for the owner — what kind of failure it is. */
export function plainReason(why: string): string {
  if (/usage limit|credit balance|insufficient|quota|billing|payment required|HTTP 402|exceeded/i.test(why)) return "it ran out of money or hit its monthly limit";
  if (/HTTP 401|HTTP 403|unauthori[sz]ed|invalid.*(key|token)|expired|revoked|not_authed|invalid_auth|token/i.test(why)) return "its login key stopped working";
  if (/not set/i.test(why)) return "its login key is missing";
  return "it is not answering";
}

export function checks(): Check[] {
  const list: Check[] = [];
  if (has("APIFY_TOKEN")) list.push({
    key: "apify", name: "Apify", does: "Instagram pictures on the funnels", link: "https://console.apify.com/billing/limits",
    run: async () => {
      const r = await http("https://api.apify.com/v2/users/me/limits", { headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` } });
      if (r.status !== 200) return fromHttp(r);
      try {
        const d = (JSON.parse(r.text) as { data?: { limits?: { maxMonthlyUsageUsd?: number }; current?: { monthlyUsageUsd?: number } } }).data;
        const max = Number(d?.limits?.maxMonthlyUsageUsd ?? 0), used = Number(d?.current?.monthlyUsageUsd ?? 0);
        if (max > 0 && used >= max) return { ok: false, why: `usage limit reached ($${used.toFixed(2)} of $${max.toFixed(2)})` };
        if (max > 0 && used >= max * 0.9) return { ok: true, warn: `$${used.toFixed(2)} of its $${max.toFixed(2)} monthly limit used` };
        return { ok: true, note: max ? `$${used.toFixed(2)} / $${max.toFixed(2)}` : `limit unreadable: ${r.text.slice(0, 300)}` };
      } catch { return { ok: true, note: `limit unreadable: ${r.text.slice(0, 300)}` }; }
    },
  });
  if (has("ANTHROPIC_API_KEY")) list.push({
    key: "anthropic", name: "Claude (AI)", does: "AI replies, picture sorting, call notes, AI tab", link: "https://console.anthropic.com/settings/billing",
    run: async () => {
      try {
        const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 30_000 });
        await c.messages.create({ model: process.env.HEALTH_MODEL || "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "ok" }] });
        return { ok: true };
      } catch (e) {
        const status = (e as { status?: number }).status;
        return { ok: false, why: `${status ? `HTTP ${status}: ` : ""}${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },
  });
  if (has("GOOGLE_PLACES_API_KEY")) list.push({
    key: "google_places", name: "Google reviews (Google Maps)", does: "Google reviews on the funnels", link: "https://console.cloud.google.com/billing",
    run: async () => {
      // "IDs only" detail read — Google's free tier, proves the key + billing work.
      const r = await http("https://places.googleapis.com/v1/places/ChIJN1t_tDeuEmsRUsoyG83frY4", {
        headers: { "X-Goog-Api-Key": String(process.env.GOOGLE_PLACES_API_KEY), "X-Goog-FieldMask": "id" },
      });
      return fromHttp(r);
    },
  });
  if (has("GHL_AGENCY_TOKEN")) list.push({
    key: "ghl_agency", name: "GoHighLevel (agency key)", does: "new client setup, account lists", link: "https://app.gohighlevel.com/",
    run: async () => fromHttp(await http("https://services.leadconnectorhq.com/locations/search?limit=1", {
      headers: { Authorization: `Bearer ${process.env.GHL_AGENCY_TOKEN}`, Version: "2021-07-28", Accept: "application/json" },
    })),
  });
  list.push({
    key: "ghl_app", name: "GoHighLevel (our app connection)", does: "leads, texts, bookings, funnels — almost everything", link: "https://marketplace.gohighlevel.com/",
    run: async () => {
      const loc = process.env.GHL_LOCATION_ID || "SfpNMJ5YU9lBkxss47lK";
      const t = await getAppLocationToken(loc);
      if (!t.token) return { ok: false, why: `token: ${t.error ?? "no token"}` };
      return fromHttp(await http(`https://services.leadconnectorhq.com/locations/${loc}`, { headers: { Authorization: `Bearer ${t.token}`, Version: "2021-07-28" } }));
    },
  });
  /* CloseBot is NOT checked: its dashboard key answers 401 on every address
     (11/27/2026), and only the read-only integrations status page uses it —
     the AI texting itself and the daily CloseBot check do not. Checking it
     would raise a box about nothing that matters. Re-add with a fresh key. */
  if (has("FANBASIS_API_KEY")) list.push({
    key: "fanbasis", name: "Fanbasis", does: "deposit payments on the funnels", link: "https://www.fanbasis.com/",
    run: async () => fromHttp(await http("https://www.fanbasis.com/public-api/products", { headers: { "x-api-key": String(process.env.FANBASIS_API_KEY), Accept: "application/json" } })),
  });
  if (has("SQUARE_ACCESS_TOKEN")) list.push({
    key: "square", name: "Square", does: "client payments, subscriptions, PPS charges", link: "https://squareup.com/dashboard/",
    run: async () => fromHttp(await http(`${process.env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com"}/v2/locations`, {
      headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, "Square-Version": "2024-07-17" },
    })),
  });
  if (has("SLACK_BOT_TOKEN")) list.push({
    key: "slack", name: "Slack", does: "Slack messages and the AI Agent button", link: "https://api.slack.com/apps",
    run: async () => {
      const r = await http("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
      try { const j = JSON.parse(r.text) as { ok?: boolean; error?: string }; return j.ok ? { ok: true } : { ok: false, why: `slack: ${j.error}` }; } catch { return fromHttp(r); }
    },
  });
  if (has("META_CAPI_TOKEN")) list.push({
    key: "meta", name: "Facebook (sales tracking)", does: "sending deposits back to Facebook ads", link: "https://business.facebook.com/settings/system-users",
    run: async () => fromHttp(await http(`https://graph.facebook.com/v19.0/me?access_token=${encodeURIComponent(String(process.env.META_CAPI_TOKEN))}`)),
  });
  if (has("MAKE_API_TOKEN")) list.push({
    key: "make", name: "Make.com", does: "payment routing and older automations", link: "https://www.make.com/",
    run: async () => {
      const zones = process.env.MAKE_ZONE ? [process.env.MAKE_ZONE] : ["us1", "us2", "eu1", "eu2"];
      let last: Probe = { ok: false, why: "no zone answered" };
      for (const z of zones) {
        last = fromHttp(await http(`https://${z}.make.com/api/v2/users/me`, { headers: { Authorization: `Token ${process.env.MAKE_API_TOKEN}` } }));
        if (last.ok) return last;
      }
      return last;
    },
  });
  if (has("SHEET1_ID") && (has("GOOGLE_SERVICE_ACCOUNT_JSON") || has("GOOGLE_PRIVATE_KEY"))) list.push({
    key: "google_sheets", name: "Google Sheets", does: "Clients Master and the other sheets", link: "https://console.cloud.google.com/iam-admin/serviceaccounts",
    run: async () => {
      try { const tabs = await getTabNames(String(process.env.SHEET1_ID)); return tabs.length ? { ok: true } : { ok: false, why: "sheet returned no tabs" }; }
      catch (e) { return { ok: false, why: e instanceof Error ? e.message : String(e) }; }
    },
  });
  return list;
}

type State = Record<string, { fails: number; lastWhy?: string; lastOk?: string; lastFail?: string }>;

export async function scanServiceHealth(svc: Svc): Promise<{ checked: number; down: string[]; warn: string[]; filed: number; resolved: number; results: Record<string, string> }> {
  const { data: row } = await svc.from("app_settings").select("value").eq("key", STATE_KEY).maybeSingle();
  const state: State = ((row?.value ?? {}) as State);
  const now = new Date().toISOString();
  const list = checks();
  const probes = await Promise.all(list.map(async (c) => {
    try { return [c, await c.run()] as const; } catch (e) { return [c, { ok: false, why: e instanceof Error ? e.message : String(e) } as Probe] as const; }
  }));
  const down: string[] = [], warn: string[] = [], results: Record<string, string> = {};
  let filed = 0, resolved = 0;
  for (const [c, p] of probes) {
    const s = state[c.key] ?? { fails: 0 };
    if (p.ok) {
      results[c.key] = p.warn ? `ok, warning: ${p.warn}` : `ok${p.note ? ` (${p.note})` : ""}`;
      state[c.key] = { fails: 0, lastOk: now, lastWhy: s.lastWhy, lastFail: s.lastFail };
      const { data: closed } = await svc.from("alerts")
        .update({ status: "resolved", resolved_by: `system (${c.name} working again)`, resolved_at: now })
        .eq("type", "service_down").eq("source_key", c.key).eq("status", "open").select("id");
      resolved += closed?.length ?? 0;
      if (p.warn) {
        warn.push(c.key);
        if (await fileAlert(svc, {
          type: "service_down", source_key: `${c.key}:near`, severity: "medium",
          title: `${c.name} is close to its monthly limit — ${p.warn}`,
          detail: `${c.name} runs: ${c.does}. When the limit is reached it stops. Raise the limit to avoid a gap.`,
          meta: { link: c.link, service: c.name }, resurfaceAfterDays: 7,
        })) filed++;
      } else {
        await svc.from("alerts").update({ status: "resolved", resolved_by: "system (usage back under 90%)", resolved_at: now })
          .eq("type", "service_down").eq("source_key", `${c.key}:near`).eq("status", "open");
      }
      continue;
    }
    const fails = s.fails + 1;
    state[c.key] = { fails, lastWhy: p.why.slice(0, 400), lastFail: now, lastOk: s.lastOk };
    results[c.key] = `FAIL ${fails}× — ${p.why.slice(0, 160)}`;
    if (fails < FAILS_TO_ALERT) continue;
    down.push(c.key);
    if (await fileAlert(svc, {
      type: "service_down", source_key: c.key, severity: "high",
      title: `${c.name} stopped working — ${plainReason(p.why)}`,
      detail: `What it runs: ${c.does}.\nFailing since: ${s.lastFail ?? now}${s.lastOk ? ` (last good check ${s.lastOk})` : ""}.\nThis box closes by itself once it works again.\n\nWhat the service said: ${p.why.slice(0, 400)}`,
      meta: { link: c.link, service: c.name },
      resurfaceAfterDays: 1,
    })) filed++;
  }
  await svc.from("app_settings").upsert({ key: STATE_KEY, value: state, updated_by: "service-health", updated_at: now });
  return { checked: list.length, down, warn, filed, resolved, results };
}
