import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

// Live funnels whose Instagram grid has playable reels (Booking pages gallery filter).
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data } = await svc.from("onebox_clients").select("slug, extras").eq("status", "live");
  const slugs = (data ?? [])
    .filter((c) => ((c.extras as { igFeed?: { posts?: { video?: string }[] } } | null)?.igFeed?.posts ?? []).some((p) => !!p.video))
    .map((c) => String(c.slug));
  return NextResponse.json({ slugs });
}
