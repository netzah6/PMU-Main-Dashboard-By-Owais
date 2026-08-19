import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { buildMakeRoutesReport } from "@/lib/make-routes";

// Read-only Make scenario route map for the admin "Make routes" page.
// Reads the blueprint via the Make API — consumes no Make operations,
// creates no webhooks, changes nothing.
export const maxDuration = 120;

export async function GET(req: Request) {
  // TEMP debug path: cron-secret auth + ?raw=1 returns the first raw routes so
  // the blueprint shape can be inspected without a browser session. Removed
  // before merge.
  const url = new URL(req.url);
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const cronOk = !!process.env.CRON_SECRET && bearer === process.env.CRON_SECRET;
  if (!cronOk) {
    const auth = await getAuth();
    if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (url.searchParams.get("raw") === "1" && cronOk) {
    const { debugRawRoutes } = await import("@/lib/make-routes");
    return NextResponse.json(await debugRawRoutes());
  }

  const report = await buildMakeRoutesReport();
  return NextResponse.json(report, { status: report.error ? 502 : 200 });
}
