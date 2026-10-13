import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

/* Meta Purchase-tracking health for the Funnels tab (owner, 2026-10-13).
   The browser pixel fires Purchase the moment a deposit clears (one-box
   engine, every V2.3/V3 funnel), and the server sends a deduplicated copy
   through the Conversions API — but only with an agency token. This
   readout shows both halves for the last 7 days plus the funnels that
   can't track at all because no pixel is set. */
const PAID = ["booked", "paid", "paid-not-booked", "paid-followup"];

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "media_buyer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  try {
    type Row = { slug: string; event_name: string; ok: boolean; error: string | null; created_at: string };
    const rows: Row[] = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await svc.from("capi_events").select("slug, event_name, ok, error, created_at").gte("created_at", since).order("id").range(i, i + 999);
      if (error) throw new Error(error.message);
      if (!data?.length) break;
      rows.push(...(data as Row[]));
      if (data.length < 1000) break;
    }
    const tally = (name: string) => {
      const mine = rows.filter((r) => r.event_name === name);
      const errors: Record<string, number> = {};
      for (const r of mine) if (!r.ok) errors[r.error ?? "unknown"] = (errors[r.error ?? "unknown"] ?? 0) + 1;
      return { sent: mine.filter((r) => r.ok).length, failed: mine.filter((r) => !r.ok).length, errors };
    };
    const { data: clients } = await svc.from("onebox_clients").select("slug, client_name, config, extras").eq("status", "live");
    const noPixel = (clients ?? [])
      .filter((c) => (c.extras as { template?: string } | null)?.template !== "b2b")
      .filter((c) => !((c.config as { metaPixelId?: string } | null)?.metaPixelId || (c.extras as { metaPixelId?: string } | null)?.metaPixelId || "").replace(/\D/g, ""))
      .map((c) => ({ slug: c.slug as string, name: (c.client_name as string) || (c.slug as string) }));
    /* Paid deposits this week on funnels that HAVE a pixel — the browser
       fires Purchase on each of those; a pixel-less funnel can't, so its
       paid leads are left out rather than counted as tracked (review, Oct 13). */
    const paidQ = svc.from("onebox_leads").select("id", { count: "exact", head: true }).gte("created_at", since).in("ghl_status", PAID);
    const { count: paidLeads } = noPixel.length ? await paidQ.not("slug", "in", `(${noPixel.map((f) => f.slug).join(",")})`) : await paidQ;
    const perFunnel: Record<string, { sent: number; failed: number }> = {};
    for (const r of rows.filter((r) => r.event_name === "Purchase")) {
      const p = (perFunnel[r.slug] ??= { sent: 0, failed: 0 });
      if (r.ok) p.sent++; else p.failed++;
    }
    return NextResponse.json({
      since,
      tokenConfigured: Boolean((process.env.META_CAPI_TOKEN ?? "").trim()),
      browserPurchases: paidLeads ?? 0,
      purchase: tally("Purchase"),
      lead: tally("Lead"),
      noPixel,
      perFunnel,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
