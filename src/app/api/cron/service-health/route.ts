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
    // Second opinion on CloseBot: is it the key, or just one address?
    if (process.env.CLOSEBOT_API_KEY) {
      const k = String(process.env.CLOSEBOT_API_KEY);
      const alt: Record<string, number> = {};
      for (const u of ["https://api.closebot.com/bot", "https://api.closebot.com/agency/source?pageSize=1", "https://api.closebot.com/agency/current"]) {
        alt[u] = await fetch(u, { headers: { "X-CB-KEY": k, Accept: "application/json" }, cache: "no-store" }).then((r) => r.status).catch(() => -1);
      }
      out.closebotAlt = alt;
    }
    return NextResponse.json(out);
  }
  return NextResponse.json(await scanServiceHealth(createServiceClient()));
}
