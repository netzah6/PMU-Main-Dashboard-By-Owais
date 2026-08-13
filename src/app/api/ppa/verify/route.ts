import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { buildVerifyReport } from "@/lib/ppa-verify";
import { squareConfigured } from "@/lib/square";

// Square customer/card verification for the PPS roster: who would be charged,
// on what card, for which shows, and everything that would make that charge
// wrong. Read-only — no Square write endpoint is called from here.
// A full run is ~2 Square calls per client plus (only when someone can't be
// matched) a paginated customer scan, so it gets the long ceiling.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (!squareConfigured()) {
    return NextResponse.json(
      { error: "Square is not configured yet — add SQUARE_ACCESS_TOKEN to the dashboard environment." },
      { status: 503 }
    );
  }

  const ownerKey = (req.nextUrl.searchParams.get("owner_key") ?? "").trim().toLowerCase();
  try {
    const report = await buildVerifyReport(ownerKey || undefined);
    return NextResponse.json(report);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Verification failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
