import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appConfigured, getAppAgencyToken, getAppLocationToken } from "@/lib/ghl-app";

export const maxDuration = 60;

// Health check for the onboarding-automation integrations:
// GHL agency token, Fanbasis API key, CloseBot API key.
// Also discovers the "Clean New Account" sub-account pool.
// Auth: logged-in dashboard user OR Bearer CRON_SECRET (for ops checks).

type CheckResult = { ok: boolean; detail: string; extra?: unknown };

async function checkGhlAgency(): Promise<CheckResult & { pool?: { id: string; name: string }[] }> {
  const token = process.env.GHL_AGENCY_TOKEN;
  if (!token) return { ok: false, detail: "GHL_AGENCY_TOKEN not set" };
  try {
    const r = await fetch("https://services.leadconnectorhq.com/locations/search?limit=500", {
      headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}: ${text.slice(0, 200)}` };
    const j = JSON.parse(text) as { locations?: Array<{ id?: string; _id?: string; name?: string }> };
    const locations = j.locations ?? [];
    const pool = locations
      .filter((l) => /clean new account/i.test(String(l.name ?? "")))
      .map((l) => ({ id: String(l.id ?? l._id ?? ""), name: String(l.name ?? "") }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { ok: true, detail: `${locations.length} sub-accounts visible · ${pool.length} clean pool accounts found`, pool };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "request failed" };
  }
}

async function checkFanbasis(): Promise<CheckResult> {
  const key = process.env.FANBASIS_API_KEY;
  if (!key) return { ok: false, detail: "FANBASIS_API_KEY not set" };
  try {
    const r = await fetch("https://www.fanbasis.com/public-api/products", {
      headers: { "x-api-key": key, Accept: "application/json" },
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}: ${text.slice(0, 200)}` };
    let count: number | null = null;
    try {
      const j = JSON.parse(text);
      const arr = Array.isArray(j) ? j : j.products ?? j.data ?? j.results ?? null;
      if (Array.isArray(arr)) count = arr.length;
    } catch { /* body shape unknown — reachability is enough */ }
    return { ok: true, detail: count != null ? `connected · ${count} products visible` : "connected" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "request failed" };
  }
}

async function checkClosebot(): Promise<CheckResult> {
  const key = process.env.CLOSEBOT_API_KEY;
  if (!key) return { ok: false, detail: "CLOSEBOT_API_KEY not set" };
  try {
    const r = await fetch("https://api.closebot.com/agency/current", {
      headers: { "X-CB-KEY": key, Accept: "application/json" },
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}: ${text.slice(0, 200)}` };
    let name = "";
    try { name = String((JSON.parse(text) as { name?: string }).name ?? ""); } catch { /* ok */ }
    // Source count is useful context for the pool pre-provisioning plan.
    let sources: number | null = null;
    try {
      const sr = await fetch("https://api.closebot.com/agency/source?pageSize=1", {
        headers: { "X-CB-KEY": key, Accept: "application/json" },
      });
      if (sr.ok) sources = Number(((await sr.json()) as { total?: number }).total ?? NaN) || null;
    } catch { /* best-effort */ }
    return { ok: true, detail: `connected${name ? ` · agency "${name}"` : ""}${sources != null ? ` · ${sources} sources` : ""}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "request failed" };
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronOk = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [ghlAgency, fanbasis, closebot] = await Promise.all([
    checkGhlAgency(),
    checkFanbasis(),
    checkClosebot(),
  ]);

  // Marketplace app: configured? installed? can it mint a location token?
  let ghlApp: CheckResult = { ok: false, detail: "GHL_APP_CLIENT_ID/SECRET not set" };
  if (appConfigured()) {
    try {
      const agency = await getAppAgencyToken();
      if (!agency) {
        ghlApp = { ok: false, detail: "configured but not installed yet — visit /api/oauth/start" };
      } else {
        const probe = ghlAgency.pool?.[0]
          ? await getAppLocationToken(ghlAgency.pool[0].id)
          : { error: "no pool account to probe" };
        ghlApp = probe.token
          ? { ok: true, detail: `installed · location tokens working (probed ${ghlAgency.pool?.[0]?.name})` }
          : { ok: false, detail: `installed but location token failed: ${probe.error}` };
      }
    } catch (e) {
      ghlApp = { ok: false, detail: e instanceof Error ? e.message : "check failed" };
    }
  }

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    ghlAgency: { ok: ghlAgency.ok, detail: ghlAgency.detail, pool: ghlAgency.pool ?? [] },
    ghlApp,
    fanbasis,
    closebot,
  });
}
