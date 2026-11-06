import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { fmtWhen, pickEmail, pickEmailSummary, setPickEmailEnabled } from "@/lib/pick-email";

export const fetchCache = "force-no-store";
export const maxDuration = 60;

/* The Funnels-tab card for the "finish your deposit" email (owner, 11/03/2026).
   Admins only.
     GET                              → switch state, the two sides, and both emails filled in for a sample funnel
     POST { action: "toggle", enabled } → switch on (counting starts now) / off */
async function admin() {
  const auth = await getAuth();
  return auth && auth.role === "admin" ? auth : null;
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const svc = createServiceClient();
  try {
    const summary = await pickEmailSummary(svc);
    // Sample: a live funnel with a business name, a time two days out at 1 PM.
    const { data: f } = await svc.from("onebox_clients").select("slug, client_name, config, extras").eq("status", "live").limit(60);
    const sample = ((f ?? []) as { slug: string; client_name: string | null; config: Record<string, unknown> | null; extras: Record<string, unknown> | null }[])
      .find((x) => x.extras?.template !== "b2b" && !x.extras?.freeBooking && String(x.config?.biz ?? "").trim());
    const d = new Date(Date.now() + 2 * 86400_000);
    const iso = `${d.toISOString().slice(0, 10)}T13:00:00`;
    const vars = {
      first: "Jessica",
      biz: String(sample?.config?.biz ?? sample?.client_name ?? "Brows by Anna").trim(),
      when: fmtWhen(iso),
      deposit: String(sample?.config?.deposit ?? "").trim() || "$50",
      link: sample ? `https://book.pmu-care.com/f/${sample.slug}?preview=deposit` : "https://book.pmu-care.com",
      service: "permanent makeup",
    };
    return NextResponse.json(
      { ...summary, preview: [pickEmail(1, vars), pickEmail(2, vars)], sampleSlug: sample?.slug ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await admin();
  if (!auth) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; enabled?: boolean };
  if (body.action !== "toggle" || typeof body.enabled !== "boolean") return NextResponse.json({ error: "action toggle + enabled required" }, { status: 400 });
  try {
    const settings = await setPickEmailEnabled(createServiceClient(), body.enabled, auth.email ?? auth.userId);
    return NextResponse.json({ ok: true, settings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
