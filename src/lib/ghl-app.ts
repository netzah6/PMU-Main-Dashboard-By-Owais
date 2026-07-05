import { createServiceClient } from "@/lib/supabase/server";

// GHL Marketplace app (OAuth) — the scalable replacement for per-client
// private integration keys. One agency install → the dashboard can mint a
// location-scoped token for ANY sub-account on demand.

const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const LOCATION_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/locationToken";

// Scopes requested at install time — must be a subset of the app's configured
// scopes in the GHL developer portal.
export const APP_SCOPES = [
  "contacts.readonly",
  "conversations.readonly",
  "conversations/message.readonly",
  "opportunities.readonly",
  "calendars.readonly",
  "calendars.write",
  "locations.readonly",
  "locations/customValues.readonly",
  "locations/customValues.write",
  "users.write",
  "snapshots.readonly",
  "oauth.readonly",
  "oauth.write",
].join(" ");

export function appConfigured(): boolean {
  return !!process.env.GHL_APP_CLIENT_ID && !!process.env.GHL_APP_CLIENT_SECRET;
}

export function authorizeUrl(redirectUri: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    client_id: process.env.GHL_APP_CLIENT_ID ?? "",
    scope: APP_SCOPES,
  });
  return `https://marketplace.gohighlevel.com/oauth/chooselocation?${p.toString()}`;
}

type TokenRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  company_id: string | null;
  user_type: string | null;
};

async function tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: process.env.GHL_APP_CLIENT_ID ?? "",
      client_secret: process.env.GHL_APP_CLIENT_SECRET ?? "",
      ...body,
    }).toString(),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`oauth/token HTTP ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function storeTokens(j: Record<string, unknown>): Promise<void> {
  const svc = createServiceClient();
  const expiresIn = Number(j.expires_in ?? 86400);
  const { error } = await svc.from("ghl_oauth").upsert({
    id: 1,
    access_token: String(j.access_token ?? ""),
    refresh_token: String(j.refresh_token ?? ""),
    expires_at: new Date(Date.now() + (expiresIn - 300) * 1000).toISOString(),
    company_id: (j.companyId as string) ?? null,
    user_type: (j.userType as string) ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`storing tokens failed: ${error.message}`);
}

// OAuth callback: exchange the authorization code for agency-level tokens.
export async function exchangeCode(code: string, redirectUri: string): Promise<void> {
  const j = await tokenRequest({
    grant_type: "authorization_code",
    code,
    user_type: "Company",
    redirect_uri: redirectUri,
  });
  await storeTokens(j);
}

// Current agency access token, refreshed automatically when near expiry.
export async function getAppAgencyToken(): Promise<{ token: string; companyId: string } | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("ghl_oauth").select("*").eq("id", 1).single();
  const row = data as TokenRow | null;
  if (!row?.access_token) return null;
  if (new Date(row.expires_at).getTime() > Date.now()) {
    return { token: row.access_token, companyId: row.company_id ?? "" };
  }
  const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: row.refresh_token, user_type: "Company" });
  await storeTokens(j);
  return { token: String(j.access_token ?? ""), companyId: String(j.companyId ?? row.company_id ?? "") };
}

// Mint a location-scoped token for any sub-account (cached ~50 min in-process).
const locCache = new Map<string, { ts: number; token: string }>();
export async function getAppLocationToken(locationId: string): Promise<{ token?: string; error?: string }> {
  const hit = locCache.get(locationId);
  if (hit && Date.now() - hit.ts < 50 * 60 * 1000) return { token: hit.token };
  try {
    const agency = await getAppAgencyToken();
    if (!agency) return { error: "marketplace app not connected yet" };
    const r = await fetch(LOCATION_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agency.token}`,
        Version: "2021-07-28",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ companyId: agency.companyId, locationId }).toString(),
    });
    const text = await r.text();
    if (!r.ok) return { error: `locationToken HTTP ${r.status}: ${text.slice(0, 150)}` };
    const j = JSON.parse(text) as { access_token?: string };
    if (!j.access_token) return { error: "no access_token in locationToken response" };
    locCache.set(locationId, { ts: Date.now(), token: j.access_token });
    return { token: j.access_token };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "locationToken failed" };
  }
}
