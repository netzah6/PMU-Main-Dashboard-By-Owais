import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// Chat-detected bookings awaiting review (GET), and the review decisions
// (POST dismiss / mark-billed). Billing itself goes through /api/ppa/charge
// with appt_id 'chat:<conversation_id>' — this route only tracks the flag.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const [{ data: flags }, { data: lastScan }] = await Promise.all([
    svc.from("ppa_chat_flags")
      .select("conversation_id, owner_key, location_id, contact_id, contact_name, detected_when, evidence, last_message_at")
      .eq("verdict", "booked").eq("dismissed", false).eq("billed", false)
      .order("last_message_at", { ascending: false }),
    svc.from("ppa_chat_flags").select("scanned_at").order("scanned_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return NextResponse.json({ flags: flags ?? [], lastScanAt: lastScan?.scanned_at ?? null });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { conversation_id?: string; action?: string };
  const id = String(body.conversation_id ?? "").trim();
  const action = String(body.action ?? "");
  if (!id || !["dismiss", "billed", "restore"].includes(action)) {
    return NextResponse.json({ error: "conversation_id and action (dismiss|billed|restore) required" }, { status: 400 });
  }
  const svc = createServiceClient();
  const patch = action === "dismiss" ? { dismissed: true } : action === "billed" ? { billed: true } : { dismissed: false, billed: false };
  const { error } = await svc.from("ppa_chat_flags").update(patch).eq("conversation_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
