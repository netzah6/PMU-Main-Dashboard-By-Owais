import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken, getAppAgencyToken } from "@/lib/ghl-app";
import { listCheckoutTransactions } from "@/lib/fanbasis";

// Auto-verify an onboarding's technical setup. For each checklist step we CAN
// inspect programmatically (funnel pages, Fanbasis product, GHL custom values,
// the sheets), we return pass/fail with a reason. Steps that live in external
// tools we can't reach (Facebook, Make.com, CloseBot, physical phone/A2P) are
// returned as "manual" so the UI shows them as still-your-job rather than
// pretending they passed.

export type CheckStatus = "pass" | "fail" | "manual" | "skip";
export type Check = { key: string; status: CheckStatus; detail: string };

const BASE = "https://services.leadconnectorhq.com";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// Steps that no API can confirm — always manual.
const MANUAL_STEPS = new Set([
  "ghl_snapshot", "form_reactivation", "form_pictures",
  "phone_buy", "phone_a2p", "phone_cnam", "phone_optout", "phone_forward", "phone_callerid", "phone_sms_adv",
  "user_add", "user_password", "user_permissions", "user_voicemail", "user_phone",
  "wf_assign", "wf_area", "wf_pictures",
  "cal_team", "cal_location", "cal_availability", "cal_lookbusy",
  "make_http", "make_filter", "fb_campaign",
  "cb_source", "cb_shutoff", "cb_override", "cb_agent", "cb_tag", "cb_restrictions",
  "later_calendar", "later_availability", "funnel_ig_widget",
]);

async function ghlGet(url: string, token: string, version = "2021-07-28") {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Version: version, Accept: "application/json" } });
    return { ok: r.ok, status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch { return { ok: false, status: 0, json: {} as Record<string, unknown> }; }
}

// Resolve a business name to its GHL location id (clients_master/ghl_sync_status
// first, then a live GHL locations search for brand-new sub-accounts).
async function resolveLocationId(business: string): Promise<string | null> {
  const svc = createServiceClient();
  const bn = norm(business);
  const { data: cm } = await svc.from("clients_master").select("data");
  let owner: string | null = null;
  for (const r of (cm ?? []) as Array<{ data: Record<string, unknown> }>) {
    if (norm(String(r.data?.["Business Name"] ?? "")) === bn) { owner = String(r.data?.["Owner Full Name"] ?? "").trim().toLowerCase(); break; }
  }
  if (owner) {
    const { data: ss } = await svc.from("ghl_sync_status").select("location_id").eq("owner_key", owner).maybeSingle();
    if (ss?.location_id) return ss.location_id as string;
  }
  const agency = await getAppAgencyToken();
  if (agency) {
    const r = await ghlGet(`${BASE}/locations/search?limit=500`, agency.token);
    for (const loc of (r.json.locations as Array<Record<string, unknown>> | undefined) ?? []) {
      if (norm(String(loc.name ?? "")) === bn) return String(loc.id ?? loc._id ?? "") || null;
    }
  }
  return null;
}

export async function verifyOnboarding(form: Record<string, unknown>, opts: { locationId?: string | null } = {}): Promise<{ checks: Check[]; locationId: string | null; depositUrl: string | null }> {
  const business = String(form.business_name ?? "").trim();
  const productId = String(form.product_id ?? "").trim();
  const address = String(form.address ?? "").trim();
  const checks: Check[] = [];
  const push = (key: string, status: CheckStatus, detail: string) => checks.push({ key, status, detail });

  // Sheet-side checks (fast, no external calls).
  const svc = createServiceClient();
  const bn = norm(business);
  const { data: cm } = await svc.from("clients_master").select("data");
  const inMaster = ((cm ?? []) as Array<{ data: Record<string, unknown> }>).some((r) => norm(String(r.data?.["Business Name"] ?? "")) === bn);
  push("fin_master", inMaster ? "pass" : "fail", inMaster ? "Client is in the Master sheet" : "Not found in the Master sheet");

  const locationId = (opts.locationId && String(opts.locationId).trim()) || (await resolveLocationId(business));
  const { data: ss } = locationId
    ? await svc.from("ghl_sync_status").select("location_id").eq("location_id", locationId).maybeSingle()
    : { data: null };
  push("fin_keys", ss ? "pass" : "manual", ss ? "Sub-account is connected (location tracked)" : "Couldn't confirm the keys-sheet/location entry");

  // Pull the live funnel URL from the sub-account's custom values.
  let depositUrl: string | null = null;
  if (locationId) {
    const tok = await getAppLocationToken(locationId);
    if (tok.token) {
      const cv = await ghlGet(`${BASE}/locations/${locationId}/customValues`, tok.token);
      for (const v of (cv.json.customValues as Array<Record<string, unknown>> | undefined) ?? []) {
        const nm = String(v.name ?? "").toLowerCase();
        const val = String(v.value ?? "");
        if (nm.includes("deposit funnel url") && val.startsWith("http")) { depositUrl = val.trim(); break; }
      }
    }
  }

  if (!depositUrl) {
    for (const k of ["ghl_domain", "funnel_domain", "funnel_path", "funnel_product_id", "funnel_redirect", "funnel_map", "ghl_pixel"])
      push(k, "fail", locationId ? "No deposit funnel URL set in the sub-account" : "Couldn't resolve the sub-account");
  } else {
    // Fetch the deposit page and grade the funnel-side steps.
    let html = "";
    let httpOk = false;
    try {
      const r = await fetch(depositUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      httpOk = r.ok; html = await r.text();
    } catch { /* httpOk stays false */ }

    push("ghl_domain", httpOk ? "pass" : "fail", httpOk ? `Domain live: ${depositUrl}` : `Deposit page didn't load (${depositUrl})`);
    push("funnel_domain", httpOk ? "pass" : "fail", httpOk ? "Funnel is on pmu-care.com" : "Funnel domain not resolving");

    // The 4 funnel paths share a base; swap the last-step suffix to probe the others.
    const base = depositUrl.replace(/-last-step.*$/, "");
    const paths = { "📝 Survey": "-survey", "📅 Booking": "-booking", "🎉 Thank You": "-thank-you" } as Record<string, string>;
    const pathResults: string[] = httpOk ? ["Last-Step ✓"] : ["Last-Step ✗"];
    for (const [label, suffix] of Object.entries(paths)) {
      try { const r = await fetch(base + suffix, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } }); pathResults.push(`${label.split(" ")[1]} ${r.ok ? "✓" : "✗"}`); }
      catch { pathResults.push(`${label.split(" ")[1]} ✗`); }
    }
    const allPaths = !pathResults.some((p) => p.includes("✗"));
    push("funnel_path", allPaths ? "pass" : "fail", pathResults.join(" · "));

    const pidMatch = html.match(/PRODUCT_ID\s*=\s*['"]([^'"]+)['"]/);
    if (!pidMatch) push("funnel_product_id", "fail", "No PRODUCT_ID found on the deposit page");
    else if (productId && pidMatch[1] !== productId) push("funnel_product_id", "fail", `Page PRODUCT_ID ${pidMatch[1]} ≠ onboarding product ${productId}`);
    else push("funnel_product_id", "pass", `PRODUCT_ID ${pidMatch[1]}${productId ? " matches Fanbasis" : ""}`);

    const redir = html.match(/REDIRECT_URL\s*=\s*['"]([^'"]+)['"]/);
    const redirOk = !!redir && /thank-?you/i.test(redir[1]);
    push("funnel_redirect", redirOk ? "pass" : "fail", redir ? `REDIRECT_URL = ${redir[1]}${redirOk ? "" : " (not a thank-you path)"}` : "No REDIRECT_URL set");

    const hasMap = /google\.com\/maps|maps\.googleapis|full_business_address/i.test(html) || (address ? html.includes(address.split(",")[0]) : false);
    push("funnel_map", hasMap ? "pass" : "manual", hasMap ? "Map/address present" : "Couldn't detect the map address");

    const hasPixel = /fbq\(|connect\.facebook\.net\/.*fbevents/i.test(html);
    push("ghl_pixel", hasPixel ? "pass" : "fail", hasPixel ? "Facebook pixel present" : "No Facebook pixel on the funnel");
  }

  // Fanbasis product exists?
  if (!productId) push("fanbasis_product", "manual", "No Fanbasis Product ID on the onboarding form");
  else {
    try { await listCheckoutTransactions(productId); push("fanbasis_product", "pass", `Fanbasis product ${productId} exists`); }
    catch (e) { push("fanbasis_product", "fail", `Fanbasis product ${productId} not reachable: ${e instanceof Error ? e.message.slice(0, 80) : ""}`); }
  }
  push("fin_fanbasis_amount", "manual", "Verify the deposit amount is set back to the correct value");

  // Everything else lives in external tools — mark manual.
  for (const key of MANUAL_STEPS) if (!checks.some((c) => c.key === key)) push(key, "manual", "Check manually — no automated verification");

  return { checks, locationId, depositUrl };
}
