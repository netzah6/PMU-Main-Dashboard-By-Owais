import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

/* 🎬 Presentations tab (owner, 11/26/2026): every Client Success Coach has a
   small public profile — a picture and the email clients may write to — that
   the Launch Call decks show on their intro and contact slides. A coach
   uploads the picture once in the Presentations tab and every deck opened
   with ?coach=<name> picks it up.

   One app_settings row per coach: key "coach_profile:<slug>". The slug is the
   letters of the email's local part ("Stephanie@…" → "stephanie"), the same
   rule lib/coach.ts uses to match a coach to her book. Pictures live in the
   public "onboarding" bucket under coach-profile/, each under a new name so a
   replaced picture is never served from a cache. */

type Svc = ReturnType<typeof createServiceClient>;

export const COACH_PHOTO_BUCKET = "onboarding";
export const COACH_PHOTO_PREFIX = "coach-profile/";

export interface CoachProfile {
  slug: string;
  name: string;
  email: string;
  photo: string | null;
  /** her own business line, as clients see it — "(206) 429-6368". Empty → the decks show the main line. */
  phone?: string | null;
}

/** "+12064296368" → "(206) 429-6368"; any other shape is shown as stored. */
export const prettyPhone = (v: string | null | undefined) => {
  const m = String(v ?? "").replace(/\D/g, "").match(/^1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(v ?? "").trim();
};

/* The phone on the "Open Communication" slide (owner, 11/26/2026: "their phone
   number — you have it on the CRM"). It is the coach's own BUSINESS line in the
   agency account (the number assigned to her user there), matched by her login
   email — never the personal mobile on her user profile, because this goes on a
   page clients see. A coach with no line of her own keeps the main business
   number the slide already shows (calls to it ring whoever the client is
   assigned to). Returns null when the CRM can't be reached, so a saved number
   is never wiped by a bad moment. */
const AGENCY_LOCATION_ID = "SfpNMJ5YU9lBkxss47lK"; // PMU Bookings On Demand
let linesCache: { at: number; byEmail: Map<string, string> } | null = null;
export async function crmBusinessLines(): Promise<Map<string, string> | null> {
  if (linesCache && Date.now() - linesCache.at < 10 * 60_000) return linesCache.byEmail;
  try {
    const { token } = await getAppLocationToken(AGENCY_LOCATION_ID);
    if (!token) return null;
    const r = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${AGENCY_LOCATION_ID}`, {
      headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" }, cache: "no-store",
    });
    if (!r.ok) return null;
    const users = ((await r.json()) as { users?: Array<{ email?: string; deleted?: boolean; lcPhone?: Record<string, string> }> }).users ?? [];
    const byEmail = new Map<string, string>();
    for (const u of users) {
      if (u.email && !u.deleted) byEmail.set(u.email.toLowerCase(), prettyPhone(u.lcPhone?.[AGENCY_LOCATION_ID]));
    }
    linesCache = { at: Date.now(), byEmail };
    return byEmail;
  } catch { return null; }
}

export const coachSlug = (v: string | null | undefined) =>
  String(v ?? "").split("@")[0].replace(/[^a-z]/gi, "").toLowerCase();

export const profileKey = (slug: string) => `coach_profile:${slug}`;

/** "stephanie" → "Stephanie" — used until a team name is set in Settings. */
export const nameFromSlug = (slug: string) => (slug ? slug[0].toUpperCase() + slug.slice(1) : "");

export async function readProfile(svc: Svc, slug: string): Promise<Partial<CoachProfile> | null> {
  if (!slug) return null;
  const { data } = await svc.from("app_settings").select("value").eq("key", profileKey(slug)).maybeSingle();
  const v = data?.value as Partial<CoachProfile> | null | undefined;
  return v && typeof v === "object" ? v : null;
}
