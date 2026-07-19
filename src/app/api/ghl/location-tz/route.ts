import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAppAgencyToken } from "@/lib/ghl-app";
import { resolveLocationId } from "@/lib/onboarding-verify";

// The client's time zone, read from THEIR sub-account (every GHL location has
// one) — far more reliable than the agency-side contact's timezone field,
// which is rarely set. Cached in-process for 6h per business.
const cache = new Map<string, { ts: number; tz: string | null }>();

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const business = (req.nextUrl.searchParams.get("business") ?? "").trim();
  if (!business) return NextResponse.json({ error: "business required" }, { status: 400 });

  const key = business.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < 6 * 60 * 60 * 1000) return NextResponse.json({ timezone: hit.tz });

  try {
    let tz: string | null = null;
    const locationId = await resolveLocationId(business);
    if (locationId) {
      const agency = await getAppAgencyToken();
      if (agency) {
        const r = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}`, {
          headers: { Authorization: `Bearer ${agency.token}`, Version: "2021-07-28", Accept: "application/json" },
        });
        const j = (await r.json().catch(() => ({}))) as { location?: { timezone?: string }; timezone?: string };
        tz = j.location?.timezone ?? j.timezone ?? null;
      }
    }
    cache.set(key, { ts: Date.now(), tz });
    return NextResponse.json({ timezone: tz });
  } catch {
    return NextResponse.json({ timezone: null });
  }
}
