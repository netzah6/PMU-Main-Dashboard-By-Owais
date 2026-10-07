import type { SupabaseClient } from "@supabase/supabase-js";

/* Client info-request links ("intake", owner request 2026-10-07): each
   funnel can mint one unguessable link to a public form that asks the
   ARTIST only for the setup fields that are still empty. Submitting
   writes the answers into the sub-account's custom values through the
   same path Start Setup uses, so the funnel updates immediately; an
   alert + a Notifications-tab row tell the team it happened.

   Only fields the CLIENT can answer are ever asked — team-side settings
   (offer, deposit, calendar id, Commas product, webhook, widgets, logo)
   never appear here. Price fields are V3-only (V2.3/V1 have no AI, the
   fields are unused — owner rule 2026-10-01). */

export type IntakeField = {
  k: string; // config key = ONEBOX_EDITABLE_CVS key
  label: string;
  hint?: string;
  type: "text" | "textarea";
  v3Only?: boolean;
};

export const INTAKE_FIELDS: IntakeField[] = [
  { k: "ownerName", label: "Owner's first name", type: "text" },
  { k: "biz", label: "Business name", type: "text" },
  { k: "phone", label: "Business phone number", type: "text" },
  { k: "address", label: "Full studio address", type: "text" },
  { k: "businessHours", label: "Business hours", hint: "e.g. Monday CLOSED | Tuesday 10:00 AM - 6:00 PM | …", type: "textarea" },
  { k: "services", label: "Services you offer", hint: "Comma-separated, e.g. Microblading, Powder Brows, Lip Blush", type: "textarea" },
  { k: "yearsInBusiness", label: "Years in business", type: "text" },
  { k: "firstTouchup", label: "When is the first touch-up?", type: "text" },
  { k: "otherLocations", label: "Other locations (if any)", type: "text" },
  { k: "igLink", label: "Instagram page link", type: "text" },
  { k: "fbLink", label: "Facebook page link", type: "text" },
  { k: "gmbLink", label: "Google Business link", type: "text" },
  { k: "originalPrice", label: "Regular price for brows ($)", type: "text", v3Only: true },
  { k: "discountedPrice", label: "Discounted price for brows ($)", type: "text", v3Only: true },
  { k: "touchupPrice", label: "Touch-up price ($)", type: "text", v3Only: true },
];

export function missingIntakeFields(cfg: Record<string, string>, isV3: boolean): IntakeField[] {
  return INTAKE_FIELDS.filter((f) => (!f.v3Only || isV3) && !String(cfg[f.k] ?? "").trim());
}

/* Photo asks (owner, 2026-10-08): when the funnel has fewer than 3 studio
   pictures or fewer than 3 before/after pictures, the form also asks for
   uploads. Counts span both the aggregated CV-slot lists and the
   dashboard-managed lists; new uploads append to the dashboard lists
   ("CC - Studio Images" / "CC - Result Images"). */
export const PHOTO_ASKS = [
  { k: "studioPhotos", cv: "studioImgs", label: "Pictures of your studio", hint: "Up to 3 photos of your space", countKeys: ["studioImgs", "studioCvImgs"], min: 3 },
  { k: "baPhotos", cv: "resultImgs", label: "Your best before & after pictures", hint: "Eyebrows, lips or eyeliner — your best transformations (up to 6)", countKeys: ["resultImgs", "resultCvImgs"], min: 3 },
] as const;

export function photoCount(cfg: Record<string, string>, keys: readonly string[]): number {
  return new Set(keys.flatMap((k) => String(cfg[k] ?? "").split(",")).map((u) => u.trim()).filter(Boolean)).size;
}

export function missingPhotoAsks(cfg: Record<string, string>) {
  return PHOTO_ASKS.filter((p) => photoCount(cfg, p.countKeys) < p.min);
}

/* The funnel's program version from the Clients-sheet mirror — same
   normalized-name match the fix-list sweeps use. */
export async function clientIsV3(svc: SupabaseClient, clientName: string): Promise<boolean> {
  const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const { data: prog } = await svc.from("client_program_rows").select("business_name, version");
  const n = norm(clientName);
  const hit =
    (prog ?? []).find((p) => norm(p.business_name) === n) ||
    (prog ?? []).find((p) => n && (norm(p.business_name).includes(n) || n.includes(norm(p.business_name))));
  return /v3/i.test(String(hit?.version ?? ""));
}

export async function assignedCoach(svc: SupabaseClient, clientName: string): Promise<string | null> {
  const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const { data } = await svc.from("clients_master").select("data");
  const n = norm(clientName);
  const hit = (data ?? []).find((r) => norm(String((r.data as Record<string, unknown>)?.["Business Name"] ?? "")) === n);
  const coach = String((hit?.data as Record<string, unknown>)?.["Assigned"] ?? "").trim();
  return coach || null;
}
