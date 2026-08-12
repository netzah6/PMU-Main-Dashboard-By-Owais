import { getAppLocationToken } from "@/lib/ghl-app";
import type { SupabaseClient } from "@supabase/supabase-js";

// One-Box funnel content, synced from the client's GHL custom values.
// Base values are the ones every sub-account already has; "OB - *" values
// are optional per-client overrides the team can create in GHL to change
// funnel copy, pictures or the results widget without touching code.
// The funnel page auto-resyncs when its copy is older than SYNC_TTL_MS,
// so a GHL edit shows up on the live funnel within minutes.

export const SYNC_TTL_MS = 5 * 60 * 1000;

const pickers: [key: string, ...names: string[]][] = [
  ["biz", "Business Name"],
  ["phone", "CC - Business Phone Number"],
  ["address", "CC - Full Business Address"],
  ["offer", "CC - Offer"],
  ["deposit", "CC - Deposit Amount 🔵", "CC - Deposit Amount"],
  ["logo", "CC - Funnel Logo"],
  ["igLink", "CC - IG Business Page Link"],
  ["calendarId", "CC - Permanent Makeup Transformation Calendar ID🔵"],
  // Optional team-editable overrides (create the custom value in GHL to use):
  ["headline", "OB - Headline"],
  ["sub", "OB - Subheadline"],
  ["congrats", "OB - Congrats Line"],
  ["bookingHead", "OB - Booking Headline"],
  ["depositHead", "OB - Deposit Headline"],
  // Instagram widget: the team's own CV name, then OB fallbacks.
  ["igWidget", "CC - IG Widget LINK", "OB - IG Widget", "OB - Elfsight ID"],
  // Google reviews widget.
  ["googleWidget", "CC - Google Widget LINK", "OB - Google Widget"],
  ["resultImgs", "OB - Result Images"],
  // Fanbasis checkout: paste the whole deposit-page block into this CV.
  ["fanbasisCode", "CC - Fanbasis Checkout Code", "CC - Fanbasis Code", "OB - Fanbasis Code"],
  ["faqsRaw", "OB - FAQs"],
  ["metaPixelId", "OB - Meta Pixel ID"],
];

export function buildConfig(byName: Record<string, string>): Record<string, string> {
  const pick = (...names: string[]) => {
    for (const n of names) if (byName[n]?.trim()) return byName[n].trim();
    return "";
  };
  const config: Record<string, string> = {};
  for (const [key, ...names] of pickers) config[key] = pick(...names);
  if (!config.deposit) config.deposit = "$50";
  return config;
}

// Elfsight widget id, from whatever the team pastes: the dashed id, the
// dash-less id, the https://<id>.elf.site share link, or the whole embed
// snippet. UUID dash positions are fixed, so all forms normalize.
export function normalizeElfsight(raw: string): string {
  const s = String(raw ?? "");
  const dashed = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (dashed) return dashed[0].toLowerCase();
  const bare = s.match(/[0-9a-f]{32}/i);
  if (bare) {
    const b = bare[0].toLowerCase();
    return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20)}`;
  }
  return "";
}

// Meta pixel id, harvested from the client's existing live GHL funnel page
// (the pixel sits in the funnel's tracking code, so it's in the public
// HTML). Matches fbq('init','<id>') and the lead-pixel.js pixel config.
export async function harvestPixelId(funnelUrl: string): Promise<string> {
  try {
    const r = await fetch(funnelUrl, { headers: { "User-Agent": "Mozilla/5.0 (pixel-harvest)" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return "";
    const html = await r.text();
    const m =
      html.match(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{8,20})['"]/) ??
      html.match(/pixel[_-]?id['"]?\s*[:=]\s*['"](\d{8,20})['"]/i) ??
      html.match(/facebook\.com\/tr\?id=(\d{8,20})/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

// "OB - FAQs" custom value: one FAQ per line, "Question | Answer".
export function parseFaqs(raw: string): { q: string; a: string }[] {
  return raw
    .split("\n")
    .map((l) => l.split("|"))
    .filter((p) => p.length >= 2 && p[0].trim() && p.slice(1).join("|").trim())
    .map((p) => ({ q: p[0].trim(), a: p.slice(1).join("|").trim() }));
}

// Re-pull the location's custom values and persist the fresh config.
// Returns the fresh config, or null on any failure (caller keeps stale).
export async function refreshOneboxConfig(
  svc: SupabaseClient,
  slug: string,
  locationId: string
): Promise<Record<string, string> | null> {
  try {
    const tok = await getAppLocationToken(locationId);
    if (!tok.token) return null;
    const r = await fetch(
      `https://services.leadconnectorhq.com/locations/${locationId}/customValues`,
      {
        headers: {
          Authorization: `Bearer ${tok.token}`,
          Version: "2021-07-28",
          Accept: "application/json",
        },
      }
    );
    if (!r.ok) return null;
    const { customValues } = (await r.json()) as {
      customValues?: { name?: string; value?: string }[];
    };
    const byName: Record<string, string> = {};
    for (const v of customValues ?? []) byName[String(v.name ?? "")] = String(v.value ?? "");
    const config = buildConfig(byName);
    await svc
      .from("onebox_clients")
      .update({ config, cv_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("slug", slug);
    return config;
  } catch (e) {
    console.error("[onebox] cv resync failed:", e);
    return null;
  }
}
