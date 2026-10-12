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
    /** Display-only context so the auto-credit's reason reads like a human wrote it. */
    contact_name?: string; client_label?: string;
  };
  const apptId = String(body.appt_id ?? "").trim();
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!apptId || !ownerKey) return NextResponse.json({ error: "appt_id and owner_key required" }, { status: 400 });

  const now = new Date().toISOString();
  const svc = createServiceClient();

  // Exclude / un-exclude path.
  //
  // Voiding a show that was NEVER collected simply clears the pending charge.
  // Voiding a show whose fee was ALREADY COLLECTED (the artist told us later
  // it was cancelled / a no-show) keeps the charge on the books — the money
  // really moved — and auto-issues an approved credit for that fee, which
  // comes off the client's next charge. One click, no chat needed.
  // "Collected" = charged through Square (payment id present) or recorded as
  // charged by hand; a chat-billed row with no payment id is only *decided*,
  // not collected, so it just un-bills.
  if (body.excluded !== undefined) {
    const excluded = !!body.excluded;
    const reason = EXCLUDE_REASONS.includes(body.exclude_reason as (typeof EXCLUDE_REASONS)[number])
      ? body.exclude_reason : "other";
    const { data: existing } = await svc.from("ppa_charges")
      .select("charged, amount, square_payment_id").eq("appt_id", apptId).maybeSingle();
    const collected = !!existing?.charged && (!!existing?.square_payment_id || !apptId.startsWith("chat:"));
    const fee = Number(existing?.amount) || 0;
    let credited = 0;

    if (excluded && collected && fee > 0) {
      const row: Record<string, unknown> = {
        appt_id: apptId, owner_key: ownerKey,
        excluded: true, exclude_reason: reason, excluded_at: now, excluded_by: auth.email, updated_at: now,
      };
      const { error } = await svc.from("ppa_charges").upsert(row, { onConflict: "appt_id" });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const label = reason === "no_show" ? "No-show" : reason === "cancelled" ? "Cancelled" : "Voided";
      const lead = String(body.contact_name ?? "").trim() || apptId;
      const { data: have } = await svc.from("client_credits").select("id, status").eq("appt_id", apptId).maybeSingle();
      if (!have) {
        const { error: cErr } = await svc.from("client_credits").insert({
          owner_key: ownerKey, client_label: body.client_label ?? null, amount: fee, appt_id: apptId,
          reason: `${label}: ${lead} — fee of $${fee} was already collected, credited back. Comes off the next charge.`,
          status: "approved", requested_by: auth.email, requested_at: now,
          decided_by: auth.email, decided_at: now, updated_at: now,
        });
        if (cErr) return NextResponse.json({ error: `voided, but the credit failed: ${cErr.message}` }, { status: 500 });
        credited = fee;
      } else if (have.status !== "approved") {
        await svc.from("client_credits").update({ status: "approved", decided_by: auth.email, decided_at: now, updated_at: now }).eq("id", have.id);
        credited = fee;
      }
      return NextResponse.json({ ok: true, charge: row, keptCharge: true, credited });
    }

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

    // Restoring a voided-and-credited show withdraws the credit — but only
    // while none of it has been spent.
    let withdrawn = 0;
    if (!excluded) {
      const { data: have } = await svc.from("client_credits").select("id, amount, applied, status").eq("appt_id", apptId).maybeSingle();
      if (have && have.status === "approved" && Number(have.applied) === 0) {
        await svc.from("client_credits").update({ status: "denied", decided_by: auth.email, decided_at: now, updated_at: now }).eq("id", have.id);
        withdrawn = Number(have.amount) || 0;
      }
    }
    return NextResponse.json({ ok: true, charge: row, keptCharge: !!existing?.charged && !excluded, withdrawn });
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
