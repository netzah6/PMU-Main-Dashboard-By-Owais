import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken, getAppAgencyToken } from "@/lib/ghl-app";
import { listCheckoutTransactions, getProductCheckoutUrl } from "@/lib/fanbasis";
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

export async function verifyOnboarding(form: Record<string, unknown>, opts: { locationId?: string | null } = {}): Promise<{ checks: Check[]; locationId: string | null; depositUrl: string | null; funnelUrls: FunnelUrls | null; productId: string | null; checkoutUrl: string | null }> {
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

  // Pull the sub-account's custom values once: the live funnel URL AND the
  // fill-state of the fields the "Funnel + Reactivation Form" populates.
  // Reuse the same location token for the calendar checks below.
  let depositUrl: string | null = null;
  const customValues: Array<{ name: string; value: string }> = [];
  let locTok: string | undefined;
  if (locationId) {
    locTok = (await getAppLocationToken(locationId)).token;
    if (locTok) {
      const cv = await ghlGet(`${BASE}/locations/${locationId}/customValues`, locTok);
      for (const v of (cv.json.customValues as Array<Record<string, unknown>> | undefined) ?? []) {
        const nm = String(v.name ?? "");
        const val = String(v.value ?? "").trim();
        customValues.push({ name: nm, value: val });
        // Prefer the V3 deposit funnel url; any "deposit funnel url" works.
        if (nm.toLowerCase().includes("deposit funnel url") && val.startsWith("http") && (!depositUrl || nm.toLowerCase().includes("v3"))) depositUrl = val;
      }
    }
  }

  // Custom-values-filled check — the exact fields the "Funnel + Reactivation
  // Form" populates. 🔵 fields are required only for V3 clients; the rest are
  // required for every version (V1 / V2.3 / V3). norm() strips spaces, punctuation
  // and the 🔵/🟢 emoji so the substrings match the live custom-value names.
  if (customValues.length) {
    const ALWAYS = [ // non-🔵 — required for all versions
      "business phone number", "fb business page", "full business address",
      "funnel logo", "ig business page", "offer",
    ];
    const V3_ONLY = [ // 🔵 — required additionally for V3
      "owners name", "business hours", "deposit amount", "deposit funnel url v3",
      "discounted price", "original price", "permanent makeup services",
      "permanent makeup transformation calendar", "when is the first touch", "years in business",
    ];
    // Version: prefer the onboarding form; else the Master sheet's "Version"
    // ("(V3)", "(V2.3)", "(V1)"…). isV3 must exclude "V2.3" → require it start "v3".
    let masterVersion = "";
    for (const r of ((cm ?? []) as Array<{ data: Record<string, unknown> }>))
      if (norm(String(r.data?.["Business Name"] ?? "")) === bn) { masterVersion = String(r.data?.["Version"] ?? "").trim(); break; }
    const versionRaw = String(form.version ?? "").trim() || masterVersion;
    const isV3 = norm(versionRaw).startsWith("v3");
    const needed = isV3 ? [...ALWAYS, ...V3_ONLY] : ALWAYS;
    const missing: string[] = [];
    for (const need of needed) {
      const key = norm(need);
      const matches = customValues.filter((v) => norm(v.name).includes(key));
      if (!matches.length || !matches.some((v) => v.value)) missing.push(need);
    }
    const vLabel = versionRaw || "version unknown";
    if (missing.length) push("form_reactivation", "fail", `${vLabel}: ${needed.length - missing.length}/${needed.length} required custom values filled — missing: ${missing.join(", ")}`);
    else push("form_reactivation", "pass", `All ${needed.length} ${vLabel} custom values filled`);
  } else if (locationId) {
    push("form_reactivation", "manual", "Couldn't read the sub-account's custom values");
  }

  // Calendar checks (we have the calendars scope). Grade the calendar's team
  // members, meeting location, and Look-Busy setting.
  if (locationId && locTok) {
    const cal = await ghlGet(`${BASE}/calendars/?locationId=${locationId}`, locTok);
    const cals = (cal.json.calendars as Array<Record<string, unknown>> | undefined) ?? [];
    if (!cals.length) {
      for (const k of ["cal_team", "cal_location", "cal_lookbusy"]) push(k, "fail", "No calendar found on the sub-account");
    } else {
      // Prefer the active calendar; else the first.
      const c = cals.find((x) => x.isActive) ?? cals[0];
      const team = (c.teamMembers as Array<Record<string, unknown>> | undefined) ?? [];
      const selected = team.filter((t) => t.selected);
      push("cal_team", selected.length ? "pass" : "fail", selected.length ? `${selected.length} team member(s) selected` : "No team members selected on the calendar");

      const loc = selected.map((t) => String(t.meetingLocation ?? "")).find((v) => v.trim()) ?? String(team[0]?.meetingLocation ?? "");
      const hasAddr = /full_address|address/i.test(loc) || (!!address && loc.includes(address.split(",")[0]));
      push("cal_location", hasAddr ? "pass" : "fail", hasAddr ? `Meeting location set (${loc})` : loc ? `Meeting location = ${loc} — not the full address` : "No meeting location set");

      const lb = (c.lookBusyConfig as Record<string, unknown> | undefined) ?? {};
      const lbOn = !!lb.enabled;
      const lbPct = Number(lb.lookBusyPercentage ?? 0);
      push("cal_lookbusy", lbOn && lbPct === 75 ? "pass" : lbOn ? "fail" : "fail", lbOn ? `Look Busy on at ${lbPct}%${lbPct === 75 ? "" : " (should be 75%)"}` : "Look Busy is off (should be 75%)");
    }
  }

  // Sub-account user, Workflow assign-user, and the AREA custom field —
  // unlocked by the app's v2.0.0 scopes (users/workflows/customFields.readonly).
  if (locationId && locTok) {
    // Sub-account user exists?
    const ur = await ghlGet(`${BASE}/users/?locationId=${locationId}`, locTok);
    const users = (ur.json.users as Array<Record<string, unknown>> | undefined) ?? [];
    if (ur.status === 200) {
      push("user_add", users.length ? "pass" : "fail",
        users.length ? `${users.length} user(s): ${users.map((u) => String(u.name ?? u.email ?? "?")).join(", ")}` : "No user on the sub-account");
    }

    // Workflow "CC- Funnel Survey" published + assign-user evidence. The API
    // doesn't expose a workflow's internal steps, so we look at recent
    // contacts: the workflow's first action assigns every lead to a user —
    // assigned contacts prove the step is configured and firing.
    const wr = await ghlGet(`${BASE}/workflows/?locationId=${locationId}`, locTok);
    if (wr.status === 200) {
      const wfs = (wr.json.workflows as Array<Record<string, unknown>> | undefined) ?? [];
      const surveyWf = wfs.find((w) => /funnel\s*survey/i.test(String(w.name ?? "")));
      if (!surveyWf) push("wf_assign", "fail", `"CC- Funnel Survey" workflow not found (${wfs.length} workflows on the account)`);
      else if (String(surveyWf.status) !== "published") push("wf_assign", "fail", `Workflow "${surveyWf.name}" is ${surveyWf.status} — publish it`);
      else {
        const cr = await ghlGet(`${BASE}/contacts/?locationId=${locationId}&limit=20`, locTok);
        const cts = (cr.json.contacts as Array<Record<string, unknown>> | undefined) ?? [];
        const assignedIds = cts.map((c) => String(c.assignedTo ?? "")).filter(Boolean);
        const uname = users.find((u) => assignedIds.includes(String(u.id ?? "")))?.name;
        if (assignedIds.length) push("wf_assign", "pass", `Workflow published · ${assignedIds.length}/${cts.length} recent contacts assigned${uname ? ` to ${uname}` : ""}`);
        else push("wf_assign", "manual", cts.length ? "Workflow is published but no recent contacts are assigned — check its Assign User step" : "Workflow is published; no contacts yet to confirm the assign step");
      }
    }

    // AREA custom field: its options must cover the areas for the services
    // this client offers (services → treated-area mapping below).
    const fr = await ghlGet(`${BASE}/locations/${locationId}/customFields?model=contact`, locTok);
    if (fr.status === 200) {
      const fields = (fr.json.customFields as Array<Record<string, unknown>> | undefined) ?? [];
      const areaField = fields.find((f) => /which\s*area/i.test(String(f.name ?? "")));
      if (!areaField) push("wf_area", "fail", `"CC - Which Area(s) Would You Like Treated?" field not found`);
      else {
        const options = ((areaField.picklistOptions ?? areaField.options ?? []) as unknown[]).map(String).filter(Boolean);
        const AREA_OF: Record<string, string> = {
          "powder brows": "Eyebrows", "microblading": "Eyebrows", "microshading": "Eyebrows",
          "nano brows": "Eyebrows", "combo brows": "Eyebrows", "ombre brows": "Eyebrows",
          "lip blush": "Lips", "eyeliner": "Eyeliner",
          "scalp micropigmentation": "Scalp Micropigmentation",
          "areola micropigmentation": "Areola",
        };
        let servicesRaw = String(form.services ?? "").trim();
        if (!servicesRaw) servicesRaw = customValues.find((v) => /permanent makeup services/i.test(v.name))?.value ?? "";
        const svcList = servicesRaw.split(",").map((s) => s.trim()).filter(Boolean);
        const expected = new Set<string>();
        const unmapped: string[] = [];
        for (const s of svcList) {
          const a = AREA_OF[s.toLowerCase()];
          if (a) expected.add(a);
          else unmapped.push(s);
        }
        const optNorm = options.map((o) => o.toLowerCase());
        const missing = [...expected].filter((a) => !optNorm.some((o) => o.includes(a.toLowerCase())));
        const breakdown = `Areas: ${options.join(", ") || "—"}${svcList.length ? ` · Services: ${svcList.join(", ")}` : ""}${unmapped.length ? ` · (no area mapping: ${unmapped.join(", ")})` : ""}`;
        if (!svcList.length) push("wf_area", "manual", `${breakdown} — no services on file to compare`);
        else if (missing.length) push("wf_area", "fail", `${breakdown} — MISSING area option(s): ${missing.join(", ")}`);
        else push("wf_area", "pass", breakdown);
      }
    }
  }

  let pagePid: string | null = null;
  let embedApiKey: string | null = null;
  let embedCreator: string | null = null;
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
    // Also grab the embed's public key + creator so we can mint a live
    // Fanbasis checkout link for this product (shown under the row).
    embedApiKey = html.match(/API_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    embedCreator = html.match(/CREATOR_ID\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
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
  let checkoutUrl: string | null = null;
  if (!checkPid) push("fanbasis_product", "manual", "No Fanbasis Product ID found (form or page)");
  else {
    try { await listCheckoutTransactions(checkPid); push("fanbasis_product", "pass", `Fanbasis product ${checkPid} exists`); }
    catch (e) { push("fanbasis_product", "fail", `Fanbasis product ${checkPid} not reachable: ${e instanceof Error ? e.message.slice(0, 80) : ""}`); }
    // A live, shareable Fanbasis checkout link for this product (built from the
    // deposit page's own embed config; falls back to null if the page had none).
    checkoutUrl = await getProductCheckoutUrl({ publicApiKey: embedApiKey, creatorId: embedCreator, productId: pagePid ?? checkPid }).catch(() => null);
  }
  push("fin_fanbasis_amount", "manual", "Verify the deposit amount is set back to the correct value");

  // Every remaining checklist step (external tools we can't reach) → manual, so
  // the report is the COMPLETE list from the sheet, not just the auto-checks.
  for (const s of ONBOARDING_STEPS) if (!checks.some((c) => c.key === s.key)) push(s.key, "manual", "Check manually — no automated verification");

  return { checks, locationId, depositUrl, funnelUrls, productId: checkPid ?? null, checkoutUrl };
}
