import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// Mark one appointment charged / not-charged, OR exclude it from billing.
// PPS model: "charged" = the client showed and we billed the $45; "excluded"
// = don't bill and don't count (test, cancelled, refund, no-show, not a fit).
// An exclude with reason "no_show" is what feeds the show-rate denominator.
const EXCLUDE_REASONS = ["no_show", "cancelled", "refunded", "test", "not_a_fit", "other"] as const;

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    appt_id?: string; owner_key?: string; charged?: boolean; amount?: number; note?: string;
    excluded?: boolean; exclude_reason?: string;
  };
  const apptId = String(body.appt_id ?? "").trim();
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!apptId || !ownerKey) return NextResponse.json({ error: "appt_id and owner_key required" }, { status: 400 });

  const now = new Date().toISOString();
  const svc = createServiceClient();

  // Exclude / un-exclude path. Excluding always clears any charge — an
  // appointment can't be both billed and voided.
  if (body.excluded !== undefined) {
    const excluded = !!body.excluded;
    const reason = EXCLUDE_REASONS.includes(body.exclude_reason as (typeof EXCLUDE_REASONS)[number])
      ? body.exclude_reason : "other";
    const row: Record<string, unknown> = excluded
      ? {
          appt_id: apptId, owner_key: ownerKey,
          excluded: true, exclude_reason: reason, excluded_at: now, excluded_by: auth.email,
          charged: false, charged_at: null, charged_by: null, updated_at: now,
        }
      : {
          appt_id: apptId, owner_key: ownerKey,
          excluded: false, exclude_reason: null, excluded_at: null, excluded_by: null, updated_at: now,
        };
    const { error } = await svc.from("ppa_charges").upsert(row, { onConflict: "appt_id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, charge: row });
  }

  // Charge / un-charge path. Charging always clears an exclude.
  const charged = !!body.charged;
  const row: Record<string, unknown> = charged
    ? {
        appt_id: apptId, owner_key: ownerKey, charged: true,
        amount: body.amount != null ? Number(body.amount) : null,
        note: body.note !== undefined ? body.note : null,
        charged_at: now, charged_by: auth.email,
        excluded: false, exclude_reason: null, updated_at: now,
      }
    : {
        appt_id: apptId, owner_key: ownerKey, charged: false,
        charged_at: null, charged_by: null, updated_at: now,
      };
  const { error } = await svc.from("ppa_charges").upsert(row, { onConflict: "appt_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, charge: row });
}
