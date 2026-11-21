import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { confirmLink } from "@/lib/pick-email";
import { PICK_SMS_TEXT, pickSmsSummary, pickSmsText, setPickSmsEnabled, smsSegments } from "@/lib/pick-sms";

export const fetchCache = "force-no-store";
export const maxDuration = 60;

/* The Funnels-tab card for the pick-time text to quiet pickers (owner, 11/21/2026).
   Admins only.
     GET                                → switch state, the two sides, and the text filled in for a sample lead
     POST { action: "toggle", enabled } → switch on (counting starts now) / off */
async function admin() {
  const auth = await getAuth();
  return auth && auth.role === "admin" ? auth : null;
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const svc = createServiceClient();
  try {
    const summary = await pickSmsSummary(svc);
    // Sample: a live funnel, a time two days out at 1 PM, a 20-character contact id (the real length of the link).
    const { data: f } = await svc.from("onebox_clients").select("slug, extras").eq("status", "live").limit(60);
    const sample = ((f ?? []) as { slug: string; extras: Record<string, unknown> | null }[])
      .find((x) => x.extras?.template !== "b2b" && !x.extras?.freeBooking && !x.extras?.noPickSms && !x.extras?.noPickEmail);
    const d = new Date(Date.now() + 2 * 86400_000);
    const text = pickSmsText({
      first: "Jessica",
      slotIso: `${d.toISOString().slice(0, 10)}T13:00:00`,
      service: "eyebrow permanent makeup",
      link: confirmLink(sample?.slug ?? "brows-by-anna", "aB3dE5fG7hJ9kL1mN3pQ", "sms"),
    });
    return NextResponse.json(
      { ...summary, preview: { text, template: PICK_SMS_TEXT, ...smsSegments(text) }, sampleSlug: sample?.slug ?? null },
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
    const settings = await setPickSmsEnabled(createServiceClient(), body.enabled, auth.email ?? auth.userId);
    return NextResponse.json({ ok: true, settings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
