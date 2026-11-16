import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { dialerSmsOf, removeFromWorkflow } from "@/lib/power-dialer";
import { autopilotUser } from "@/lib/power-dialer-autopilot";
import { DIALER_SETTINGS_KEY, type DialerSettings } from "@/lib/power-dialer-seat";

export const dynamic = "force-dynamic";

/* Called by the Autopilot helper from inside GHL (signed key, no cookie).
   op "stop": the rep says "we talked" → take the lead out of EVERY Power
     Dialer workflow (an admin can send a list to another rep's dialer), so
     the second call and the no-answer text never happen.
   op "text": return the no-answer text we wrote for this lead; the helper
     presses Send only when GHL's text box holds exactly that text. */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { key?: string; contactId?: string; op?: string };
  const userId = autopilotUser(body.key ?? "");
  const contactId = String(body.contactId ?? "");
  if (!userId) return NextResponse.json({ ok: false, error: "bad key" }, { status: 401, headers: CORS });
  if (!/^[A-Za-z0-9]{10,40}$/.test(contactId)) return NextResponse.json({ ok: false, error: "bad contact" }, { status: 400, headers: CORS });
  try {
    if (body.op === "text") return NextResponse.json({ ok: true, text: await dialerSmsOf(contactId) }, { headers: CORS });
    const { data: st } = await createServiceClient().from("app_settings").select("value").eq("key", DIALER_SETTINGS_KEY).maybeSingle();
    const wfs = [...new Set(Object.values(((st?.value ?? {}) as DialerSettings).workflows ?? {}))];
    if (!wfs.length) return NextResponse.json({ ok: false, error: "no dialer workflows set up" }, { status: 400, headers: CORS });
    // Removing a contact that is not in a workflow is a no-op in GHL, so
    // every workflow must answer OK before we tell the rep the lead is stopped.
    const res = await Promise.all(wfs.map((wf) => removeFromWorkflow(wf, contactId)));
    const bad = res.filter((r) => !r.ok);
    return NextResponse.json({ ok: !bad.length, error: bad[0]?.error }, { status: bad.length ? 502 : 200, headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 502, headers: CORS });
  }
}
