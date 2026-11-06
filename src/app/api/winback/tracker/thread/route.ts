import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getReplyAccount, getThread } from "@/lib/ghl-conversations";
import { GHL_BASE } from "@/lib/ghl-tasks";

export const maxDuration = 60;

// The latest messages with one win-back person (admin only, read-only), for
// the tracker's "click a row to see what she got".
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const contactId = req.nextUrl.searchParams.get("contactId");
  if (!contactId) return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 });
  const r = await fetch(`${GHL_BASE}/conversations/search?locationId=${acct.locationId}&contactId=${encodeURIComponent(contactId)}&limit=1`, {
    headers: { Authorization: `Bearer ${acct.token}`, Version: "2021-04-15", Accept: "application/json" },
  });
  if (!r.ok) return NextResponse.json({ error: `Couldn't read her chat (GHL ${r.status})` }, { status: 502 });
  const conv = ((await r.json()) as { conversations?: Array<{ id?: string }> }).conversations?.[0];
  if (!conv?.id) return NextResponse.json({ messages: [] });
  const all = await getThread(acct, String(conv.id), { labelMedia: true });
  return NextResponse.json({
    messages: all.slice(-12).map((m) => ({ id: m.id, fromHer: m.direction === "inbound", body: (m.channel === "Email" ? m.body.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() : m.body).slice(0, 1200), at: m.dateAdded, channel: m.channel })),
    total: all.length,
  });
}
