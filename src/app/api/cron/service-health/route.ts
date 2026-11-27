import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { checks, plainReason, scanServiceHealth } from "@/lib/service-health";

export const maxDuration = 120;

/* Manual check of the outside services. The real run rides the 30-min
   alerts-scan. ?dry=1 probes every service and writes nothing. */
export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (req.nextUrl.searchParams.get("dry")) {
    const out: Record<string, unknown> = {};
    await Promise.all(checks().map(async (c) => {
      try { const p = await c.run(); out[c.key] = p.ok ? p : { ...p, plain: plainReason(p.why) }; }
      catch (e) { out[c.key] = { ok: false, why: String(e) }; }
    }));
    return NextResponse.json(out);
  }
  return NextResponse.json(await scanServiceHealth(createServiceClient()));
}
