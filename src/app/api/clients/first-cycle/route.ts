import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { agencyHeaders, moveDealToFirstCycle, saveLoginFieldsRaw } from "@/lib/first-cycle";

// "Move to First Cycle" from the Clients tab (owner, 2026-10-27): the status
// change to Live offers a checkbox; ticking it saves the login email, password
// and funnel URL on the agency contact FIRST, then moves the deal, so the
// Went-live welcome texts never go out half-empty again (Rosell Torres).
// Admin only.

async function admin() {
  const auth = await getAuth();
  return auth && auth.role === "admin" ? auth : null;
}

/* Prefill: whatever the setup run already knows about this client. */
export async function GET(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const contactId = req.nextUrl.searchParams.get("contactId") ?? "";
  const email = (req.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase();
  const business = (req.nextUrl.searchParams.get("business") ?? "").trim();
  const svc = createServiceClient();
  const { data } = await svc.from("onboardings").select("form, setup").order("created_at", { ascending: false }).limit(400);
  type Row = { form: Record<string, string>; setup: { password?: string; funnel_url?: string } | null };
  const rows = (data ?? []) as Row[];
  const hit = rows.find((r) => contactId && String(r.form?.master_contact_id ?? "") === contactId)
    ?? rows.find((r) => email && String(r.form?.email ?? "").trim().toLowerCase() === email);
  let funnelUrl = String(hit?.setup?.funnel_url ?? "");
  if (!funnelUrl && business) {
    const { data: ob } = await svc.from("onebox_clients").select("slug, client_name").neq("slug", "demo-v3");
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const m = (ob ?? []).find((o) => norm(String(o.client_name ?? "")) === norm(business));
    if (m) funnelUrl = `https://book.pmu-care.com/f/${m.slug}`;
  }
  return NextResponse.json({
    email: String(hit?.form?.email ?? email ?? ""),
    password: String(hit?.setup?.password ?? ""),
    funnelUrl,
    fromSetup: !!hit,
  });
}

export async function POST(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const contactId = String(body.contactId ?? "").trim();
  const email = String(body.email ?? "").trim();
  const password = String(body.password ?? "").trim();
  const funnelUrl = String(body.funnelUrl ?? "").trim();
  const businessName = String(body.businessName ?? "").trim() || undefined;
  if (!contactId) return NextResponse.json({ error: "This client has no Contact ID on the Clients Master row — add it first" }, { status: 400 });
  const missing = [!email && "login email", !password && "password", !funnelUrl && "funnel link"].filter(Boolean);
  if (missing.length) return NextResponse.json({ error: `Fill the ${missing.join(", ")} first — the welcome texts would go out blank` }, { status: 400 });
  if (!/^https?:\/\//i.test(funnelUrl)) return NextResponse.json({ error: "The funnel link must start with https://" }, { status: 400 });
  const a = await agencyHeaders();
  if ("error" in a) return NextResponse.json({ error: a.error }, { status: 502 });
  try {
    await saveLoginFieldsRaw({ email, password, funnelUrl, businessName }, contactId, a.H);
  } catch (e) {
    return NextResponse.json({ error: `Logins not saved on the GHL contact — ${e instanceof Error ? e.message : String(e)}. Nothing was moved.` }, { status: 502 });
  }
  const mv = await moveDealToFirstCycle(contactId, a.H);
  if (!mv.ok) return NextResponse.json({ error: `Logins saved, but ${mv.note}` }, { status: mv.warn ? 409 : 502 });
  return NextResponse.json({ success: true, already: mv.already, deal: mv.deal, stage: mv.stage });
}
