import { getAppLocationToken, getAppAgencyToken } from "@/lib/ghl-app";
import { AREA_STATE, STATE_TZ } from "@/lib/onboarding-verify";

// Claim automation: turn a pre-provisioned "Clean New Account N" pool
// sub-account into a new client's account — rename it and fill its custom
// values from the onboarding form. The marketplace app is already installed
// on pool accounts, so data access continues automatically after the claim.

const GHL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

// ── Safety guards ───────────────────────────────────────────────────────────
// Writes are allowed ONLY on pool accounts. Two independent checks:
//  1. A hard blocklist — the main agency sub-account may NEVER be written to.
//  2. The target's CURRENT name must match the pool naming pattern (claiming)
//     or be the claim's own recorded location (un-claiming).
const PROTECTED_LOCATIONS = new Set([
  "SfpNMJ5YU9lBkxss47lK", // PMU Bookings On Demand — view-only, always
]);
export const POOL_NAME_RE = /^clean new account \d+$/i;

function assertNotProtected(locationId: string): void {
  if (PROTECTED_LOCATIONS.has(locationId)) {
    throw new Error(`Refusing to modify protected location ${locationId} (PMU Bookings On Demand)`);
  }
}

// ── Agency-token helpers ────────────────────────────────────────────────────
/* Agency-level auth: the GHL_AGENCY_TOKEN env when set, else the marketplace
   app's agency token (the env is missing on production — Retry of Sally's
   step 2 failed with "GHL_AGENCY_TOKEN not set", 10/16/2026). */
async function agencyHeaders(): Promise<Record<string, string>> {
  const token = process.env.GHL_AGENCY_TOKEN || (await getAppAgencyToken())?.token;
  if (!token) throw new Error("no agency token: GHL_AGENCY_TOKEN not set and the marketplace app is not connected");
  return { Authorization: `Bearer ${token}`, Version: VERSION, Accept: "application/json" };
}

export type PoolAccount = { id: string; name: string };

export async function discoverPool(): Promise<PoolAccount[]> {
  const r = await fetch(`${GHL}/locations/search?limit=500`, { headers: await agencyHeaders() });
  const text = await r.text();
  if (!r.ok) throw new Error(`locations/search HTTP ${r.status}: ${text.slice(0, 150)}`);
  const j = JSON.parse(text) as { locations?: Array<{ id?: string; _id?: string; name?: string }> };
  return (j.locations ?? [])
    .filter((l) => POOL_NAME_RE.test(String(l.name ?? "").trim()))
    .map((l) => ({ id: String(l.id ?? l._id ?? ""), name: String(l.name ?? "").trim() }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function getLocationName(locationId: string): Promise<string> {
  const r = await fetch(`${GHL}/locations/${locationId}`, { headers: await agencyHeaders() });
  const text = await r.text();
  if (!r.ok) throw new Error(`locations/${locationId} HTTP ${r.status}: ${text.slice(0, 150)}`);
  const j = JSON.parse(text) as { location?: { name?: string } };
  return String(j.location?.name ?? "").trim();
}

async function renameLocation(locationId: string, updates: Record<string, string>): Promise<void> {
  assertNotProtected(locationId);
  const r = await fetch(`${GHL}/locations/${locationId}`, {
    method: "PUT",
    headers: { ...(await agencyHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!r.ok) throw new Error(`rename HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// ── Custom values (via the marketplace-app location token) ─────────────────
type CustomValue = { id: string; name: string; value?: string };

async function listCustomValues(locationId: string, token: string): Promise<CustomValue[]> {
  const r = await fetch(`${GHL}/locations/${locationId}/customValues`, {
    headers: { Authorization: `Bearer ${token}`, Version: VERSION, Accept: "application/json" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`customValues HTTP ${r.status}: ${text.slice(0, 150)}`);
  const j = JSON.parse(text) as { customValues?: CustomValue[] };
  return j.customValues ?? [];
}

// Set a custom value by exact name. NEVER creates custom values — the team
// manages them manually in GHL; a missing one is reported, not invented.
export async function setExistingCustomValue(locationId: string, name: string, value: string): Promise<void> {
  assertNotProtected(locationId);
  const tok = await getAppLocationToken(locationId);
  if (!tok.token) throw new Error(`no app token: ${tok.error}`);
  const cvs = await listCustomValues(locationId, tok.token);
  const cv = cvs.find((c) => c.name === name);
  if (!cv) throw new Error(`custom value "${name}" is missing — create it manually in GHL`);
  await setCustomValue(locationId, tok.token, cv, value);
}

async function setCustomValue(locationId: string, token: string, cv: CustomValue, value: string): Promise<void> {
  assertNotProtected(locationId);
  const r = await fetch(`${GHL}/locations/${locationId}/customValues/${cv.id}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Version: VERSION, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ name: cv.name, value }),
  });
  if (!r.ok) throw new Error(`customValue "${cv.name}" HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
}

// ── Funnel URL convention ───────────────────────────────────────────────────
// Shared root domain (Apple Pay verified) + per-client paths derived from the
// business name: {slug}-survey / -booking / -last-step / -thank-you.
export const FUNNEL_DOMAIN = "https://pmu-care.com";
export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
export function funnelPaths(businessName: string): { survey: string; booking: string; deposit: string; thankyou: string } {
  const slug = slugify(businessName);
  return {
    survey: `${slug}-survey`,
    booking: `${slug}-booking`,
    deposit: `${slug}-last-step`,
    thankyou: `${slug}-thank-you`,
  };
}

// Map onboarding-form fields → custom-value name matchers (normalized:
// lowercase, alphanumeric only). First matching custom value wins.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
// URLs/links are never a value target for form amounts — the first test wrote
// the deposit amount into "CC - Deposit Funnel URL" without this exclusion.
const isUrlCv = (n: string) => n.includes("url") || n.includes("link");
// Matchers verified against the live snapshot's custom-value names
// (e.g. "CC - Deposit Amount 🔵", "CC - Original Price for Brows - (V3)🔵",
//  "CC - Full Business Address", "CC - Owner's Name (V3)🔵", "Business Name").
const CV_MAP: Array<{ formKey: string; match: (n: string) => boolean; label: string }> = [
  { formKey: "business_name", match: (n) => n === "businessname", label: "Business name" },
  { formKey: "owner_name", match: (n) => n.includes("ownersname") || n.includes("ownername"), label: "Owner name" },
  { formKey: "phone", match: (n) => n.includes("businessphone"), label: "Business phone" },
  { formKey: "offer", match: (n) => !isUrlCv(n) && (n === "ccoffer" || n.endsWith("offer")), label: "Offer" },
  { formKey: "deposit_amount", match: (n) => !isUrlCv(n) && n.includes("depositamount"), label: "Deposit amount" },
  /* Brows only (2026-10-08): "originalprice" alone now also matches the
     Lips / Eyeliner / Had-PMU values, and the first match wins. The form's
     brows prices also seed the Had-PMU pair (same price until the client
     gives a separate one). */
  { formKey: "original_price", match: (n) => !isUrlCv(n) && n.includes("originalprice") && (n.includes("newbrows") || n.includes("forbrows")), label: "Original price (new brows)" },
  { formKey: "discounted_price", match: (n) => !isUrlCv(n) && n.includes("discountedprice") && (n.includes("newbrows") || n.includes("forbrows")), label: "Discounted price (new brows)" },
  { formKey: "original_price", match: (n) => n.includes("originalpricebrowshadpmu"), label: "Original price (brows, had PMU)" },
  { formKey: "discounted_price", match: (n) => n.includes("discountedpricebrowshadpmu"), label: "Discounted price (brows, had PMU)" },
  { formKey: "product_id", match: (n) => !isUrlCv(n) && n.includes("product") && n.includes("id"), label: "Commas product ID" },
  { formKey: "address", match: (n) => !isUrlCv(n) && n.includes("address"), label: "Business address" },
  { formKey: "services", match: (n) => n.includes("permanentmakeupservices") || n.includes("pmuservices"), label: "PMU services" },
  { formKey: "ig_link", match: (n) => n.includes("igbusinesspagelink") || n.includes("igpagelink"), label: "IG page link" },
  { formKey: "fb_link", match: (n) => n.includes("fbbusinesspagelink") || n.includes("fbpagelink"), label: "FB page link" },
  { formKey: "gmb_link", match: (n) => n.includes("googlemybusiness"), label: "Google My Business link" },
  { formKey: "years_in_business", match: (n) => n.includes("yearsinbusiness"), label: "Years in business" },
  { formKey: "business_hours", match: (n) => n.includes("businesshours"), label: "Business hours" },
  { formKey: "first_touchup", match: (n) => n.includes("firsttouchup"), label: "First touch-up timing" },
  { formKey: "other_locations", match: (n) => n.includes("otherlocations"), label: "Other locations" },
  { formKey: "logo_url", match: (n) => n.includes("funnellogo"), label: "Funnel logo" },
  { formKey: "studio_pic_1", match: (n) => n.includes("pictureofstudio1"), label: "Studio picture 1" },
  { formKey: "studio_pic_2", match: (n) => n.includes("pictureofstudio2"), label: "Studio picture 2" },
  { formKey: "studio_pic_3", match: (n) => n.includes("pictureofstudio3"), label: "Studio picture 3" },
  { formKey: "eyebrows_ba_1", match: (n) => n.includes("eyebrowsbeforeafter1"), label: "Eyebrows B&A 1" },
  { formKey: "eyebrows_ba_2", match: (n) => n.includes("eyebrowsbeforeafter2"), label: "Eyebrows B&A 2" },
  { formKey: "eyebrows_ba_3", match: (n) => n.includes("eyebrowsbeforeafter3"), label: "Eyebrows B&A 3" },
  { formKey: "lipblush_ba_1", match: (n) => n.includes("lipblushbeforeafter1"), label: "Lip blush B&A 1" },
  { formKey: "lipblush_ba_2", match: (n) => n.includes("lipblushbeforeafter2"), label: "Lip blush B&A 2" },
  { formKey: "lipblush_ba_3", match: (n) => n.includes("lipblushbeforeafter3"), label: "Lip blush B&A 3" },
  { formKey: "eyeliner_ba_1", match: (n) => n.includes("eyelinerbeforeafter1"), label: "Eyeliner B&A 1" },
  { formKey: "eyeliner_ba_2", match: (n) => n.includes("eyelinerbeforeafter2"), label: "Eyeliner B&A 2" },
  { formKey: "eyeliner_ba_3", match: (n) => n.includes("eyelinerbeforeafter3"), label: "Eyeliner B&A 3" },
];

// Read-only listing for diagnostics / exact name mapping.
export async function listLocationCustomValues(locationId: string): Promise<Array<{ name: string; value?: string }>> {
  const tok = await getAppLocationToken(locationId);
  if (!tok.token) throw new Error(`no app token: ${tok.error}`);
  const cvs = await listCustomValues(locationId, tok.token);
  return cvs.map((c) => ({ name: c.name, value: c.value }));
}

// Targeted repair: set one custom value by exact name on a claimed location.
export async function repairCustomValue(locationId: string, name: string, value: string): Promise<void> {
  assertNotProtected(locationId);
  const tok = await getAppLocationToken(locationId);
  if (!tok.token) throw new Error(`no app token: ${tok.error}`);
  const cvs = await listCustomValues(locationId, tok.token);
  const cv = cvs.find((c) => c.name === name);
  if (!cv) throw new Error(`custom value "${name}" not found`);
  await setCustomValue(locationId, tok.token, cv, value);
}

// ── Employee user ───────────────────────────────────────────────────────────
// The client's own login for their sub-account. Permissions are copied live
// from the team's template user so GHL-side changes propagate automatically.
const TEMPLATE_USER_EMAIL = "mzrhynzh@gmail.com"; // "Demo Lastdemo"

// Password convention: FirstnameLastname1212! (e.g. "IvanAndrosov1212!")
export function employeePassword(ownerName: string): string {
  const compact = ownerName.trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("").replace(/[^a-zA-Z0-9]/g, "");
  return `${compact}1212!`;
}

export async function createEmployeeUser(locationId: string, ownerName: string, email: string): Promise<ClaimAction> {
  assertNotProtected(locationId);
  try {
    const agency = await getAppAgencyToken();
    if (!agency?.companyId) throw new Error("marketplace app not connected (no companyId)");

    // Template user → permissions to copy.
    const sr = await fetch(`${GHL}/users/search?companyId=${encodeURIComponent(agency.companyId)}&query=${encodeURIComponent(TEMPLATE_USER_EMAIL)}`, {
      headers: await agencyHeaders(),
    });
    const stext = await sr.text();
    if (!sr.ok) throw new Error(`users/search HTTP ${sr.status}: ${stext.slice(0, 150)}`);
    const sj = JSON.parse(stext) as { users?: Array<{ email?: string; permissions?: Record<string, boolean>; roles?: { role?: string } }> };
    const template = (sj.users ?? []).find((u) => (u.email ?? "").toLowerCase() === TEMPLATE_USER_EMAIL);
    if (!template?.permissions) throw new Error(`template user ${TEMPLATE_USER_EMAIL} not found (or has no permissions)`);

    const parts = ownerName.trim().split(/\s+/);
    const firstName = parts[0] ?? ownerName.trim();
    const lastName = parts.slice(1).join(" ") || "-";
    const password = employeePassword(ownerName);

    const r = await fetch(`${GHL}/users/`, {
      method: "POST",
      headers: { ...(await agencyHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: agency.companyId,
        firstName,
        lastName,
        email: email.trim(),
        password,
        type: "account",
        role: template.roles?.role === "admin" ? "admin" : "user",
        locationIds: [locationId],
        permissions: template.permissions,
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`users create HTTP ${r.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text) as { id?: string; _id?: string };
    const userId = String(j.id ?? j._id ?? "");
    return {
      action: `Employee user ${email.trim()} · password ${password} (permissions copied from ${TEMPLATE_USER_EMAIL})`,
      ok: true,
      userId: userId || undefined,
    };
  } catch (e) {
    return { action: "Employee user", ok: false, detail: e instanceof Error ? e.message : "failed" };
  }
}

// ── Password by the team rule, on a user that already exists ───────────────
// The New Client Setup run has the Mac Mini create the user (the owner
// approves that step first), then sets the real password here by API. The
// password is stored on the Onboarding card only — never in a chat or a
// screenshot.
export async function findLocationUserByEmail(locationId: string, email: string): Promise<{ id: string; name: string } | null> {
  const tok = await getAppLocationToken(locationId);
  if (!tok.token) throw new Error(`no app token: ${tok.error}`);
  const r = await fetch(`${GHL}/users/?locationId=${locationId}`, {
    headers: { Authorization: `Bearer ${tok.token}`, Version: VERSION, Accept: "application/json" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`users HTTP ${r.status}: ${text.slice(0, 150)}`);
  const j = JSON.parse(text) as { users?: Array<{ id?: string; _id?: string; email?: string; name?: string; firstName?: string; lastName?: string }> };
  const want = email.trim().toLowerCase();
  const u = (j.users ?? []).find((x) => String(x.email ?? "").trim().toLowerCase() === want);
  if (!u) return null;
  return { id: String(u.id ?? u._id ?? ""), name: String(u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`).trim() };
}

export async function setUserPassword(userId: string, password: string): Promise<void> {
  const r = await fetch(`${GHL}/users/${userId}`, {
    method: "PUT",
    headers: { ...(await agencyHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) throw new Error(`users/${userId} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// ── Treated-areas custom field ──────────────────────────────────────────────
// The funnel survey asks "Which Area(s) Would You Like Treated?" — its answer
// options are derived from the services chosen on the onboarding form:
// brow services collapse to "Eyebrows", Lip Blush → "Lips", everything else
// keeps its own name.
const BROW_SERVICES = new Set(["powder brows", "microblading", "microshading", "nano brows"]);
export function areasFromServices(services: string): string[] {
  const out: string[] = [];
  for (const raw of services.split(",").map((s) => s.trim()).filter(Boolean)) {
    const area = BROW_SERVICES.has(raw.toLowerCase()) ? "Eyebrows" : raw.toLowerCase() === "lip blush" ? "Lips" : raw;
    if (!out.includes(area)) out.push(area);
  }
  // Eyebrows first, Lips second, the rest in selection order.
  return out.sort((a, b) => (a === "Eyebrows" ? -1 : b === "Eyebrows" ? 1 : a === "Lips" ? -1 : b === "Lips" ? 1 : 0));
}

async function updateAreaFieldOptions(locationId: string, token: string, areas: string[]): Promise<ClaimAction> {
  try {
    const r = await fetch(`${GHL}/locations/${locationId}/customFields`, {
      headers: { Authorization: `Bearer ${token}`, Version: VERSION, Accept: "application/json" },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`customFields HTTP ${r.status}: ${text.slice(0, 150)}`);
    const j = JSON.parse(text) as { customFields?: Array<Record<string, unknown>> };
    const field = (j.customFields ?? []).find((f) => /which\s*area/i.test(String(f.name ?? "")));
    if (!field) return { action: "Treated areas", ok: false, detail: `custom field "CC - Which Area(s) Would You Like Treated?" not found in the sub-account` };

    // GET returns the choices as `picklistOptions`, but the update only
    // accepts `options` (422 "property picklistOptions should not exist",
    // Sally Nails And Spa 10/16/2026). Object-shaped options keep their shape.
    const body: Record<string, unknown> = { name: field.name };
    const first = Array.isArray(field.options) ? (field.options as unknown[])[0] : undefined;
    body.options = typeof first === "object" && first !== null
      ? areas.map((a) => ({ ...(first as object), name: a, label: a, value: a }))
      : areas;

    const ur = await fetch(`${GHL}/locations/${locationId}/customFields/${field.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Version: VERSION, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!ur.ok) throw new Error(`update HTTP ${ur.status}: ${(await ur.text()).slice(0, 200)}`);
    // Read it back: a 200 that silently ignored the options is not a success.
    const vr = await fetch(`${GHL}/locations/${locationId}/customFields/${field.id}`, {
      headers: { Authorization: `Bearer ${token}`, Version: VERSION, Accept: "application/json" },
    });
    if (vr.ok) {
      const vj = (await vr.json()) as { customField?: Record<string, unknown> };
      const f = vj.customField ?? {};
      const got = ((f.picklistOptions ?? f.options ?? []) as unknown[])
        .map((o) => (typeof o === "object" && o !== null ? String((o as Record<string, unknown>).name ?? (o as Record<string, unknown>).label ?? "") : String(o)));
      const miss = areas.filter((a) => !got.includes(a));
      if (miss.length) return { action: "Treated areas", ok: false, detail: `GHL accepted the update but the field still shows: ${got.join(", ") || "(none)"}` };
    }
    return { action: `Treated areas → ${areas.join(", ")} (field "${field.name}")`, ok: true };
  } catch (e) {
    return { action: "Treated areas", ok: false, detail: e instanceof Error ? e.message : "failed" };
  }
}

// ── The claim ───────────────────────────────────────────────────────────────
export type ClaimAction = { action: string; ok: boolean; detail?: string; cvId?: string; cvName?: string; prevValue?: string; userId?: string };
export type ClaimResult = {
  location_id: string;
  original_name: string;
  business_name: string;
  actions: ClaimAction[];
};

export async function claimPoolAccount(
  poolLocationId: string,
  form: Record<string, string>,
  /* skipUser: the New Client Setup run creates the employee user later,
     only after the owner approves that step (GHL emails the client).
     skipValues: the setup run fills the values as its own step. */
  opts: { skipUser?: boolean; skipValues?: boolean } = {},
): Promise<ClaimResult> {
  assertNotProtected(poolLocationId);
  const businessName = String(form.business_name ?? "").trim();
  if (!businessName) throw new Error("business_name is required");

  // Guard 2: the target must CURRENTLY be an unclaimed pool account.
  const currentName = await getLocationName(poolLocationId);
  if (!POOL_NAME_RE.test(currentName)) {
    throw new Error(`Location ${poolLocationId} is "${currentName}" — not an unclaimed pool account, refusing to touch it`);
  }

  // Guard 3: the account must have its snapshot. The claim fills EXISTING
  // custom values and never creates them, so a wiped account with none
  // would be renamed and then fail every single value (Clean New Account
  // 78 → Sally Nails And Spa, 10/15/2026). Refuse BEFORE the rename, with
  // one clear message. A token failure is reported by the fill step below,
  // as before — this guard only speaks when it can actually see the values.
  {
    const probe = await getAppLocationToken(poolLocationId);
    if (probe.token) {
      const have = await listCustomValues(poolLocationId, probe.token);
      if (have.length === 0) {
        throw new Error(`${currentName} has no snapshot loaded (0 custom values) — load it first (Onboarding → clean-account pool → "Load snapshot"), then try again`);
      }
    }
  }

  const actions: ClaimAction[] = [];

  // 1. Rename the sub-account (+ contact details when provided).
  const updates: Record<string, string> = { name: businessName };
  if (String(form.email ?? "").trim()) updates.email = form.email.trim();
  if (String(form.phone ?? "").trim()) updates.phone = form.phone.trim();
  // Business Profile address + time zone from the studio address: a recycled
  // account keeps the OLD client's (Sally got Mesquite, TX), and every SMS and
  // booking time renders in that zone.
  const profile = await profileFromAddress(String(form.address ?? ""), String(form.phone ?? ""));
  Object.assign(updates, profile.fields);
  await renameLocation(poolLocationId, updates);
  actions.push({ action: `Renamed "${currentName}" → "${businessName}"`, ok: true });
  actions.push({ action: `Business profile → ${profile.summary}`, ok: profile.ok, detail: profile.ok ? undefined : profile.summary });

  // 2–4. Custom values, treated areas, calendar ID — unless the caller fills
  //      them later (the setup run does it as its own steps 3 and 24).
  if (!opts.skipValues) {
    actions.push(...(await fillAccountValues(poolLocationId, form)));
    actions.push(...(await fillCalendarId(poolLocationId)));
  }

  // 5. Employee user (the client's login) when the form has an email.
  if (!opts.skipUser && String(form.email ?? "").trim() && String(form.owner_name ?? "").trim()) {
    actions.push(await createEmployeeUser(poolLocationId, form.owner_name, form.email));
  }

  return { location_id: poolLocationId, original_name: currentName, business_name: businessName, actions };
}

/* Fill the "CC -" custom values (existing ones only, never created) and the
   treated-areas options from the client's record: the Onboarding card's form,
   pre-filled from the Clients tab. Safe to run again. */
export async function fillAccountValues(poolLocationId: string, form: Record<string, string>): Promise<ClaimAction[]> {
  assertNotProtected(poolLocationId);
  const businessName = String(form.business_name ?? "").trim();
  const actions: ClaimAction[] = [];
  const tok = await getAppLocationToken(poolLocationId);
  if (!tok.token) {
    actions.push({ action: "Custom values", ok: false, detail: `no app token: ${tok.error}` });
  } else {
    let cvs: CustomValue[] = [];
    try {
      cvs = await listCustomValues(poolLocationId, tok.token);
    } catch (e) {
      actions.push({ action: "Custom values", ok: false, detail: e instanceof Error ? e.message : "list failed" });
    }
    // Computed values from the funnel URL convention (not on the form).
    const paths = funnelPaths(businessName);
    const computed: Record<string, string> = { deposit_funnel_url: `${FUNNEL_DOMAIN}/${paths.deposit}` };
    const FULL_MAP = [
      ...CV_MAP,
      { formKey: "deposit_funnel_url", match: (n: string) => n.includes("depositfunnelurl"), label: "Deposit funnel URL" },
    ];
    for (const m of FULL_MAP) {
      const value = (computed[m.formKey] ?? String(form[m.formKey] ?? "")).trim();
      if (!value) continue;
      const cv = cvs.find((c) => m.match(norm(c.name)));
      if (!cv) {
        actions.push({ action: `${m.label}`, ok: false, detail: "custom value missing — create it manually in GHL, then re-run" });
        continue;
      }
      try {
        await setCustomValue(poolLocationId, tok.token, cv, value);
        actions.push({
          action: `${m.label} → "${value}" (custom value "${cv.name}")`, ok: true,
          cvId: cv.id, cvName: cv.name, prevValue: cv.value ?? "",
        });
      } catch (e) {
        actions.push({ action: m.label, ok: false, detail: e instanceof Error ? e.message : "failed" });
      }
    }
  }

  // Treated-areas survey options, derived from the chosen services.
  if (tok.token && String(form.services ?? "").trim()) {
    const areas = areasFromServices(form.services);
    if (areas.length) actions.push(await updateAreaFieldOptions(poolLocationId, tok.token, areas));
  }

  return actions;
}

/* Save the Transformation calendar's ID into its existing custom value. */
export async function fillCalendarId(poolLocationId: string): Promise<ClaimAction[]> {
  assertNotProtected(poolLocationId);
  const actions: ClaimAction[] = [];
  const tok = await getAppLocationToken(poolLocationId);
  if (!tok.token) return [{ action: "Calendar ID", ok: false, detail: `no app token: ${tok.error}` }];
  {
    try {
      const cr = await fetch(`${GHL}/calendars/?locationId=${poolLocationId}`, {
        headers: { Authorization: `Bearer ${tok.token}`, Version: VERSION, Accept: "application/json" },
      });
      if (cr.ok) {
        const cj = (await cr.json()) as { calendars?: Array<{ id?: string; name?: string }> };
        const cal = (cj.calendars ?? []).find((c) => /transformation/i.test(String(c.name ?? ""))) ?? (cj.calendars ?? [])[0];
        const cvs2 = await listCustomValues(poolLocationId, tok.token);
        const cv = cvs2.find((c) => norm(c.name).includes("transformationcalendarid"));
        if (cal?.id && cv) {
          await setCustomValue(poolLocationId, tok.token, cv, String(cal.id));
          actions.push({ action: `Calendar ID → "${cal.id}" (calendar "${cal.name}", custom value "${cv.name}")`, ok: true, cvId: cv.id, cvName: cv.name, prevValue: cv.value ?? "" });
        } else if (!cal?.id) {
          actions.push({ action: "Calendar ID", ok: false, detail: "no calendar found in the sub-account" });
        } else {
          actions.push({ action: "Calendar ID", ok: false, detail: "custom value missing — create it manually in GHL, then re-run" });
        }
      }
    } catch (e) {
      actions.push({ action: "Calendar ID", ok: false, detail: e instanceof Error ? e.message : "failed" });
    }
  }

  return actions;
}

/* Studio address → GHL Business Profile fields + IANA time zone. The US
   Census geocoder (free, no key) splits street / city / state / zip; if it
   finds nothing, the zip + 2-letter state at the end are parsed and the rest
   is kept as the street. The time zone comes from the state, else from the
   business phone's area code. */
export async function profileFromAddress(address: string, phone = ""): Promise<{ ok: boolean; fields: Record<string, string>; summary: string }> {
  const raw = address.replace(/\s+/g, " ").trim();
  const fields: Record<string, string> = {};
  const title = (t: string) => t.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  if (raw) {
    try {
      const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(raw)}`;
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      const j = (await r.json()) as { result?: { addressMatches?: Array<{ addressComponents?: Record<string, string> }> } };
      const c = j.result?.addressMatches?.[0]?.addressComponents;
      if (c?.state && c.zip) {
        const num = (raw.match(/^\s*(\d+[A-Za-z-]*)/) ?? [])[1] ?? "";
        const street = [num, c.preDirection, c.preType && title(c.preType), title(c.streetName ?? ""), c.suffixType && title(c.suffixType), c.suffixDirection].filter(Boolean).join(" ");
        Object.assign(fields, { address: street || raw, city: title(c.city ?? ""), state: c.state.toUpperCase(), postalCode: c.zip, country: "US" });
      }
    } catch { /* fall back to parsing */ }
    if (!fields.state) {
      const m = raw.match(/^(.*?)[\s,]+([A-Za-z]{2})[\s,]+(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:US|USA|United States))?$/i);
      if (m && STATE_TZ[m[2].toUpperCase()]) Object.assign(fields, { address: m[1].replace(/,\s*$/, ""), state: m[2].toUpperCase(), postalCode: m[3], country: "US" });
    }
  }
  const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const state = fields.state || AREA_STATE[digits.slice(0, 3)] || "";
  const tz = STATE_TZ[state]?.[0];
  if (tz) fields.timezone = tz;
  if (!fields.address && !tz) return { ok: false, fields, summary: "could not read the studio address or area code — set address and time zone by hand (Settings → Business Profile)" };
  const where = [fields.address, fields.city, [fields.state, fields.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return { ok: !!tz && !!fields.address, fields, summary: `${where || "(address not parsed)"} · time zone ${tz ?? "not set"}` };
}

/* Re-apply the Business Profile address + time zone on an account already
   taken (Retry of step 2, or an account claimed before this existed). */
export async function setLocationProfile(locationId: string, form: Record<string, string>): Promise<ClaimAction> {
  const profile = await profileFromAddress(String(form.address ?? ""), String(form.phone ?? ""));
  if (!Object.keys(profile.fields).length) return { action: "Business profile", ok: false, detail: profile.summary };
  await renameLocation(locationId, profile.fields);
  return { action: `Business profile → ${profile.summary}`, ok: profile.ok, detail: profile.ok ? undefined : profile.summary };
}

// Un-claim (testing / mistakes): rename the account back to its recorded pool
// name and restore any custom values the claim overwrote (recorded prevValue).
// Only allowed when the claim's own record identifies the location.
export async function unclaimPoolAccount(claim: ClaimResult): Promise<ClaimAction[]> {
  assertNotProtected(claim.location_id);
  if (!POOL_NAME_RE.test(claim.original_name)) {
    throw new Error(`Recorded original name "${claim.original_name}" is not a pool name — refusing`);
  }
  const currentName = await getLocationName(claim.location_id);
  if (norm(currentName) !== norm(claim.business_name)) {
    throw new Error(`Location is now "${currentName}", not "${claim.business_name}" — refusing to rename`);
  }
  const restored: ClaimAction[] = [];
  // Remove the employee user the claim created (test resets).
  for (const a of (claim.actions ?? []).filter((x) => x.ok && x.userId)) {
    try {
      const r = await fetch(`${GHL}/users/${a.userId}`, { method: "DELETE", headers: await agencyHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      restored.push({ action: "Removed employee user", ok: true });
    } catch (e) {
      restored.push({ action: "Remove employee user", ok: false, detail: e instanceof Error ? e.message : "failed" });
    }
  }
  const cvWrites = (claim.actions ?? []).filter((a) => a.ok && a.cvId);
  if (cvWrites.length) {
    const tok = await getAppLocationToken(claim.location_id);
    for (const a of cvWrites) {
      try {
        if (!tok.token) throw new Error(`no app token: ${tok.error}`);
        await setCustomValue(claim.location_id, tok.token, { id: a.cvId!, name: a.cvName! }, a.prevValue ?? "");
        restored.push({ action: `Restored "${a.cvName}"`, ok: true });
      } catch (e) {
        restored.push({ action: `Restore "${a.cvName}"`, ok: false, detail: e instanceof Error ? e.message : "failed" });
      }
    }
  }
  await renameLocation(claim.location_id, { name: claim.original_name });
  return restored;
}
