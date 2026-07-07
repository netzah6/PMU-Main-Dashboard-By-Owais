import { getAppLocationToken } from "@/lib/ghl-app";

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

async function setCustomValue(locationId: string, token: string, cv: CustomValue, value: string): Promise<void> {
  assertNotProtected(locationId);
  const r = await fetch(`${GHL}/locations/${locationId}/customValues/${cv.id}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Version: VERSION, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ name: cv.name, value }),
  });
  if (!r.ok) throw new Error(`customValue "${cv.name}" HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
}

// Map onboarding-form fields → custom-value name matchers (normalized:
// lowercase, alphanumeric only). First matching custom value wins.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
// URLs/links are never a value target for form amounts — the first test wrote
// the deposit amount into "CC - Deposit Funnel URL" without this exclusion.
const isUrlCv = (n: string) => n.includes("url") || n.includes("link");
const CV_MAP: Array<{ formKey: string; match: (n: string) => boolean; label: string }> = [
  { formKey: "offer", match: (n) => !isUrlCv(n) && (n === "ccoffer" || n.endsWith("offer")), label: "Offer" },
  { formKey: "deposit_amount", match: (n) => !isUrlCv(n) && n.includes("deposit"), label: "Deposit amount" },
  { formKey: "original_price", match: (n) => !isUrlCv(n) && n.includes("originalprice"), label: "Original price" },
  { formKey: "discounted_price", match: (n) => !isUrlCv(n) && n.includes("discountedprice"), label: "Discounted price" },
  { formKey: "product_id", match: (n) => !isUrlCv(n) && n.includes("product") && n.includes("id"), label: "Fanbasis product ID" },
  { formKey: "area", match: (n) => !isUrlCv(n) && (n === "area" || n.endsWith("area")), label: "AREA" },
  { formKey: "address", match: (n) => !isUrlCv(n) && (n.includes("mapaddress") || n === "address" || n.includes("fulladdress")), label: "Map address" },
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

// ── The claim ───────────────────────────────────────────────────────────────
export type ClaimAction = { action: string; ok: boolean; detail?: string; cvId?: string; cvName?: string; prevValue?: string };
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
    for (const m of CV_MAP) {
      const value = String(form[m.formKey] ?? "").trim();
      if (!value) continue;
      const cv = cvs.find((c) => m.match(norm(c.name)));
      if (!cv) {
        actions.push({ action: `${m.label}`, ok: false, detail: "no matching custom value in the sub-account" });
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
