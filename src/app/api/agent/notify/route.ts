import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getReplyAccount, sendConversationMessage } from "@/lib/ghl-conversations";
import { getNotifySettings, saveNotifySettings, proposalLink } from "@/lib/agent-notify";

// Owner notification settings for the CEO Agent — admin only.
//   GET            → current settings (phone, enabled)
//   POST {phone}   → save: upserts the owner as a contact in the main account
//                    (that is who the SMS goes to) and stores the contact id
//   POST {enabled} → pause / resume without losing the number
//   POST {test:1}  → send a test text right now
const GHL = "https://services.leadconnectorhq.com";

async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const svc = createServiceClient();
  const { data: roleRow } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if ((roleRow as { role?: string } | null)?.role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 }) };
  }
  return { user, svc };
}

export async function GET() {
  const a = await requireAdmin();
  if ("error" in a) return a.error;
  const s = await getNotifySettings(a.svc);
  return NextResponse.json({ settings: s ? { enabled: s.enabled, phone: s.phone, updatedAt: s.updatedAt } : null });
}

export async function POST(req: NextRequest) {
  const a = await requireAdmin();
  if ("error" in a) return a.error;
  const { user, svc } = a;
  const body = (await req.json().catch(() => ({}))) as { phone?: string; enabled?: boolean; test?: boolean };
  const by = user.email ?? user.id;

  if (body.test) {
    const s = await getNotifySettings(svc);
    if (!s) return NextResponse.json({ error: "Save a phone number first" }, { status: 400 });
    const acct = await getReplyAccount();
    if (!acct) return NextResponse.json({ error: "Main account token unavailable" }, { status: 500 });
    const r = await sendConversationMessage(acct, {
      contactId: s.contactId, channel: "SMS",
      message: `Test from the PMU dashboard: this is where client requests will arrive. Example link: ${proposalLink("test")}`,
    });
    if (!r.ok) return NextResponse.json({ error: `Send failed: ${r.error}` }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  if (typeof body.enabled === "boolean" && !body.phone) {
    const s = await getNotifySettings(svc);
    if (!s) return NextResponse.json({ error: "Save a phone number first" }, { status: 400 });
    await saveNotifySettings(svc, { ...s, enabled: body.enabled }, by);
    return NextResponse.json({ success: true, settings: { enabled: body.enabled, phone: s.phone } });
  }

  const digits = String(body.phone ?? "").replace(/[^\d+]/g, "");
  const phone = digits.startsWith("+") ? digits : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : "";
  if (!/^\+\d{10,15}$/.test(phone)) return NextResponse.json({ error: "Enter a full mobile number, e.g. 213-555-0100" }, { status: 400 });

  // The text goes out through the main account's conversations API, which
  // needs a contact — so the owner becomes (or already is) a contact there.
  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "Main account token unavailable" }, { status: 500 });
  const first = (user.email ?? "Owner").split("@")[0];
  const r = await fetch(`${GHL}/contacts/upsert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${acct.token}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ locationId: acct.locationId, phone, email: user.email ?? undefined, firstName: first, tags: ["dashboard-owner"] }),
  });
  const j = (await r.json().catch(() => ({}))) as { contact?: { id?: string }; message?: string };
  const contactId = j.contact?.id;
  if (!r.ok || !contactId) return NextResponse.json({ error: `Could not save the number in GHL: ${j.message ?? `HTTP ${r.status}`}` }, { status: 500 });

  await saveNotifySettings(svc, { enabled: true, phone, contactId, email: user.email ?? undefined }, by);
  return NextResponse.json({ success: true, settings: { enabled: true, phone } });
}
