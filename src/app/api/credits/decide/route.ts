import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// Admin-only: approve or deny a credit request. Approving does not move money
// by itself — the balance is subtracted from the client's next service-fee
// charge and drawn down as it is used.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can approve credits" }, { status: 403 });
  }

  const { id, decision } = (await req.json().catch(() => ({}))) as { id?: string; decision?: string };
  if (!id || (decision !== "approve" && decision !== "deny")) {
    return NextResponse.json({ error: "id and decision (approve|deny) required" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: row } = await svc.from("client_credits").select("*").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Credit not found" }, { status: 404 });
  if (row.status !== "pending") {
    return NextResponse.json({ error: `This credit was already ${row.status}.` }, { status: 409 });
  }

  const { error } = await svc
    .from("client_credits")
    .update({
      status: decision === "approve" ? "approved" : "denied",
      decided_by: auth.email,
      decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
