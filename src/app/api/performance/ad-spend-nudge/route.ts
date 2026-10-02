import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getReplyAccount, sendConversationMessage } from "@/lib/ghl-conversations";
import { GHL_BASE, GHL_VERSION } from "@/lib/ghl-tasks";

export const maxDuration = 30;

/* "Ask the bank to approve the ad spend" (owner, 2026-10-02). On the
   Performance tab, an UNSETTLED ad account gets a button that texts the
   client from PMU Bookings On Demand — from the clicking teammate's own
   number there when they have one:
     "Hey {{contact.first_name}}! Can you ask your bank to approve the Facebook ad spent?"
   GET  ?sheetRow=N → preview (who, from which number, the exact text)
   POST { sheetRow } → sends it and logs it (ad_spend_nudges).
   The client is the Clients Master row's "Contact ID" in PMU Bookings On
   Demand, checked against the row's email/phone before anything is sent. */

const ALLOWED = new Set(["admin", "editor", "media_buyer"]);
const text = (first: string) => `Hey ${first}! Can you ask your bank to approve the Facebook ad spent?`;
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();

type Contact = { id: string; firstName?: string; lastName?: string; email?: string; phone?: string; dnd?: boolean; locationId?: string };
type Plan = {
  ownerKey: string; sheetRow: number; contact: Contact; firstName: string;
  fromNumber: string | null; fromLabel: string; message: string; lastAskedAt: string | null;
};

async function plan(sheetRow: number, email: string | null): Promise<Plan | { error: string; status: number }> {
  const svc = createServiceClient();
  const [{ data: row }, { data: perf }] = await Promise.all([
    svc.from("clients_master").select("data").eq("sheet_row", sheetRow).maybeSingle(),
    svc.from("performance_overview").select("campaign_status").eq("sheet_row", sheetRow).maybeSingle(),
  ]);
  const d = ((row as { data?: Record<string, unknown> } | null)?.data ?? null);
  if (!d) return { error: "Client row not found", status: 404 };
  if (!/unsettled/i.test(String((perf as { campaign_status?: string } | null)?.campaign_status ?? ""))) {
    return { error: "This ad account isn't UNSETTLED anymore — nothing to ask", status: 409 };
  }
  const owner = String(d["Owner Full Name"] ?? "").trim();
  const ownerKey = owner.toLowerCase();

  const acct = await getReplyAccount();
  if (!acct) return { error: "PMU Bookings On Demand token not found", status: 503 };
  const H = { Authorization: `Bearer ${acct.token}`, Version: GHL_VERSION, Accept: "application/json" };

  /* The sheet's Contact ID, accepted only if the GHL contact really is this
     client (same email or phone) — a stale or recycled id must never text
     someone else. Otherwise look the client up by email, then phone. */
  const wantEmail = lower(d["Email"]);
  const wantPhone = digits(d["Phone"]);
  const isClient = (c: Contact | null) => !!c && (
    (!!wantEmail && lower(c.email) === wantEmail) || (!!wantPhone && digits(c.phone) === wantPhone));
  let contact: Contact | null = null;
  const cid = String(d["Contact ID"] ?? "").trim();
  if (cid) {
    const r = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(cid)}`, { headers: H });
    const c = r.ok ? ((await r.json()) as { contact?: Contact }).contact ?? null : null;
    if (c && c.locationId === acct.locationId && isClient(c)) contact = c;
  }
  // GHL looks numbers up in E.164 (+1… for the US numbers the sheet holds).
  const e164 = wantPhone.length === 10 ? `+1${wantPhone}` : wantPhone;
  for (const [key, val] of [["email", wantEmail], ["number", e164]] as const) {
    if (contact || !val) continue;
    const r = await fetch(`${GHL_BASE}/contacts/search/duplicate?locationId=${acct.locationId}&${key}=${encodeURIComponent(val)}`, { headers: H });
    const c = r.ok ? ((await r.json()) as { contact?: Contact | null }).contact ?? null : null;
    if (isClient(c)) contact = c;
  }
  if (!contact) return { error: `Couldn't find ${owner || "this client"} in PMU Bookings On Demand by their email/phone — text them from GHL`, status: 404 };
  if (!contact.phone) return { error: `${owner} has no phone number in PMU Bookings On Demand`, status: 422 };
  if (contact.dnd) return { error: `${owner} is on Do Not Disturb in PMU Bookings On Demand — not texting`, status: 422 };

  // The teammate's own number in this account (GHL user lcPhone), else the
  // account's default line.
  let fromNumber: string | null = null;
  let fromLabel = "PMU Bookings On Demand's main number (your login has no number there)";
  const me = lower(email);
  try {
    const ur = await fetch(`${GHL_BASE}/users/?locationId=${acct.locationId}`, { headers: H });
    const users = ur.ok ? ((await ur.json()) as { users?: Array<Record<string, unknown>> }).users ?? [] : [];
    const u = users.find((x) => lower(x.email) === me);
    const n = u ? String(((u.lcPhone ?? {}) as Record<string, unknown>)[acct.locationId] ?? "").trim() : "";
    if (n) {
      fromNumber = n;
      fromLabel = `your number (${String(u?.name ?? `${u?.firstName ?? ""} ${u?.lastName ?? ""}`).trim() || "you"}, …${digits(n).slice(-4)})`;
    } else if (u) {
      fromLabel = "PMU Bookings On Demand's main number (no phone number on your GHL user)";
    }
  } catch { /* default line */ }

  const firstName = String(contact.firstName ?? "").trim() || owner.split(/\s+/)[0] || "there";
  const { data: last } = await svc.from("ad_spend_nudges").select("sent_at")
    .eq("owner_key", ownerKey).order("sent_at", { ascending: false }).limit(1).maybeSingle();
  return {
    ownerKey, sheetRow, contact, firstName, fromNumber, fromLabel, message: text(firstName),
    lastAskedAt: (last as { sent_at?: string } | null)?.sent_at ?? null,
  };
}

async function guard() {
  const auth = await getAuth();
  if (!auth) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!ALLOWED.has(auth.role ?? "")) return { error: NextResponse.json({ error: "Not allowed" }, { status: 403 }) };
  return { auth };
}

export async function GET(req: NextRequest) {
  const g = await guard();
  if ("error" in g) return g.error;
  // ?recent=1 → when each client was last asked (last 30 days), for the rows.
  if (req.nextUrl.searchParams.get("recent")) {
    const { data } = await createServiceClient().from("ad_spend_nudges").select("owner_key, sent_at")
      .gte("sent_at", new Date(Date.now() - 30 * 86_400_000).toISOString()).order("sent_at", { ascending: false });
    const last: Record<string, string> = {};
    for (const r of (data ?? []) as Array<{ owner_key: string; sent_at: string }>) last[r.owner_key] ??= r.sent_at;
    return NextResponse.json({ last });
  }
  const sheetRow = Number(req.nextUrl.searchParams.get("sheetRow"));
  if (!Number.isInteger(sheetRow) || sheetRow <= 0) return NextResponse.json({ error: "sheetRow required" }, { status: 400 });
  const p = await plan(sheetRow, g.auth.email);
  if ("error" in p) return NextResponse.json({ error: p.error }, { status: p.status });
  return NextResponse.json({
    to: `${[p.contact.firstName, p.contact.lastName].filter(Boolean).join(" ")} (…${digits(p.contact.phone).slice(-4)})`,
    from: p.fromLabel, message: p.message, lastAskedAt: p.lastAskedAt,
    // Sent back with the POST: the text goes to exactly who was confirmed.
    contactId: p.contact.id, ownerKey: p.ownerKey,
  });
}

export async function POST(req: NextRequest) {
  const g = await guard();
  if ("error" in g) return g.error;
  const body = (await req.json().catch(() => ({}))) as { sheetRow?: number; contactId?: string; ownerKey?: string };
  const sheetRow = Number(body.sheetRow);
  if (!Number.isInteger(sheetRow) || sheetRow <= 0) return NextResponse.json({ error: "sheetRow required" }, { status: 400 });
  const p = await plan(sheetRow, g.auth.email);
  if ("error" in p) return NextResponse.json({ error: p.error }, { status: p.status });
  /* The sheet row is only a line number — rows shift when the sheet is
     edited. Send only to the contact the confirm named. */
  if (!body.contactId || body.contactId !== p.contact.id || body.ownerKey !== p.ownerKey) {
    return NextResponse.json({ error: "The client list changed since you opened this — refresh and try again (nothing sent)" }, { status: 409 });
  }
  // A double click (or two teammates at once) must not text the client
  // twice: log first, and only the earliest log in the last 5 minutes sends.
  const svc = createServiceClient();
  const windowStart = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: mine, error: logErr } = await svc.from("ad_spend_nudges").insert({
    sheet_row: sheetRow, owner_key: p.ownerKey, contact_id: p.contact.id, message: p.message,
    from_number: p.fromNumber, sent_by: g.auth.email ?? g.auth.userId,
  }).select("id, sent_at").single();
  if (logErr || !mine) return NextResponse.json({ error: "Couldn't log the send — nothing sent" }, { status: 500 });
  const { data: recent } = await svc.from("ad_spend_nudges").select("id, sent_at")
    .eq("owner_key", p.ownerKey).gte("sent_at", windowStart)
    .order("sent_at", { ascending: true }).order("id", { ascending: true }).limit(1);
  if ((recent?.[0] as { id?: string } | undefined)?.id !== mine.id) {
    await svc.from("ad_spend_nudges").delete().eq("id", mine.id);
    return NextResponse.json({ error: "Someone sent (or is sending) this in the last 5 minutes — check the chat before sending again" }, { status: 409 });
  }
  const acct = await getReplyAccount();
  const r = acct
    ? await sendConversationMessage(acct, { contactId: p.contact.id, message: p.message, channel: "SMS", fromNumber: p.fromNumber })
    : { ok: false, error: "PMU Bookings On Demand token not found" };
  if (!r.ok) {
    await svc.from("ad_spend_nudges").delete().eq("id", mine.id); // not sent — don't say it was
    return NextResponse.json({ error: `Send failed: ${r.error}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, sentAt: mine.sent_at });
}
