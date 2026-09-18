import type { SupabaseClient } from "@supabase/supabase-js";

/* Geocoder for the Client Map — a port of scripts/geocode.mjs so it can run
   as a cron. Nominatim (OpenStreetMap), ≤1 request/second, three tiers:
   the address as written → cleaned of suite/unit noise → city/state/zip.
   Results land in geocode_cache keyed by the sheet's exact (trimmed)
   address string, which is how the Map tab looks them up. An address that
   changes in Clients Master is a NEW key and gets geocoded on the next run
   — that's what left Brows by Lissette (and 69 others) off the map until
   2026-09-18. */

export const ADDRESS_KEY = "Location (Full adress)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function nominatim(query: string): Promise<{ lat: number; lng: number } | null> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=0&q=" +
    encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "PMU-Dashboard-Geocoder/1.0 (admin@pmu-bookings.com)",
      "Accept-Language": "en",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (Array.isArray(json) && json.length > 0) {
    const lat = parseFloat(json[0].lat);
    const lng = parseFloat(json[0].lon);
    if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
  }
  return null;
}


// Strip suite/unit/studio/floor noise and leading prose so a messy address
// still resolves to its street (and, failing that, its city).
function cleanAddress(address: string): string {
  let s = address.replace(/\s+/g, " ").trim();
  // Drop leading prose before the first street number ("Our address is 19111 ...")
  const firstNum = s.search(/\d/);
  if (firstNum > 0 && firstNum < 40) s = s.slice(firstNum);
  // Remove suite/unit/ste/apt/floor/studio/# segments
  s = s.replace(
    /\b(suite|ste\.?|unit|apt\.?|#|studio|floor|fl\.?|building|bldg\.?|inside|salon|boutique)\b[^,]*/gi,
    " "
  );
  return s.replace(/\s*,\s*,/g, ",").replace(/\s+/g, " ").replace(/\s*,\s*$/, "").trim();
}

const STATE_NAMES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};

// Pull "City, ST ZIP" (or City, State) out of a free-form US address.
function cityStateZip(address: string): string {
  const zip = address.match(/\b(\d{5})(?:-\d{4})?\b/);
  // Prefer a spelled-out state name, else a two-letter code
  let state = "";
  const lower = address.toLowerCase();
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) { state = code; break; }
  }
  if (!state) {
    const st = address.match(
      /\b(A[LKZR]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/
    );
    if (st) state = st[1];
  }
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const city = parts.length >= 2 ? parts[parts.length - 2].replace(/\d/g, "").trim() : "";
  return [city, state, zip ? zip[1] : ""].filter(Boolean).join(" ").trim();
}


export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  // Tier 1: full address as written
  let hit = await nominatim(address);
  if (hit) return hit;

  // Tier 2: cleaned (suite/prose removed)
  const cleaned = cleanAddress(address);
  if (cleaned && cleaned !== address) {
    await sleep(1100);
    hit = await nominatim(cleaned);
    if (hit) return hit;
  }

  // Tier 3: city / state / zip → at least the right town
  const csz = cityStateZip(address);
  if (csz && csz.length > 3) {
    await sleep(1100);
    hit = await nominatim(csz);
    if (hit) return hit;
  }

  return null;
}


export type GeocodeRunResult = { candidates: number; done: number; ok: number; notfound: number; failed: number; left: number };

/* Geocode up to `limit` client addresses that have no cache entry yet.
   A "notfound" row is left alone: fixing the address in the sheet makes
   it a new string, which is picked up on the next run. */
export async function geocodeMissing(svc: SupabaseClient, limit = 40): Promise<GeocodeRunResult> {
  const addrs = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await svc.from("clients_master").select("data").range(from, from + 999);
    for (const r of (data ?? []) as Array<{ data: Record<string, unknown> }>) {
      const a = String(r.data?.[ADDRESS_KEY] ?? "").trim();
      if (a) addrs.add(a);
    }
    if (!data || data.length < 1000) break;
  }
  const cached = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await svc.from("geocode_cache").select("address").range(from, from + 999);
    for (const r of (data ?? []) as Array<{ address: string }>) cached.add(r.address);
    if (!data || data.length < 1000) break;
  }
  const todo = [...addrs].filter((a) => !cached.has(a));
  const res: GeocodeRunResult = { candidates: todo.length, done: 0, ok: 0, notfound: 0, failed: 0, left: 0 };
  for (const address of todo.slice(0, limit)) {
    try {
      const hit = await geocodeAddress(address);
      await svc.from("geocode_cache").upsert(
        hit
          ? { address, lat: hit.lat, lng: hit.lng, status: "ok", updated_at: new Date().toISOString() }
          : { address, lat: null, lng: null, status: "notfound", updated_at: new Date().toISOString() },
        { onConflict: "address" }
      );
      if (hit) res.ok++; else res.notfound++;
    } catch {
      res.failed++;
    }
    res.done++;
    await sleep(1100);
  }
  res.left = Math.max(0, todo.length - res.done);
  return res;
}
