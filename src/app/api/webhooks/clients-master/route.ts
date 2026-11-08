import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { addNewClient, INTAKE_VERSIONS, recordLaunchCall, type IntakeVersion } from "@/lib/clients-master-intake";

export const maxDuration = 60;

// Called by two agency workflows (owner, 11/08/2026) instead of their Google
// Sheets steps:
//   ?event=new&version=V3   "Onboarding survey -> Webhook -> Welcome CEO." (one per branch)
//   ?event=launch           "Update Launch Call Data - Master Google Sheet"
// Body: { contact_id }. No session: the caller only names a contact; every
// value is read from GHL, and a contact already in the dashboard is never added twice.
export async function POST(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const body = (await req.json().catch(() => ({}))) as { contact_id?: unknown; contactId?: unknown };
  const contactId = String(body.contact_id ?? body.contactId ?? q.get("contact_id") ?? "").trim();
  if (!/^[A-Za-z0-9]{8,40}$/.test(contactId)) return NextResponse.json({ error: "contact_id missing" }, { status: 400 });
  const event = q.get("event");
  try {
    const svc = createServiceClient();
    if (event === "new") {
      const version = q.get("version") as IntakeVersion;
      if (!INTAKE_VERSIONS.includes(version)) return NextResponse.json({ error: "version must be V2.3, V1 or V3" }, { status: 400 });
      return NextResponse.json(await addNewClient(svc, contactId, version));
    }
    if (event === "launch") return NextResponse.json(await recordLaunchCall(svc, contactId));
    return NextResponse.json({ error: "event must be new or launch" }, { status: 400 });
  } catch (e) {
    console.error("[clients-master webhook]", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 502 });
  }
}
