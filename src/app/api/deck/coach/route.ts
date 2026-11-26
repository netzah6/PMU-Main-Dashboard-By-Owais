import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { coachSlug, readProfile } from "@/lib/coach-profile";

/* PUBLIC, read-only: the Launch Call decks (static pages under /deck) ask
   who is presenting — /api/deck/coach?c=stephanie — and get back only what
   the coach chose to show a client: first name, work email, picture. No
   sign-in on purpose: the deck is shown on a shared screen and opened from
   any browser. Unknown name → an empty object, never an error page. */
export async function GET(req: NextRequest) {
  const slug = coachSlug(req.nextUrl.searchParams.get("c")).slice(0, 40);
  const p = slug ? await readProfile(createServiceClient(), slug) : null;
  const body = p ? { name: p.name ?? "", email: p.email ?? "", photo: p.photo ?? null } : {};
  return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=60" } });
}
