import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { resolveClientLocation } from "@/lib/agent-exec";
import { answersFromMainContact } from "@/lib/survey-answers";

// "Set up account" on the Clients tab (admin only).
//   GET  ?owner=&business=  → can this client be set up? (no GHL location yet),
//                             and the Onboarding card that already exists, if any
//   POST {rowNumber?, owner, business} → open (or create) that client's Onboarding
//                             card, pre-filled from the Clients Master row → { id }

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function adminEmail(): Promise<string | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const svc = createServiceClient();
  const { data } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  return (data as { role?: string } | null)?.role === "admin" ? (user.email ?? user.id) : null;
}

async function existingCard(svc: ReturnType<typeof createServiceClient>, owner: string, business: string): Promise<{ id: string; status: string; approved: boolean } | null> {
  const { data } = await svc.from("onboardings").select("id, status, form, setup").order("created_at", { ascending: false });
  const hit = ((data ?? []) as Array<{ id: string; status: string; form: Record<string, string>; setup: unknown }>).find((o) =>
    (norm(o.form?.business_name) && norm(o.form?.business_name) === norm(business)) ||
    (norm(o.form?.owner_name) && norm(o.form?.owner_name) === norm(owner) && !norm(business)));
  return hit ? { id: hit.id, status: hit.status, approved: !!hit.setup } : null;
}

export async function GET(req: NextRequest) {
  const email = await adminEmail();
  if (!email) return NextResponse.json({ eligible: false });
  const owner = String(req.nextUrl.searchParams.get("owner") ?? "").trim();
  const business = String(req.nextUrl.searchParams.get("business") ?? "").trim();
  if (!owner && !business) return NextResponse.json({ eligible: false });
  const svc = createServiceClient();
  const loc = await resolveClientLocation(svc, null, owner).catch(() => null);
  // A returning client (Sally Nails And Spa, 10/15/2026): her name still
  // resolves to the sub-account we wiped into the pool, so she looked like
  // she "had an account". A location in cleanup_log was recycled — it is
  // not hers any more, and she needs a fresh setup like a new client.
  let recycled = false;
  if (loc) {
    const { data: wiped } = await svc.from("cleanup_log").select("pool_name").eq("location_id", loc.locationId).limit(1).maybeSingle();
    recycled = !!wiped;
  }
  const hasLocation = !!loc && !recycled;
  const card = await existingCard(svc, owner, business);
  return NextResponse.json({ eligible: !hasLocation, hasLocation, recycled, locationId: hasLocation ? loc!.locationId : null, card });
}

// Clients Master → New Client form. Only what the sheet knows; the rest is
// typed on the card before Approve.
function prefill(row: Record<string, unknown>): Record<string, string> {
  const g = (k: string) => String(row[k] ?? "").trim();
  const version = (() => {
    const v = g("Version").toLowerCase().replace(/[()\s]/g, "");
    return v.startsWith("v3") ? "(V3)" : v.startsWith("v2") ? "(V2.3)" : v.startsWith("v1") ? "(V1)" : "(V3)";
  })();
  const form: Record<string, string> = {
    business_name: g("Business Name"),
    owner_name: g("Owner Full Name"),
    email: g("Email"),
    phone: g("Phone"),
    address: g("Location (Full adress)"),
    services: g("PMU Services"),
    version,
    assigned: g("Assigned"),
    media_buyer: g("Media Buyer"),
    offer: g("Offer"),
    original_price: g("Original Price"),
    discounted_price: g("Discounted Price"),
    // Hours live in their own column on newer rows, in Notes on older ones
    // (owner 10/25: Elena's card asked for hours the Clients tab already had).
    business_hours: g("Business Hours") || (/\b(am|pm)\b|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(g("Notes")) ? g("Notes") : ""),
    ig_link: g("IG Page link"),
    fb_link: g("FB Page link"),
    gmb_link: g("GMB") || g("GMB_2"),
    // The house deposit — change it on the card if this client differs.
    deposit_amount: "$50",
    master_row: String(row.row_number ?? ""),
    master_contact_id: g("Contact ID"),
  };
  for (const k of Object.keys(form)) if (!form[k]) delete form[k];
  return form;
}

export async function POST(req: NextRequest) {
  const email = await adminEmail();
  if (!email) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { rowNumber?: number; owner?: string; business?: string };
  const owner = String(body.owner ?? "").trim();
  const business = String(body.business ?? "").trim();
  if (!owner && !business) return NextResponse.json({ error: "owner or business required" }, { status: 400 });
  const svc = createServiceClient();

  const card = await existingCard(svc, owner, business);
  if (card) return NextResponse.json({ id: card.id, existing: true });

  const { data: cm } = await svc.from("clients_master").select("sheet_row, data");
  const rows = (cm ?? []) as Array<{ sheet_row: number; data: Record<string, unknown> }>;
  const row = (body.rowNumber ? rows.find((r) => Number(r.sheet_row) === Number(body.rowNumber)) : undefined)
    ?? rows.find((r) => norm(r.data["Business Name"]) === norm(business) && (!owner || norm(r.data["Owner Full Name"]) === norm(owner)))
    ?? rows.find((r) => norm(r.data["Owner Full Name"]) === norm(owner));
  if (!row) return NextResponse.json({ error: "No Clients Master row for this client" }, { status: 404 });

  const form = prefill({ ...row.data, row_number: row.sheet_row });
  if (!form.business_name) form.business_name = business;
  if (!form.owner_name) form.owner_name = owner;
  if (!form.business_name || !form.owner_name) return NextResponse.json({ error: "The sheet row has no business or owner name" }, { status: 400 });
  // What the sheet doesn't have may be on the client's signup contact (hours, years).
  Object.assign(form, await answersFromMainContact(form.master_contact_id ?? "", form).catch(() => ({})));
  const { data, error } = await svc.from("onboardings").insert({ form, created_by: email }).select("id").single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "could not create the card" }, { status: 500 });
  return NextResponse.json({ id: (data as { id: string }).id, existing: false });
}
