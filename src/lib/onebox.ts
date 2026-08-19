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
  ["resultImgs", "CC - Result Images", "OB - Result Images"],
  // Studio photos shown with the location section (comma-separated URLs).
  ["studioImgs", "CC - Studio Images", "OB - Studio Images"],
  // Fanbasis checkout — the simple way: just the product ID.
  ["fanbasisProductId", "CC - Fanbasis Product ID", "OB - Fanbasis Product ID"],
  ["thankYouPath", "CC - Thank You Page Path", "OB - Thank You Path"],
  // Or paste the whole deposit-page block (fallback for edge cases).
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
  /* The template's per-service photo slots — the exact custom values the
     original GHL funnels render (9 before/after + 3 studio). Aggregated
     into one list each, template order: eyebrows, lip blush, eyeliner. */
  const ba: string[] = [];
  for (const base of ["CC - Eyebrows Before & After", "CC - Lip blush Before & After", "CC - Eyeliner Before & After"]) {
    for (const n of [1, 2, 3]) {
      const v = byName[`${base} ${n}`]?.trim();
      if (v) ba.push(v);
    }
  }
  if (ba.length) config.resultCvImgs = ba.join(",");
  const studio: string[] = [];
  for (const n of [1, 2, 3]) {
    const v = byName[`CC - Picture of Studio ${n}`]?.trim();
    if (v) studio.push(v);
  }
  if (studio.length) config.studioCvImgs = studio.join(",");
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

/* Photos, harvested from the client's original booking page: its layout
   is fixed — "See Real Client Results" heading, then the before/after
   photos, then the map, then the studio photos — so images from the
   client's own media library classify by position. Returns full-res
   URLs in page order. */
export async function harvestFunnelPhotos(bookingUrl: string, locationId: string): Promise<{ ba: string[]; studio: string[] }> {
  const empty = { ba: [] as string[], studio: [] as string[] };
  try {
    const r = await fetch(bookingUrl, { headers: { "User-Agent": "Mozilla/5.0 (photo-harvest)" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return empty;
    const html = await r.text();
    const resultsAt = html.indexOf("See Real Client Results");
    const mapAt = html.indexOf("firebasestorage");
    if (resultsAt < 0 || mapAt < 0 || mapAt < resultsAt) return empty;
    const re = new RegExp(
      `https://(?:assets\\.cdn\\.filesafe\\.space|storage\\.googleapis\\.com/msgsndr)/${locationId}/media/[a-zA-Z0-9.-]+\\.(?:png|jpe?g|webp)`,
      "g"
    );
    const seen = new Set<string>();
    const ba: { url: string; at: number }[] = [];
    const studio: { url: string; at: number }[] = [];
    for (const m of html.matchAll(re)) {
      const url = m[0];
      const id = url.slice(url.lastIndexOf("/") + 1);
      if (seen.has(id)) continue;
      seen.add(id);
      const at = m.index ?? 0;
      if (at > resultsAt && at < mapAt) ba.push({ url, at });
      else if (at > mapAt) studio.push({ url, at });
    }
    ba.sort((a, b) => a.at - b.at);
    studio.sort((a, b) => a.at - b.at);
    return { ba: ba.slice(0, 9).map((x) => x.url), studio: studio.slice(0, 3).map((x) => x.url) };
  } catch {
    return empty;
  }
}

// The 9 before/after CV slots, in the order harvested photos fill them.
export const BA_CV_SLOTS = [
  "CC - Eyebrows Before & After 1", "CC - Eyebrows Before & After 2", "CC - Eyebrows Before & After 3",
  "CC - Lip blush Before & After 1", "CC - Lip blush Before & After 2", "CC - Lip blush Before & After 3",
  "CC - Eyeliner Before & After 1", "CC - Eyeliner Before & After 2", "CC - Eyeliner Before & After 3",
];

// "OB - FAQs" custom value: one FAQ per line, "Question | Answer".
export function parseFaqs(raw: string): { q: string; a: string }[] {
  return raw
    .split("\n")
    .map((l) => l.split("|"))
    .filter((p) => p.length >= 2 && p[0].trim() && p.slice(1).join("|").trim())
    .map((p) => ({ q: p[0].trim(), a: p.slice(1).join("|").trim() }));
}

// The custom values the one-box introduced. Older sub-accounts don't
// have them; Add-client creates any that are missing (empty, for the
// team to fill in GHL) so nobody has to add them by hand.
export const ONEBOX_NEW_CVS = [
  "CC - IG Widget LINK",
  "CC - Google Widget LINK",
  "CC - Fanbasis Product ID",
  "CC - Thank You Page Path",
  "CC - Eyebrows Before & After 1",
  "CC - Eyebrows Before & After 2",
  "CC - Eyebrows Before & After 3",
  "CC - Lip blush Before & After 1",
  "CC - Lip blush Before & After 2",
  "CC - Lip blush Before & After 3",
  "CC - Eyeliner Before & After 1",
  "CC - Eyeliner Before & After 2",
  "CC - Eyeliner Before & After 3",
  "CC - Picture of Studio 1",
  "CC - Picture of Studio 2",
  "CC - Picture of Studio 3",
];

export async function ensureOneboxCustomValues(locationId: string): Promise<{ created: string[]; error?: string }> {
  try {
    const tok = await getAppLocationToken(locationId);
    if (!tok.token) return { created: [], error: "no token" };
    const H = {
      Authorization: `Bearer ${tok.token}`,
      Version: "2021-07-28",
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const r = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}/customValues`, { headers: H });
    if (!r.ok) return { created: [], error: `list ${r.status}` };
    const { customValues } = (await r.json()) as { customValues?: { name?: string }[] };
    const have = new Set((customValues ?? []).map((v) => String(v.name ?? "")));
    const created: string[] = [];
    for (const name of ONEBOX_NEW_CVS) {
      if (have.has(name)) continue;
      const c = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}/customValues`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ name, value: "" }),
      });
      if (c.ok) created.push(name);
    }
    return { created };
  } catch {
    return { created: [], error: "network" };
  }
}

// The values the dashboard's editor may write, keyed by config field.
export const ONEBOX_EDITABLE_CVS: Record<string, string> = {
  biz: "Business Name",
  phone: "CC - Business Phone Number",
  address: "CC - Full Business Address",
  offer: "CC - Offer",
  deposit: "CC - Deposit Amount 🔵",
  calendarId: "CC - Permanent Makeup Transformation Calendar ID🔵",
  fanbasisProductId: "CC - Fanbasis Product ID",
  thankYouPath: "CC - Thank You Page Path",
  igWidget: "CC - IG Widget LINK",
  googleWidget: "CC - Google Widget LINK",
  // Before/after + studio photos are managed ONLY in the GHL sub-account
  // (the 12 template custom values) — deliberately not dashboard-editable.
};

// Write custom values straight to the sub-account — update when the
// value exists, create when it doesn't — so the team never has to hunt
// for them inside GHL.
export async function setOneboxCustomValues(
  locationId: string,
  entries: { name: string; value: string }[]
): Promise<{ written: string[]; error?: string }> {
  try {
    const tok = await getAppLocationToken(locationId);
    if (!tok.token) return { written: [], error: "no token" };
    const H = {
      Authorization: `Bearer ${tok.token}`,
      Version: "2021-07-28",
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const r = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}/customValues`, { headers: H });
    if (!r.ok) return { written: [], error: `list ${r.status}` };
    const { customValues } = (await r.json()) as { customValues?: { id?: string; name?: string }[] };
    const idByName = new Map((customValues ?? []).map((v) => [String(v.name ?? ""), String(v.id ?? "")]));
    const written: string[] = [];
    for (const { name, value } of entries) {
      const id = idByName.get(name);
      const url = id
        ? `https://services.leadconnectorhq.com/locations/${locationId}/customValues/${id}`
        : `https://services.leadconnectorhq.com/locations/${locationId}/customValues`;
      const res = await fetch(url, {
        method: id ? "PUT" : "POST",
        headers: H,
        body: JSON.stringify({ name, value }),
      });
      if (res.ok) written.push(name);
    }
    return { written };
  } catch {
    return { written: [], error: "network" };
  }
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


// Agency-shared Fanbasis credentials (publishable embed key + creator);
// only the product id and thank-you page differ per client.
/* The checkout-embed key ships in the public HTML of every funnel page —
   it is not a secret. Exported so fanbasis.ts can use it as the read-path
   fallback since the Fanbasis→Commas migration broke the env key. */
export const FANBASIS_PUBLIC_EMBED_KEY = "lKI2gJ56jiZtjQA08FKyzW8HmgLCvC5n";
const FANBASIS_CREATOR = "pmubookingsondemand";

// Build the full Fanbasis checkout block from just a product id — the
// simple path so a team member pastes only "CC - Fanbasis Product ID".
// redirectUrl (absolute) is optional; empty => in-box success message.
// Prefill reads window.OB_LEAD (set by the funnel engine) or URL params.
export function buildFanbasisBlock(productId: string, redirectUrl: string): string {
  const pid = String(productId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!pid) return "";
  const K = JSON.stringify(FANBASIS_PUBLIC_EMBED_KEY);
  const C = JSON.stringify(FANBASIS_CREATOR);
  const P = JSON.stringify(pid);
  const R = redirectUrl ? JSON.stringify(redirectUrl) : "null";
  return [
    '<style>#fanbasis-checkout-wrapper{width:100%}#fanbasis-checkout-wrapper iframe{width:100%!important;height:800px!important;border:none!important;overflow:hidden!important}@media(max-width:768px){#fanbasis-checkout-wrapper iframe{height:900px!important}}</style>',
    '<div id="fanbasis-checkout-wrapper"></div>',
    '<script src="https://cdn.embedded.fanbasis.io/embed/index.js"></scr' + 'ipt>',
    '<script>(function(){',
    'var API_KEY=' + K + ',CREATOR_ID=' + C + ',PRODUCT_ID=' + P + ',REDIRECT_URL=' + R + ';',
    'var lead=window.OB_LEAD||{},params=new URLSearchParams(window.location.search);',
    "var fullName=(lead.name||params.get('name')||'').trim(),email=(lead.email||params.get('email')||'').trim();",
    'var parts=fullName.split(/\\s+/),prefillObj={};',
    'if(parts[0])prefillObj.first_name=parts[0];',
    "if(parts.slice(1).join(' '))prefillObj.last_name=parts.slice(1).join(' ');",
    'if(email)prefillObj.email=email;var hasPrefill=Object.keys(prefillObj).length>0;',
    "fetch('https://www.fanbasis.com/public-api/checkout-sessions/embedded',{method:'POST',headers:{'x-api-key':API_KEY}})",
    '.then(function(res){return res.json();}).then(function(data){',
    'var secret=data&&data.data&&data.data.checkout_session_secret;if(!secret){console.error("FanBasis: no session secret",data);return;}',
    "var checkout=PaymentCheckout.create({creatorId:CREATOR_ID,productId:PRODUCT_ID,checkoutSessionSecret:secret,environment:'production',theme:{theme:'light',accent_color:'#239dde',show_product_info:false},containerOptions:{width:'100%',height:'100%'}});",
    "checkout.attachToElement(document.getElementById('fanbasis-checkout-wrapper'));checkout.init();",
    "if(hasPrefill){var pp=encodeURIComponent(JSON.stringify(prefillObj)),a=0,iv=setInterval(function(){a++;var f=document.querySelector('#fanbasis-checkout-wrapper iframe');if(f&&f.src){if(f.src.indexOf('prefill=')===-1)f.src=f.src+'&prefill='+pp;clearInterval(iv);}if(a>20)clearInterval(iv);},200);}",
    "checkout.on('checkout:success',function(ev){try{if(window.OB_ONPAID)window.OB_ONPAID();}catch(e){}if(REDIRECT_URL){setTimeout(function(){window.top.location.href=REDIRECT_URL;},700);}else if(window.OB_DONE){setTimeout(function(){try{window.OB_DONE();}catch(e){}},600);}else{var w=document.getElementById('fanbasis-checkout-wrapper');if(w)w.innerHTML='<div style=\\'text-align:center;padding:34px 18px;font-family:sans-serif\\'><div style=\\'font-size:38px\\'>\\uD83C\\uDF89</div><h3 style=\\'margin:8px 0\\'>You\\u2019re all set!</h3><p style=\\'color:#667\\'>Your reservation is confirmed \\u2014 we\\u2019ll be in touch shortly.</p></div>';}});",
    "checkout.on('checkout:error',function(err){console.error('Checkout error:',err);});",
    '}).catch(function(e){console.error("FanBasis session error:",e);});',
    '})();</scr' + 'ipt>',
  ].join("\n");
}

/* ── Contact custom fields ─────────────────────────────────────────────
   The template's GHL workflows (internal notifications, AI scripts) read
   the survey answers and the reserved slot from CONTACT custom fields.
   Field ids differ per sub-account, so we match the template's standard
   field names and cache the map per location. */
const SURVEY_FIELD_MATCHERS: [string, RegExp][] = [
  ["area", /which area/i],
  ["had_pmu", /ever had permanent makeup/i],
  ["age", /age group/i],
  ["commutable", /commutable/i],
  ["seriousness", /how serious/i],
  ["aftercare_kit", /aftercare kit/i],
  ["reserved_time", /reserved appointment time/i],
];
const surveyFieldCache = new Map<string, { at: number; map: Record<string, string> }>();
export async function getSurveyFieldMap(locationId: string, token: string): Promise<Record<string, string>> {
  const hit = surveyFieldCache.get(locationId);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.map;
  const map: Record<string, string> = {};
  try {
    const r = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}/customFields`, {
      headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
    });
    if (r.ok) {
      const { customFields } = (await r.json()) as { customFields?: { id?: string; name?: string }[] };
      for (const [key, re] of SURVEY_FIELD_MATCHERS) {
        const f = (customFields ?? []).find((x) => re.test(String(x.name ?? "")));
        if (f?.id) map[key] = f.id;
      }
    }
  } catch { /* degrade gracefully — the caller just skips the fields */ }
  surveyFieldCache.set(locationId, { at: Date.now(), map });
  return map;
}

// "2026-08-21T14:30:00-04:00" → "Friday, August 21, 2026 2:30 PM" (the
// slot's wall-clock time, matching what the template funnels store).
export function fmtReservedTime(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return d.toLocaleString("en-US", {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric",
    year: "numeric", hour: "numeric", minute: "2-digit",
  }).replace(" at ", " ");
}
