import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { verifyOnboarding } from "@/lib/onboarding-verify";

export const maxDuration = 120;

// Ad-hoc setup check by client/business name OR sub-account (location) id.
// Resolves the sub-account, then grades the live setup. No onboarding record.
const LOCATION_ID = /^[A-Za-z0-9]{18,26}$/; // GHL location ids have no spaces

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { query?: string };
  const query = String(body.query ?? "").trim();
  if (!query) return NextResponse.json({ error: "Enter a client name or sub-account ID" }, { status: 400 });

  let business = query;
  let locationId: string | null = null;
  if (LOCATION_ID.test(query) && !query.includes(" ")) {
    locationId = query;
    // Resolve the business name for the sheet-side checks.
    const svc = createServiceClient();
    const { data: ss } = await svc.from("ghl_sync_status").select("owner_key").eq("location_id", query).maybeSingle();
    if (ss?.owner_key) {
      const { data: cm } = await svc.from("clients_master").select("data");
      for (const r of (cm ?? []) as Array<{ data: Record<string, unknown> }>) {
        if (String(r.data?.["Owner Full Name"] ?? "").trim().toLowerCase() === ss.owner_key) { business = String(r.data?.["Business Name"] ?? "").trim(); break; }
      }
    }
  }

  const result = await verifyOnboarding({ business_name: business }, { locationId });
  return NextResponse.json({ ranAt: new Date().toISOString(), query, business, ...result });
}
