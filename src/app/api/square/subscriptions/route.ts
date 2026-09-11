import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { squareConfigured } from "@/lib/square";
import { readSquareSnapshot, refreshSquareSnapshot, SNAPSHOT_FRESH_MS } from "@/lib/square-snapshot";

// A live rebuild walks ~750 subscriptions and takes ~80s; the tab must never
// wait on that. Ordinary loads return the stored snapshot instantly and, if it
// is going stale, kick off a rebuild in the background for next time. Only
// ?refresh=1 (the Refresh button, and the moment after a pause/resume) waits
// for a live rebuild — because then the user asked for current data.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!squareConfigured()) {
    return NextResponse.json(
      { error: "Square is not configured yet — add SQUARE_ACCESS_TOKEN to the dashboard environment." },
      { status: 503 }
    );
  }

  const svc = createServiceClient();
  const wantLive = req.nextUrl.searchParams.get("refresh") === "1";

  try {
    if (!wantLive) {
      const snap = await readSquareSnapshot(svc);
      if (snap) {
        const ageMs = Date.now() - new Date(snap.fetchedAt).getTime();
        // Stale but present: serve it now, rebuild after the response is sent.
        if (ageMs > SNAPSHOT_FRESH_MS) waitUntil(refreshSquareSnapshot(svc).catch(() => {}));
        return NextResponse.json({ ...snap.payload, cachedAt: snap.fetchedAt, refreshing: ageMs > SNAPSHOT_FRESH_MS, lastError: snap.error });
      }
    }
    const snap = await refreshSquareSnapshot(svc);
    return NextResponse.json({ ...snap.payload, cachedAt: snap.fetchedAt, refreshing: false, lastError: snap.error, live: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Square request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
