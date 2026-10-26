import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getAppAgencyToken } from "@/lib/ghl-app";
import { resolveClientLocation } from "@/lib/agent-exec";

const GHL_API_KEY = process.env.GHL_API_KEY!;

// Time zone of the client behind an AI-tab chat (owner, 10/26/2026: show it
// next to the name in the open chat). Primary source: the client's OWN
// sub-account timezone (matched via Clients Master); fallback: the agency
// contact's timezone field (rarely set). Cached in-process for 6h per contact.
const cache = new Map<string, { ts: number; tz: string | null }>();

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const contactId = (req.nextUrl.searchParams.get("contactId") ?? "").trim() || null;
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim();
  if (!contactId && !name) return NextResponse.json({ error: "contactId or name required" }, { status: 400 });

  const key = `${contactId ?? ""}|${name.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < 6 * 60 * 60 * 1000) return NextResponse.json({ timezone: hit.tz });

  let tz: string | null = null;
  try {
    const loc = await resolveClientLocation(createServiceClient(), contactId, name);
    const agency = loc ? await getAppAgencyToken() : null;
    if (loc && agency) {
      const r = await fetch(`https://services.leadconnectorhq.com/locations/${loc.locationId}`, {
        headers: { Authorization: `Bearer ${agency.token}`, Version: "2021-07-28", Accept: "application/json" },
      });
      const j = (await r.json().catch(() => ({}))) as { location?: { timezone?: string }; timezone?: string };
      tz = j.location?.timezone ?? j.timezone ?? null;
    }
  } catch { /* fall through to the contact */ }

  if (!tz && contactId) {
    try {
      const r = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
        headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: "2021-07-28", Accept: "application/json" },
      });
      const j = (await r.json().catch(() => ({}))) as { contact?: { timezone?: string } };
      tz = j.contact?.timezone ?? null;
    } catch { /* leave unset */ }
  }

  cache.set(key, { ts: Date.now(), tz });
  return NextResponse.json({ timezone: tz });
}
