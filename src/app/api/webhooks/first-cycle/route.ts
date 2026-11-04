import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { prepareFirstCycle } from "@/lib/first-cycle";

export const maxDuration = 60;

// The agency's "Started stage -> Went live Notification" workflow calls this
// the moment a deal lands in First Cycle, then waits and texts only if the
// login fields are filled (owner, 11/04/2026). No session: it answers yes/no
// with no client data, and only acts on a deal really sitting in First Cycle.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { contact_id?: unknown; contactId?: unknown };
  const contactId = String(body.contact_id ?? body.contactId ?? "").trim();
  if (!/^[A-Za-z0-9]{8,40}$/.test(contactId)) return NextResponse.json({ error: "contact_id missing" }, { status: 400 });
  try {
    return NextResponse.json(await prepareFirstCycle(createServiceClient(), contactId));
  } catch (e) {
    console.error("[first-cycle webhook]", e);
    return NextResponse.json({ ok: false, error: "could not prepare the logins" }, { status: 502 });
  }
}
