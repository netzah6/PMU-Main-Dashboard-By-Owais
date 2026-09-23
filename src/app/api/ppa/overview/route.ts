import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getPpaRoster, warmStageMap, ingestAppointments } from "@/lib/ppa";
import { buildPpaClients } from "@/lib/ppa-overview";

export const maxDuration = 300;

// V3 pay-per-appointment billing overview — one row per V3 client. All counts
// are DEPOSIT-LINKED and time-aware: each deposit is resolved to its lead's
// stage AND scheduled appointment, so "ready to charge" = appointments that
// actually happened (served or past-due) and aren't charged yet. Admin only.

type LocRow = { owner_key: string; location_id: string | null };

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const { clients: roster, missingFromMaster } = await getPpaRoster();
  const ownerKeys = roster.map((c) => c.ownerKey);

  // On refresh: re-warm stage names AND re-pull calendar appointments for all
  // deposit leads (~330 contacts, ~30s). Normal loads read the cached tables.
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const { data: locs } = await svc.from("ppa_stage_counts").select("owner_key, location_id").in("owner_key", ownerKeys);
  const locations = ((locs ?? []) as LocRow[]).map((r) => r.location_id).filter(Boolean) as string[];
  await warmStageMap(locations, refresh);
  if (refresh) { await ingestAppointments(); await svc.rpc("refresh_ppa_facts"); }

  const clients = await buildPpaClients(roster);

  return NextResponse.json({ clients, missingFromMaster });
}
