import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken, getAppAgencyToken } from "@/lib/ghl-app";
import { listCheckoutTransactions } from "@/lib/fanbasis";
import { ONBOARDING_STEPS } from "@/lib/onboarding-steps";

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

export type FunnelUrls = { survey: string; booking: string; lastStep: string; thankYou: string };

export async function verifyOnboarding(form: Record<string, unknown>, opts: { locationId?: string | null } = {}): Promise<{ checks: Check[]; locationId: string | null; depositUrl: string | null; funnelUrls: FunnelUrls | null; productId: string | null }> {
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

  let pagePid: string | null = null;
  let funnelUrls: FunnelUrls | null = null;
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
    funnelUrls = { survey: base + "-survey", booking: base + "-booking", lastStep: depositUrl, thankYou: base + "-thank-you" };
    const paths = { "📝 Survey": "-survey", "📅 Booking": "-booking", "🎉 Thank You": "-thank-you" } as Record<string, string>;
    const pathResults: string[] = httpOk ? ["Last-Step ✓"] : ["Last-Step ✗"];
    for (const [label, suffix] of Object.entries(paths)) {
      try { const r = await fetch(base + suffix, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } }); pathResults.push(`${label.split(" ")[1]} ${r.ok ? "✓" : "✗"}`); }
      catch { pathResults.push(`${label.split(" ")[1]} ✗`); }
    }
    const allPaths = !pathResults.some((p) => p.includes("✗"));
    push("funnel_path", allPaths ? "pass" : "fail", pathResults.join(" · "));

    const pidMatch = html.match(/PRODUCT_ID\s*=\s*['"]([^'"]+)['"]/);
    if (pidMatch) pagePid = pidMatch[1];
    if (!pidMatch) push("funnel_product_id", "fail", "No PRODUCT_ID found on the deposit page");
    else if (productId && pidMatch[1] !== productId) push("funnel_product_id", "fail", `Page PRODUCT_ID ${pidMatch[1]} ≠ onboarding product ${productId}`);
    else push("funnel_product_id", "pass", `PRODUCT_ID ${pidMatch[1]}${productId ? " matches Fanbasis" : ""}`);

    // REDIRECT_URL must be THIS client's own thank-you page — e.g. deposit
    // "browology-plus-last-step" ⇒ redirect should be "browology-plus-thank-you",
    // not a generic "thank-you-873467". So it must contain the client's funnel
    // slug AND "thank-you".
    const baseSlug = base.split("/").pop() ?? ""; // e.g. "browology-plus"
    const redir = html.match(/REDIRECT_URL\s*=\s*['"]([^'"]+)['"]/);
    const rv = redir ? redir[1] : "";
    const hasTY = /thank-?you/i.test(rv);
    const isClients = !!baseSlug && norm(rv).includes(norm(baseSlug));
    if (!redir) push("funnel_redirect", "fail", "No REDIRECT_URL set on the deposit page");
    else if (!hasTY) push("funnel_redirect", "fail", `REDIRECT_URL = ${rv} — not a thank-you page`);
    else if (baseSlug && !isClients) push("funnel_redirect", "fail", `REDIRECT_URL = ${rv} — points to a generic thank-you, not this client's (${baseSlug}-thank-you)`);
    else push("funnel_redirect", "pass", `REDIRECT_URL → ${rv}`);

    const hasMap = /google\.com\/maps|maps\.googleapis|full_business_address/i.test(html) || (address ? html.includes(address.split(",")[0]) : false);
    push("funnel_map", hasMap ? "pass" : "manual", hasMap ? "Map/address present" : "Couldn't detect the map address");

    const hasPixel = /fbq\(|connect\.facebook\.net\/.*fbevents/i.test(html);
    push("ghl_pixel", hasPixel ? "pass" : "fail", hasPixel ? "Facebook pixel present" : "No Facebook pixel on the funnel");

    // Booking page: check the "Lead" conversion code AND the Instagram widget.
    if (funnelUrls) {
      try {
        const br = await fetch(funnelUrls.booking, { headers: { "User-Agent": "Mozilla/5.0" } });
        const bhtml = br.ok ? await br.text() : "";
        const hasLead = /fbq\s*\(\s*['"]track['"]\s*,\s*['"]Lead['"]/i.test(bhtml);
        push("funnel_lead_pixel", hasLead ? "pass" : "fail",
          hasLead ? "Booking page fires fbq('track','Lead')" : br.ok ? "Booking page is missing the fbq('track','Lead') code" : "Booking page didn't load");
        // IG widget is OPTIONAL ("only if IG looks good") — detected = pass, else neutral manual.
        const hasIg = /instagram\.com\/embed|instagram-media|lightwidget|snapwidget|elfsight|behold\.so|powr\.io/i.test(bhtml);
        push("funnel_ig_widget", hasIg ? "pass" : "manual",
          hasIg ? "Instagram widget detected on the booking page" : br.ok ? "No Instagram widget on the booking page (optional — add only if IG looks good)" : "Booking page didn't load");
      } catch { push("funnel_lead_pixel", "fail", "Couldn't load the booking page to check the Lead code"); }
    }
  }

  // Fanbasis product exists? Prefer the onboarding-form id; else the one the
  // live deposit page is actually using (so a name-only check still works).
  const checkPid = productId || pagePid;
  if (!checkPid) push("fanbasis_product", "manual", "No Fanbasis Product ID found (form or page)");
  else {
    try { await listCheckoutTransactions(checkPid); push("fanbasis_product", "pass", `Fanbasis product ${checkPid} exists`); }
    catch (e) { push("fanbasis_product", "fail", `Fanbasis product ${checkPid} not reachable: ${e instanceof Error ? e.message.slice(0, 80) : ""}`); }
  }
  push("fin_fanbasis_amount", "manual", "Verify the deposit amount is set back to the correct value");

  // Every remaining checklist step (external tools we can't reach) → manual, so
  // the report is the COMPLETE list from the sheet, not just the auto-checks.
  for (const s of ONBOARDING_STEPS) if (!checks.some((c) => c.key === s.key)) push(s.key, "manual", "Check manually — no automated verification");

  return { checks, locationId, depositUrl, funnelUrls, productId: checkPid ?? null };
}
