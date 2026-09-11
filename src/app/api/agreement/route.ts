import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { STANDARD_AGREEMENT, parseAgreement, type Agreement } from "@/lib/agreement";

// The Agreement tab's data: the standard template (app_settings) and the
// agreements generated from it. Admin only — the text carries pricing terms.

const KEY = "agreement_template";

async function admin() {
  const auth = await getAuth();
  return auth && auth.role === "admin" ? auth : null;
}

async function loadTemplate(svc: ReturnType<typeof createServiceClient>): Promise<Agreement> {
  const { data } = await svc.from("app_settings").select("value").eq("key", KEY).maybeSingle();
  return parseAgreement(data?.value) ?? STANDARD_AGREEMENT;
}

export async function GET() {
  const auth = await admin();
  if (!auth) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const svc = createServiceClient();
  const [template, { data: saved }] = await Promise.all([
    loadTemplate(svc),
    svc.from("agreements").select("id, partner_name, changes, created_by, created_at").order("created_at", { ascending: false }).limit(50),
  ]);
  return NextResponse.json({ template, saved: saved ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await admin();
  if (!auth) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const svc = createServiceClient();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");

  if (action === "save_template") {
    const a = parseAgreement(body.agreement);
    if (!a) return NextResponse.json({ error: "That is not a valid agreement" }, { status: 400 });
    const { error } = await svc.from("app_settings").upsert({
      key: KEY, value: a, updated_by: auth.email, updated_at: new Date().toISOString(),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  if (action === "reset_template") {
    await svc.from("app_settings").delete().eq("key", KEY);
    return NextResponse.json({ success: true, template: STANDARD_AGREEMENT });
  }

  if (action === "save_agreement") {
    const a = parseAgreement(body.agreement);
    if (!a) return NextResponse.json({ error: "That is not a valid agreement" }, { status: 400 });
    const { data, error } = await svc.from("agreements").insert({
      partner_name: String(body.partnerName ?? "") || null,
      content: a,
      changes: String(body.changes ?? "") || null,
      created_by: auth.email,
    }).select("id, created_at").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, id: data.id, createdAt: data.created_at });
  }

  if (action === "load_agreement") {
    const { data } = await svc.from("agreements").select("*").eq("id", String(body.id ?? "")).maybeSingle();
    if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ agreement: parseAgreement(data.content), partnerName: data.partner_name, changes: data.changes });
  }

  return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
}
