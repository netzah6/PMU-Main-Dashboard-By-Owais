import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// Mark one appointment (deposit) charged / not-charged. The tracker.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    appt_id?: string; owner_key?: string; charged?: boolean; amount?: number; note?: string;
  };
  const apptId = String(body.appt_id ?? "").trim();
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!apptId || !ownerKey) return NextResponse.json({ error: "appt_id and owner_key required" }, { status: 400 });

  const charged = !!body.charged;
  const now = new Date().toISOString();
  const row = {
    appt_id: apptId,
    owner_key: ownerKey,
    charged,
    amount: body.amount != null ? Number(body.amount) : null,
    note: body.note !== undefined ? body.note : null,
    charged_at: charged ? now : null,
    charged_by: charged ? auth.email : null,
    updated_at: now,
  };
  const svc = createServiceClient();
  const { error } = await svc.from("ppa_charges").upsert(row, { onConflict: "appt_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, charge: row });
}
