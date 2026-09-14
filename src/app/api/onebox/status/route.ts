import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

// One-box funnel status for one client, by business name — the "One-box:
// Active / Paused / Not set up" chip on the client profile. Same join the
// onebox_active_clients view uses (business name, punctuation-insensitive).
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const business = (req.nextUrl.searchParams.get("business") ?? "").trim();
  if (!business) return NextResponse.json({ status: null });
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const svc = createServiceClient();
  const { data } = await svc.from("onebox_clients").select("slug, client_name, status").neq("slug", "demo-v3").neq("slug", "pmu-bookings");
  const hit = (data ?? []).find((r) => norm(String(r.client_name ?? "")) === norm(business));
  return NextResponse.json(hit ? { status: hit.status, slug: hit.slug } : { status: null });
}
