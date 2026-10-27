import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { computeBriefs } from "@/lib/cpd-brief";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

// Hourly: rewrites the client briefs (Cost per Deposit dropdown) that are
// older than 20 hours, oldest first, as many as fit in the time budget — so
// the whole fleet is refreshed every day without one run doing it all.
// ?slug=x     one client, regardless of age
// ?force=1    everyone, regardless of age
// ?limit=n    cap this run
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const p = req.nextUrl.searchParams;
  const slug = p.get("slug")?.trim() || undefined;
  const limit = Math.max(0, Math.min(200, Number(p.get("limit") ?? 0))) || undefined;
  const force = p.get("force") === "1";
  const svc = createServiceClient();
  const result = await computeBriefs(svc, { slug, limit, force });
  return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
}
