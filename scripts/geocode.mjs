// One-time / re-runnable geocoder.
// Reads distinct client addresses from clients_master, geocodes any that aren't
// already in geocode_cache via OpenStreetMap Nominatim (free, ~1 req/sec),
// and upserts the result. Safe to re-run: it skips addresses already cached.
//
// Usage: node scripts/geocode.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- load .env.local ---------------------------------------------------------
const env = {};
for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const ADDRESS_KEY = "Location (Full adress)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadAllClients() {
  const all = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("clients_master")
      .select("data")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Only addresses already resolved (status='ok') are considered done.
// Previously failed ('notfound') addresses are retried with the smarter logic.
async function loadCachedAddresses() {
  const set = new Set();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("geocode_cache")
      .select("address")
      .eq("status", "ok")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    data.forEach((r) => set.add(r.address));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return set;
}

async function nominatim(query) {
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
function cleanAddress(address) {
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
function cityStateZip(address) {
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

async function geocode(address) {
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

async function main() {
  const clients = await loadAllClients();
  const cached = await loadCachedAddresses();

  // Collect distinct, non-empty, not-yet-cached addresses
  const todo = new Set();
  for (const row of clients) {
    const addr = String(row.data?.[ADDRESS_KEY] ?? "").trim();
    if (addr && !cached.has(addr)) todo.add(addr);
  }

  const list = [...todo];
  console.log(
    `Clients: ${clients.length} | already cached: ${cached.size} | to geocode: ${list.length}`
  );

  let ok = 0,
    notfound = 0,
    failed = 0;

  for (let i = 0; i < list.length; i++) {
    const address = list[i];
    try {
      const hit = await geocode(address);
      if (hit && !isNaN(hit.lat) && !isNaN(hit.lng)) {
        await supabase.from("geocode_cache").upsert(
          { address, lat: hit.lat, lng: hit.lng, status: "ok", updated_at: new Date().toISOString() },
          { onConflict: "address" }
        );
        ok++;
      } else {
        await supabase.from("geocode_cache").upsert(
          { address, lat: null, lng: null, status: "notfound", updated_at: new Date().toISOString() },
          { onConflict: "address" }
        );
        notfound++;
      }
    } catch (e) {
      failed++;
      console.error(`[${i}] FAIL "${address.slice(0, 50)}": ${e.message}`);
    }
    if ((i + 1) % 25 === 0 || i === list.length - 1) {
      console.log(`  progress ${i + 1}/${list.length} — ok:${ok} notfound:${notfound} failed:${failed}`);
    }
    await sleep(1100); // respect Nominatim 1 req/sec policy
  }

  console.log(`DONE — ok:${ok} notfound:${notfound} failed:${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
