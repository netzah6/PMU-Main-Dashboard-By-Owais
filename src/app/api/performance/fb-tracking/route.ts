import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { fbTrackingBySlug } from "@/lib/fb-tracking";

export const fetchCache = "force-no-store";
export const maxDuration = 30;

/* Performance page "FB" column: one status per one-box funnel slug
   (see src/lib/fb-tracking.ts). Cached 5 minutes per server instance —
   the answer only changes when a funnel sends its next event. */
let cache: { at: number; data: Awaited<ReturnType<typeof fbTrackingBySlug>> } | null = null;

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    if (!cache || Date.now() - cache.at > 5 * 60_000) {
      cache = { at: Date.now(), data: await fbTrackingBySlug(createServiceClient()) };
    }
    /* Why Meta refused a name (token number + Meta's code/message, tokens
       stripped) is for admins checking the setup, not every viewer. */
    const { nameErrors, ...rest } = cache.data;
    return NextResponse.json(auth.role === "admin" ? { ...rest, nameErrors } : rest);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
