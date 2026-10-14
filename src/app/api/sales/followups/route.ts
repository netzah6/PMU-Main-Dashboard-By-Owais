import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { createServiceClient } from "@/lib/supabase/server";
import { syncSalesFollowUps } from "@/lib/sales-followups";
import { SALES_ROLES, type UserRole } from "@/lib/types";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/* "Refresh follow-ups" on the Sales tab: re-read the GHL call/text log now
   instead of waiting for the hourly cron. Anyone who can see the board can
   refresh it. */
export async function POST() {
  const auth = await getAuth();
  if (!auth || !auth.role || !["admin", ...SALES_ROLES].includes(auth.role as UserRole)) {
    return NextResponse.json({ error: "Admins and sales seats only" }, { status: 403 });
  }
  try {
    const res = await syncSalesFollowUps(createServiceClient(), { maxAgeMin: 0, deadlineMs: 100_000 });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
