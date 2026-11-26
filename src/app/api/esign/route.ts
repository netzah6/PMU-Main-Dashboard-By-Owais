import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import {
  TEMPLATE_IDS, TEMPLATE_FIELDS, TEMPLATE_LABELS, DEFAULT_TEMPLATES, validateFields, renderAgreement, checkTemplate, settingsKey,
  type EsignTemplateId,
} from "@/lib/esign";
import { ESIGN_ROLES, SELECT_LIST, SIGNED_LIST, loadTemplate, newToken, contentHash, cleanText, EMAIL_RE, linkOrigin } from "@/lib/esign-server";

export const dynamic = "force-dynamic";

// The E-Sign tab: templates + the agreements sent for signature. Admins and
// the sales seats (sales / closer / setter). A salesperson can only change
// the NUMBERS — the wording comes from the template on the server, never
// from the browser. Only admins can change the wording.

async function who() {
  const auth = await getAuth();
  return auth && auth.role && ESIGN_ROLES.has(auth.role) ? auth : null;
}

function isTemplate(v: unknown): v is EsignTemplateId {
  return typeof v === "string" && (TEMPLATE_IDS as string[]).includes(v);
}

/** Older signed agreements: rows synced from the "Signed Agreements" sheet
 *  (filled by the Go High Level workflow). Only name + date. */
async function olderSigned(svc: ReturnType<typeof createServiceClient>): Promise<Array<{ name: string; date: string }>> {
  const { data } = await svc.from("signed_agreements").select("data").limit(2000);
  const out: Array<{ name: string; date: string }> = [];
  for (const r of (data ?? []) as Array<{ data: Record<string, unknown> | null }>) {
    const d = r.data ?? {};
    const name = String(d["Full Name"] ?? d["Name"] ?? d["name"] ?? "").trim();
    const date = String(d["Signed Date"] ?? d["Date"] ?? d["date"] ?? "").trim();
    if (name || date) out.push({ name, date });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const auth = await who();
  if (!auth) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const svc = createServiceClient();
  const isAdmin = auth.role === "admin";
  let q = svc.from("agreement_signatures").select(SELECT_LIST).order("created_at", { ascending: false }).limit(200);
  // Admins see every agreement; a salesperson sees the ones they created.
  if (!isAdmin) q = q.eq("created_by", auth.email ?? "-");
  // SIGNED agreements are visible to the whole sales team (owner, 11/26/2026).
  const signedQ = svc.from("agreement_signatures").select(SIGNED_LIST).eq("status", "signed").order("signed_at", { ascending: false }).limit(500);
  const [std, ppa, { data: rows, error }, { data: signed }, older, origin] = await Promise.all([
    loadTemplate(svc, "standard"), loadTemplate(svc, "ppa"), q, signedQ, olderSigned(svc).catch(() => []), linkOrigin(svc, req),
  ]);
  return NextResponse.json({
    role: auth.role,
    email: auth.email,
    linkOrigin: origin,
    signed: signed ?? [],
    older,
    templates: {
      standard: { label: TEMPLATE_LABELS.standard, fields: TEMPLATE_FIELDS.standard, template: std.template, overridden: std.overridden },
      ppa: { label: TEMPLATE_LABELS.ppa, fields: TEMPLATE_FIELDS.ppa, template: ppa.template, overridden: ppa.overridden },
    },
    rows: rows ?? [],
    setupNeeded: error ? /relation|does not exist|schema cache/i.test(error.message) : false,
    error: error?.message ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const auth = await who();
  if (!auth) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const svc = createServiceClient();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");

  if (action === "create") {
    if (!isTemplate(body.template)) return NextResponse.json({ error: "Pick a template" }, { status: 400 });
    const t = body.template;
    const name = cleanText(body.name, 120);
    const email = cleanText(body.email, 200).toLowerCase();
    const phone = cleanText(body.phone, 30);
    if (name.length < 2) return NextResponse.json({ error: "Type the client's full name" }, { status: 400 });
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Type a valid email" }, { status: 400 });
    if (phone && !/^[+\d\s().-]{7,30}$/.test(phone)) return NextResponse.json({ error: "Phone looks wrong" }, { status: 400 });
    const { values, errors } = validateFields(t, (body.fields ?? {}) as Record<string, unknown>);
    if (Object.keys(errors).length) return NextResponse.json({ error: "Some numbers need fixing", fieldErrors: errors }, { status: 400 });
    const { template } = await loadTemplate(svc, t);
    const content = renderAgreement(template, t, values);
    const token = newToken();
    const { data, error } = await svc.from("agreement_signatures").insert({
      token, template: t, fields: values, content, content_sha256: contentHash(content),
      partner_name: name, partner_email: email, partner_phone: phone || null,
      created_by: auth.email, status: "sent",
    }).select(SELECT_LIST).single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, row: data, link: `${await linkOrigin(svc, req)}/sign/${token}` });
  }

  if (action === "void") {
    const id = String(body.id ?? "");
    const { data: row } = await svc.from("agreement_signatures").select("id, status, created_by").eq("id", id).maybeSingle();
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (auth.role !== "admin" && row.created_by !== auth.email) return NextResponse.json({ error: "Only an admin or the person who made it can void it" }, { status: 403 });
    if (row.status === "signed") return NextResponse.json({ error: "Already signed — it can't be voided" }, { status: 409 });
    if (row.status === "void") return NextResponse.json({ success: true });
    const { data, error } = await svc.from("agreement_signatures")
      .update({ status: "void", voided_at: new Date().toISOString(), voided_by: auth.email })
      .eq("id", id).in("status", ["sent", "viewed"]).select(SELECT_LIST).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "It was signed a moment ago — it can't be voided" }, { status: 409 });
    return NextResponse.json({ success: true, row: data });
  }

  // ── Wording: admins only. Placeholders must survive. ──
  if (action === "save_template" || action === "reset_template") {
    if (auth.role !== "admin") return NextResponse.json({ error: "Only admins can change the wording" }, { status: 403 });
    if (!isTemplate(body.template)) return NextResponse.json({ error: "Pick a template" }, { status: 400 });
    const t = body.template;
    if (action === "reset_template") {
      await svc.from("app_settings").delete().eq("key", settingsKey(t));
      return NextResponse.json({ success: true, template: DEFAULT_TEMPLATES[t] });
    }
    const { template, error: bad } = checkTemplate(t, body.agreement);
    if (!template) return NextResponse.json({ error: bad }, { status: 400 });
    const { error } = await svc.from("app_settings").upsert({ key: settingsKey(t), value: template, updated_by: auth.email, updated_at: new Date().toISOString() });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, template });
  }

  return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
}
