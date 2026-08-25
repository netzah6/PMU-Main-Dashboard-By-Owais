import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getPpaRoster } from "@/lib/ppa";
import {
  listAllCustomers,
  listCards,
  listRecentPayments,
  searchCustomersByEmail,
  searchCustomersByPhone,
  squareConfigured,
} from "@/lib/square";

export const maxDuration = 120;

// Read-only diagnostic (CRON_SECRET-gated): for one PPS client, dump exactly
// what the card matcher can see — the bulk-list stats, every candidate Square
// profile found by email/phone/name, and every card on each. Exists because
// "the dashboard says no usable card but Square shows one" can only be
// settled by looking at the raw API responses from inside Vercel, where the
// Square token lives.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!squareConfigured()) return NextResponse.json({ error: "Square not configured" }, { status: 503 });

  const ownerKey = (req.nextUrl.searchParams.get("owner_key") ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  const { clients } = await getPpaRoster();
  const client = clients.find((c) => c.ownerKey === ownerKey);
  if (!client) return NextResponse.json({ error: "not on the PPS roster" }, { status: 404 });

  const svc = createServiceClient();
  const { data: masterRows } = await svc.from("clients_master").select("data");
  let email: string | null = null, phone: string | null = null;
  for (const r of (masterRows ?? []) as Array<{ data: Record<string, unknown> }>) {
    if (String(r.data?.["Owner Full Name"] ?? "").trim().toLowerCase() !== ownerKey) continue;
    email = String(r.data?.["Email"] ?? "").trim().toLowerCase() || null;
    phone = String(r.data?.["Phone"] ?? "").trim() || null;
    break;
  }

  const { customers, truncated } = await listAllCustomers();
  const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const wantName = norm(client.ownerName);
  const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);

  const candidates = new Map<string, { source: string; profile: Record<string, unknown> }>();
  const add = (source: string, list: Array<{ id: string; name: string; email: string | null; phone?: string | null; company?: string | null; createdAt?: string | null }>) => {
    for (const c of list) if (!candidates.has(c.id)) candidates.set(c.id, { source, profile: c as unknown as Record<string, unknown> });
  };

  add("bulk-list email", customers.filter((x) => email && String(x.email ?? "").toLowerCase() === email));
  add("bulk-list phone", customers.filter((x) => phone && digits(x.phone) === digits(phone)));
  add("bulk-list name", customers.filter((x) => norm(x.name) === wantName));
  if (email) add("search email", await searchCustomersByEmail(email).catch(() => []));
  if (phone) add("search phone", await searchCustomersByPhone(phone).catch(() => []));

  const out = [];
  for (const [id, { source, profile }] of candidates) {
    const cards = await listCards(id).catch((e) => `cards error: ${e instanceof Error ? e.message : "?"}`);
    out.push({
      profileId: id,
      foundVia: source,
      profile,
      cards: Array.isArray(cards)
        ? cards.map((k) => ({ brand: k.brand, last4: k.last4, exp: `${k.expMonth}/${k.expYear}`, enabled: k.enabled }))
        : cards,
    });
  }

  // Recent Square payments on any of this client's profiles — for reconciling
  // "charged directly in Square" against the dashboard's charge records
  // before Monday bills anyone twice.
  const days = Math.min(Number(req.nextUrl.searchParams.get("payment_days") ?? 14) || 14, 90);
  const since = Date.now() - days * 24 * 3600 * 1000;
  const ids = new Set(candidates.keys());
  const recentPayments = (await listRecentPayments().catch(() => []))
    .filter((p) => p.customerId && ids.has(p.customerId) && new Date(p.createdAt).getTime() >= since)
    .map((p) => ({ paymentId: p.id, profileId: p.customerId, amount: p.amountCents / 100, at: p.createdAt, note: p.note }));

  return NextResponse.json({
    ownerKey,
    sheet: { email, phone, name: client.ownerName, business: client.business },
    bulkList: { size: customers.length, truncated },
    candidates: out,
    recentPayments,
  });
}
