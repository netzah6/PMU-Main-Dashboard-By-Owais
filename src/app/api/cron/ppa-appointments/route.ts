import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { ingestAppointments, getAuth } from "@/lib/ppa";

export const maxDuration = 300;

// Refresh calendar appointments for all deposit leads, then rebuild the V3
// billing materialized view (upcoming / past-due / ready-to-charge). Cron
// secret, or an admin.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronOk = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const auth = await getAuth();
    if (!auth || auth.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const res = await ingestAppointments();
  const { error } = await createServiceClient().rpc("refresh_ppa_facts");
  return NextResponse.json({ ...res, refreshed: !error, refreshError: error?.message ?? null });
}
