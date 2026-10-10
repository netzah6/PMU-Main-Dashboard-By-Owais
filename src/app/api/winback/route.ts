import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getReplyAccount, getRecentConversations, channelFromType, type ConvSummary } from "@/lib/ghl-conversations";
import { GHL_BASE } from "@/lib/ghl-tasks";
import { WINBACK_TAG, type WinbackRow } from "@/lib/winback";

export const maxDuration = 60;

// 🔁 Win-back list for the AI tab (admin only): the sheet's "Follow Up" people
// with their live chat state. ?contactId=… resolves one person's conversation
// (for someone whose chat isn't among the most recent ones).
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 });

  const one = req.nextUrl.searchParams.get("contactId");
  if (one) return NextResponse.json({ conversation: await conversationFor(acct, one) });

  const svc = createServiceClient();
  const { data, error } = await svc.from("winback_contacts").select("*").eq("active", true).order("sheet_row");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as WinbackRow[];

  // Recent chats in the account (any read state) → each person's latest message.
  const recent = await getRecentConversations(acct, 100);
  const byContact = new Map(recent.filter((c) => c.contactId).map((c) => [c.contactId!, c]));

  return NextResponse.json({
    tag: WINBACK_TAG,
    locationId: acct.locationId,
    people: rows.map((r) => ({
      sheetRow: r.sheet_row, ownerName: r.owner_name, business: r.business, lastPaid: r.last_paid,
      offer: r.offer, outcome: r.outcome, contactId: r.contact_id, matchNote: r.match_note, tagged: !!r.tagged_at,
      review: r.reviewed_at ? { verdict: r.review_verdict, note: r.review_note, quote: r.review_quote } : null,
      conv: r.contact_id ? byContact.get(r.contact_id) ?? null : null,
    })),
  });
}

// Mark someone won / lost (or clear it). The offer itself comes from the sheet.
export async function PATCH(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { sheetRow?: number; outcome?: string | null };
  const outcome = body.outcome === "won" || body.outcome === "lost" ? body.outcome : null;
  if (!Number.isInteger(body.sheetRow)) return NextResponse.json({ error: "sheetRow required" }, { status: 400 });
  const svc = createServiceClient();
  const { error } = await svc.from("winback_contacts").update({ outcome }).eq("sheet_row", body.sheetRow!);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

async function conversationFor(acct: { locationId: string; token: string }, contactId: string): Promise<ConvSummary | null> {
  const r = await fetch(`${GHL_BASE}/conversations/search?locationId=${acct.locationId}&contactId=${encodeURIComponent(contactId)}&limit=1`, {
    headers: { Authorization: `Bearer ${acct.token}`, Version: "2021-04-15", Accept: "application/json" },
  });
  if (!r.ok) return null;
  const c = ((await r.json()) as { conversations?: Array<Record<string, unknown>> }).conversations?.[0];
  if (!c) return null;
  return {
    id: String(c.id),
    contactId,
    contactName: String(c.fullName ?? c.contactName ?? "").trim() || "Unknown",
    lastMessageBody: String(c.lastMessageBody ?? "").trim(),
    lastMessageDirection: (c.lastMessageDirection as string) ?? null,
    lastMessageDate: c.lastMessageDate != null ? new Date(Number(c.lastMessageDate)).toISOString() : null,
    unreadCount: typeof c.unreadCount === "number" ? (c.unreadCount as number) : 0,
    channel: channelFromType(c.lastMessageType as string | undefined),
    assignedTo: (c.assignedTo as string) ?? null,
    assignedToName: "",
  };
}
