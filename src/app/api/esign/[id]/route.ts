import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { ESIGN_ROLES, getPrivate, linkOrigin } from "@/lib/esign-server";

export const dynamic = "force-dynamic";

// One sent agreement for the E-Sign tab: details (?) or the signed PDF
// (?pdf=1). Admins see any; a salesperson the ones they created, plus every
// SIGNED one (the whole team sees signed agreements — owner, 11/26/2026).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getAuth();
  if (!auth || !auth.role || !ESIGN_ROLES.has(auth.role)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const svc = createServiceClient();
  const { data: row } = await svc.from("agreement_signatures")
    .select("id, token, template, fields, content, content_sha256, partner_name, partner_email, partner_phone, created_by, created_at, status, viewed_at, view_ip, signed_at, signer_name, signer_email, signer_ip, signer_location, signer_user_agent, signature_method, signed_pdf_path, signed_pdf_sha256, voided_at, voided_by, ghl_contact_id, ghl_note")
    .eq("id", params.id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const mine = auth.role === "admin" || row.created_by === auth.email;
  if (!mine && row.status !== "signed") return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (req.nextUrl.searchParams.get("pdf")) {
    if (!row.signed_pdf_path) return NextResponse.json({ error: "Not signed yet" }, { status: 409 });
    const buf = await getPrivate(svc, row.signed_pdf_path);
    if (!buf) return NextResponse.json({ error: "Signed copy not found in storage" }, { status: 500 });
    const who = String(row.signer_name || row.partner_name || "client").replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="PMU-Agreement-${who}-signed.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const { token, ...rest } = row;
  if (!mine) {
    // Someone else's signed agreement: the basics only, no link.
    const basic = {
      id: rest.id, template: rest.template, fields: rest.fields, partner_name: rest.partner_name, partner_email: rest.partner_email,
      created_by: rest.created_by, created_at: rest.created_at, status: rest.status, signed_at: rest.signed_at, signer_name: rest.signer_name,
    };
    return NextResponse.json({ row: basic, link: null }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ row: rest, link: `${await linkOrigin(svc, req)}/sign/${token}` }, { headers: { "Cache-Control": "no-store" } });
}
