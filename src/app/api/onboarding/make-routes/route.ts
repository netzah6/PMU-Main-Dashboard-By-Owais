import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { buildMakeRoutesReport } from "@/lib/make-routes";

// Read-only Make scenario route map for the admin "Make routes" page.
// Reads the blueprint via the Make API — consumes no Make operations,
// creates no webhooks, changes nothing.
export const maxDuration = 120;

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const report = await buildMakeRoutesReport();
  return NextResponse.json(report, { status: report.error ? 502 : 200 });
}
