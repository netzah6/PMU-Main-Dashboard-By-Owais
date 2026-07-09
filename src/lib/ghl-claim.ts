import { getAppLocationToken, getAppAgencyToken } from "@/lib/ghl-app";

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
function agencyHeaders(): Record<string, string> {
  const token = process.env.GHL_AGENCY_TOKEN;
  if (!token) throw new Error("GHL_AGENCY_TOKEN not set");
  return { Authorization: `Bearer ${token}`, Version: VERSION, Accept: "application/json" };
}

export type PoolAccount = { id: string; name: string };

export async function discoverPool(): Promise<PoolAccount[]> {
  const r = await fetch(`${GHL}/locations/search?limit=500`, { headers: agencyHeaders() });
  const text = await r.text();
  if (!r.ok) throw new Error(`locations/search HTTP ${r.status}: ${text.slice(0, 150)}`);
  const j = JSON.parse(text) as { locations?: Array<{ id?: string; _id?: string; name?: string }> };
  return (j.locations ?? [])
    .filter((l) => POOL_NAME_RE.test(String(l.name ?? "").trim()))
    .map((l) => ({ id: String(l.id ?? l._id ?? ""), name: String(l.name ?? "").trim() }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function getLocationName(locationId: string): Promise<string> {
  const r = await fetch(`${GHL}/locations/${locationId}`, { headers: agencyHeaders() });
  const text = await r.text();
  if (!r.ok) throw new Error(`locations/${locationId} HTTP ${r.status}: ${text.slice(0, 150)}`);
  const j = JSON.parse(text) as { location?: { name?: string } };
  return String(j.location?.name ?? "").trim();
}

async function renameLocation(locationId: string, updates: Record<string, string>): Promise<void> {
  assertNotProtected(locationId);
  const r = await fetch(`${GHL}/locations/${locationId}`, {
    method: "PUT",
    headers: { ...agencyHeaders(), "Content-Type": "application/json" },
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
  { formKey: "pixel_id", match: (n) => n.includes("pixelid") || n.includes("ccpixel"), label: "FB Pixel ID" },
  { formKey: "business_name", match: (n) => n === "businessname", label: "Business name" },
  { formKey: "owner_name", match: (n) => n.includes("ownersname") || n.includes("ownername"), label: "Owner name" },
  { formKey: "phone", match: (n) => n.includes("businessphone"), label: "Business phone" },
  { formKey: "offer", match: (n) => !isUrlCv(n) && (n === "ccoffer" || n.endsWith("offer")), label: "Offer" },
  { formKey: "deposit_amount", match: (n) => !isUrlCv(n) && n.includes("depositamount"), label: "Deposit amount" },
  { formKey: "original_price", match: (n) => !isUrlCv(n) && n.includes("originalprice"), label: "Original price" },
  { formKey: "discounted_price", match: (n) => !isUrlCv(n) && n.includes("discountedprice"), label: "Discounted price" },
  { formKey: "product_id", match: (n) => !isUrlCv(n) && n.includes("product") && n.includes("id"), label: "Fanbasis product ID" },
  { formKey: "area", match: (n) => !isUrlCv(n) && (n === "area" || n.endsWith("area")), label: "AREA" },
  { formKey: "address", match: (n) => !isUrlCv(n) && n.includes("address"), label: "Business address" },
  { formKey: "services", match: (n) => n.includes("permanentmakeupservices") || n.includes("pmuservices"), label: "PMU services" },
  { formKey: "ig_link", match: (n) => n.includes("igbusinesspagelink") || n.includes("igpagelink"), label: "IG page link" },
  { formKey: "fb_link", match: (n) => n.includes("fbbusinesspagelink") || n.includes("fbpagelink"), label: "FB page link" },
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
      headers: agencyHeaders(),
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
      headers: { ...agencyHeaders(), "Content-Type": "application/json" },
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
): Promise<ClaimResult> {
  assertNotProtected(poolLocationId);
  const businessName = String(form.business_name ?? "").trim();
  if (!businessName) throw new Error("business_name is required");

  // Guard 2: the target must CURRENTLY be an unclaimed pool account.
  const currentName = await getLocationName(poolLocationId);
  if (!POOL_NAME_RE.test(currentName)) {
    throw new Error(`Location ${poolLocationId} is "${currentName}" — not an unclaimed pool account, refusing to touch it`);
  }

  const actions: ClaimAction[] = [];

  // 1. Rename the sub-account (+ contact details when provided).
  const updates: Record<string, string> = { name: businessName };
  if (String(form.email ?? "").trim()) updates.email = form.email.trim();
  if (String(form.phone ?? "").trim()) updates.phone = form.phone.trim();
  await renameLocation(poolLocationId, updates);
  actions.push({ action: `Renamed "${currentName}" → "${businessName}"`, ok: true });

  // 2. Fill custom values from the form (best-effort per value).
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

  // 3. Employee user (the client's login) when the form has an email.
  if (String(form.email ?? "").trim() && String(form.owner_name ?? "").trim()) {
    actions.push(await createEmployeeUser(poolLocationId, form.owner_name, form.email));
  }

  return { location_id: poolLocationId, original_name: currentName, business_name: businessName, actions };
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
      const r = await fetch(`${GHL}/users/${a.userId}`, { method: "DELETE", headers: agencyHeaders() });
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
