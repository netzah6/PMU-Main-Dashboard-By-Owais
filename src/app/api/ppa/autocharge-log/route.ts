import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// The latest auto-charge run, for the banner on the PPS Billing tab.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const { data: latest } = await svc
    .from("ppa_autocharge_log")
    .select("run_at")
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) return NextResponse.json({ run: null });

  const { data: rows } = await svc
    .from("ppa_autocharge_log")
    .select("owner_key, owner_name, status, amount, shows, square_payment_id, detail")
    .eq("run_at", latest.run_at)
    .order("status");

  return NextResponse.json({ run: { runAt: latest.run_at, rows: rows ?? [] } });
}
