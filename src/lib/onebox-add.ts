import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";
import { refreshOneboxConfig, harvestFirstPixel, ensureOneboxCustomValues, setOneboxCustomValues, healFunnelPhotos, getAreaFieldOptions, ONEBOX_EDITABLE_CVS } from "@/lib/onebox";

/* "Add client" on the Funnels tab, as a function — the New Client Setup run
   creates the one-box funnel with exactly the same steps (row, pixel
   harvest, one-box custom values, photo heal, survey seed, pre-fill from
   the Clients sheet), so the two paths can never drift. The route
   (/api/onebox/admin, action "add") calls this and returns its result. */

type Svc = SupabaseClient;

// Public funnel URL on the branded domain (book.pmu-care.com is a CNAME
// onto this same Vercel deployment; middleware rewrites the short path).
export const FUNNEL_ORIGIN = "https://book.pmu-care.com";

type Extras = {
  metaPixelId?: string;
  oldFunnelUrl?: string;
  [k: string]: unknown;
};

export type AddFunnelInput = { slug: string; locationId: string; clientName: string; oldFunnelUrl?: string };
export type AddFunnelResult =
  | { error: string; status: number; conflict?: { slug: string; clientName: string; status: string } }
  | { ok: true; slug: string; url: string; pixelNote: string; photoNote: string; surveyNote: string; cvNote: string; synced: boolean; calendarId: string };

/* First survey question from the account's own data: the options of the
   "CC - Which Area(s) Would You Like Treated?" contact field are what the
   client's GHL survey maps onto, so the one-box asks exactly those — one
   service or five. Runs only while no survey exists yet (never over an
   edited one). Even ONE option is seeded: the dashboard's fallback
   template says "Lips; Eyebrows", which is wrong for a brows-only studio. */
export async function seedSurveyFromAccount(
  svc: Svc, slug: string, locationId: string, config: Record<string, string> | null,
): Promise<{ config: Record<string, string> | null; note: string; seeded: boolean }> {
  if ((config?.surveyRaw ?? "").trim()) return { config, note: "", seeded: false };
  const areas = await getAreaFieldOptions(locationId);
  if (!areas.length) return { config, note: "standard survey (no service list on the CC - Which Area(s) field)", seeded: false };
  const surveyRaw = [
    `Which Area(s) Would You Like Treated? | ${areas.join("; ")}`,
    "Have You Ever Had Permanent Makeup Before? | Yes; No",
    "What Age Group Are You In? | 18-24; 24-30; 30-36; 36-42; 42-54; 54-65; 65+",
    "Our Address is {address}. Is This commutable for you? | Yes; No",
    "On A Scale From 1-10 How Serious Are You About Getting This Treatment? | 0-2; 3-6; 7-9; 10 I Want This Treatment!",
    "Would you like a FREE Aftercare Kit? | Yes; No",
  ].join("\n");
  const res = await setOneboxCustomValues(locationId, [{ name: "OB - Survey Questions", value: surveyRaw }]);
  if (res.error) return { config, note: `survey not seeded (${res.error})`, seeded: false };
  const fresh = await refreshOneboxConfig(svc, slug, locationId, { "OB - Survey Questions": surveyRaw });
  return { config: fresh, note: `survey seeded with the account's services: ${areas.join(", ")}`, seeded: true };
}

export async function addOneboxFunnel(svc: Svc, input: AddFunnelInput): Promise<AddFunnelResult> {
  const slug = String(input.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const locationId = String(input.locationId ?? "").trim();
  if (!slug || !locationId) return { error: "slug and locationId required", status: 400 };
  const { data: existing } = await svc.from("onebox_clients").select("slug, client_name, location_id, status").eq("slug", slug).maybeSingle();
  /* Recycled sub-accounts (owner, 2026-10-08): an offboarded client's
     location gets reused for a NEW client, but the old funnel row still
     holds the location ID and the add was refused. A NON-LIVE holder is
     a retired funnel on a recycled account — retire its row (leads and
     history keep their slug) and let the new funnel take the location.
     A LIVE holder still refuses: that is a real duplicate. */
  let recycledNote = "";
  const slugBlocks = existing && !(String(existing.location_id) === locationId && existing.status !== "live");
  if (slugBlocks) {
    const sameAccount = String(existing!.location_id) === locationId;
    return {
      status: 409,
      error: sameAccount
        ? `this sub-account already has a LIVE funnel: "${existing!.client_name}" (slug ${slug}) — search for it above`
        : `slug "${slug}" is already used by "${existing!.client_name}" (a different sub-account) — pick another slug, or search for "${existing!.client_name}" if that funnel is misnamed`,
    };
  }
  /* One sub-account, one funnel. The config (deposit URL, calendar,
     photos, survey) is read from the location's custom values, so a
     second funnel on the same location ID is the same business wearing
     another name — H3 Brows Beauty Bar was created on Beauty Beyond
     Scars' location by mistake (owner, 2026-09-28). Refuse, and say who
     holds the ID so a typo is obvious. */
  const { data: sameLocation } = await svc
    .from("onebox_clients")
    .select("slug, client_name, status")
    .eq("location_id", locationId)
    .order("created_at", { ascending: true });
  if (sameLocation && sameLocation.length > 0) {
    const live = sameLocation.find((h) => h.status === "live");
    if (live) {
      return {
        status: 409,
        error: `location ID ${locationId} is already used by "${live.client_name}" (slug ${live.slug}, live) — each sub-account can have only one funnel. Check the ID in GHL: if this is a different business, it has a different location ID`,
        conflict: { slug: live.slug, clientName: live.client_name, status: live.status },
      };
    }
    // Every holder is retired — recycle: remove the old row(s).
    const names = sameLocation.map((h) => `${h.client_name} (/${h.slug})`).join(", ");
    const { error: delErr } = await svc.from("onebox_clients").delete().eq("location_id", locationId);
    if (delErr) return { error: `could not retire the old funnel: ${delErr.message}`, status: 500 };
    recycledNote = `recycled sub-account — retired old funnel ${names}`;
  }

  /* Meta pixel: harvested from the client's original GHL pages — the
     same candidate list as Sync and the Step-5 verify (lib/onebox
     pixelCandidates: the -old page, the given URL, its booking twin,
     then slug guesses when no URL is given). */
  const extras: Extras = {};
  let pixelNote = "";
  const oldUrl = String(input.oldFunnelUrl ?? "").trim();
  if (oldUrl) extras.oldFunnelUrl = oldUrl;
  const harvested = await harvestFirstPixel(slug, oldUrl);
  if (harvested.id) { extras.metaPixelId = harvested.id; pixelNote = `pixel ${harvested.id} harvested from ${harvested.from}`; }
  else pixelNote = oldUrl
    ? "no pixel found on the funnel pages — set OB - Meta Pixel ID or Extras"
    : "no pixel found — add the original funnel URL (Start Setup step 5 retries the harvest once the redirect is verified)";

  await svc.from("onebox_clients").insert({
    slug,
    location_id: locationId,
    client_name: String(input.clientName ?? "").trim(),
    status: "paused",
    extras,
  });
  // Older sub-accounts miss the one-box custom values — create the
  // absent ones (empty) so the team only has to fill values in GHL.
  const ensured = await ensureOneboxCustomValues(locationId);
  let config = await refreshOneboxConfig(svc, slug, locationId);
  /* Photos come along automatically: whenever the photo CVs are empty
     OR still the snapshot's stock pictures, harvest the client's own
     before/after and studio photos from the original booking page. */
  const bookingUrl = oldUrl
    ? oldUrl.replace(/-survey[a-z0-9-]*\/?$/i, "-booking")
    : `https://pmu-care.com/${slug}-booking`;
  const healed = await healFunnelPhotos(svc, slug, locationId, bookingUrl, config);
  config = healed.config;
  const photoNote = healed.note;
  /* First survey question from the account's own data: the options on
     the "CC - Which Area(s)…" contact field ARE the client's service
     list (Netzah, 2026-09-19). Seed OB - Survey Questions with them so
     a new funnel offers the right services from day one — only when no
     survey exists yet, never over an edited one. */
  const seeded = await seedSurveyFromAccount(svc, slug, locationId, config);
  config = seeded.config;
  const surveyNote = seeded.note;
  /* Pre-fill from what the dashboard already knows (owner, 2026-10-08:
     "why is it asking me to fill all that again?"): the Clients-sheet
     row carries business name, address, offer, phone, owner, IG and FB
     links, and the sub-account's own calendar list carries the
     Transformation calendar ID. Fill only STILL-EMPTY values — never
     overwrite anything typed or synced. */
  let prefillNote = "";
  const tokForCal = await getAppLocationToken(locationId);
  try {
    const cfgNow = (config ?? {}) as Record<string, string>;
    const normName = (x: string) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const { data: cm } = await svc.from("clients_master").select("data");
    const wanted = normName(String(input.clientName ?? ""));
    const sheet = ((cm ?? []).find((r) => normName(String((r.data as Record<string, unknown>)?.["Business Name"] ?? "")) === wanted)?.data ?? {}) as Record<string, unknown>;
    const fromSheet: [cfgKey: string, sheetKey: string][] = [
      ["biz", "Business Name"], ["address", "Location (Full adress)"], ["offer", "Offer"],
      ["phone", "Phone"], ["ownerName", "Owner Full Name"], ["igLink", "IG Page link"], ["fbLink", "FB Page link"],
    ];
    const entries: { name: string; value: string }[] = [];
    const filled: string[] = [];
    for (const [k, sk] of fromSheet) {
      const v = String(sheet[sk] ?? "").trim();
      if (v && !String(cfgNow[k] ?? "").trim() && ONEBOX_EDITABLE_CVS[k]) {
        entries.push({ name: ONEBOX_EDITABLE_CVS[k], value: v.slice(0, 500) });
        filled.push(k);
      }
    }
    if (!String(cfgNow.calendarId ?? "").trim() && tokForCal.token) {
      const cr = await fetch(`https://services.leadconnectorhq.com/calendars/?locationId=${locationId}`, {
        headers: { Authorization: `Bearer ${tokForCal.token}`, Version: "2021-04-15", Accept: "application/json" },
      }).then((r) => r.json()).catch(() => null) as { calendars?: { id: string; name?: string }[] } | null;
      const cals = cr?.calendars ?? [];
      const cal = cals.find((c) => /transformation/i.test(String(c.name ?? ""))) ?? (cals.length === 1 ? cals[0] : undefined);
      if (cal?.id) { entries.push({ name: ONEBOX_EDITABLE_CVS.calendarId, value: cal.id }); filled.push("calendarId"); }
    }
    if (entries.length) {
      const w = await setOneboxCustomValues(locationId, entries);
      const justWritten = Object.fromEntries(entries.filter((e) => w.written.includes(e.name)).map((e) => [e.name, e.value]));
      config = (await refreshOneboxConfig(svc, slug, locationId, justWritten)) ?? config;
      prefillNote = `pre-filled from the dashboard: ${filled.join(", ")}`;
    }
  } catch { /* pre-fill is a convenience — never fail the add */ }
  return {
    ok: true, slug, url: `${FUNNEL_ORIGIN}/${slug}`,
    pixelNote: [recycledNote, pixelNote, prefillNote].filter(Boolean).join(" · "),
    photoNote, surveyNote,
    cvNote: ensured.created.length
      ? `created ${ensured.created.length} missing custom values: ${ensured.created.join(", ")} — fill them in GHL`
      : "all one-box custom values already existed",
    synced: !!config, calendarId: config?.calendarId ?? "",
  };
}
