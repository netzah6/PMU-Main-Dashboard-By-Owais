import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { TOKEN_RE, rateLimited, clientIp, getPrivate, noStoreHeaders } from "@/lib/esign-server";

export const dynamic = "force-dynamic";

// The client's own signed copy, by the same secret link. Only after signing.
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  if (rateLimited(`pdf:${clientIp(req)}`, 30, 60_000)) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: noStoreHeaders() });
  if (!TOKEN_RE.test(params.token)) return NextResponse.json({ error: "Not found" }, { status: 404, headers: noStoreHeaders() });
  const svc = createServiceClient();
  const { data: row } = await svc.from("agreement_signatures").select("status, signed_pdf_path").eq("token", params.token).maybeSingle();
  if (!row || row.status !== "signed" || !row.signed_pdf_path) return NextResponse.json({ error: "Not found" }, { status: 404, headers: noStoreHeaders() });
  const buf = await getPrivate(svc, row.signed_pdf_path);
  if (!buf) return NextResponse.json({ error: "Not found" }, { status: 404, headers: noStoreHeaders() });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      ...noStoreHeaders(),
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="PMU-Bookings-On-Demand-Scope-of-Service-signed.pdf"`,
    },
  });
}
