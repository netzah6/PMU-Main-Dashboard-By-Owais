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
  ["elfsightId", "OB - Elfsight ID"],
  ["resultImgs", "OB - Result Images"],
  ["faqsRaw", "OB - FAQs"],
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
