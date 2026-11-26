import { createServiceClient } from "@/lib/supabase/server";

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
