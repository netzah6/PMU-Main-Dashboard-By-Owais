import type { SupabaseClient } from "@supabase/supabase-js";
import type { V3Client } from "@/lib/ppa";

// "Refund, but keep the PPA fee" (owner, 11/11/2026): the lead gets the
// deposit back, but PPA Billing still charges the artist the service fee.
// Only for V3 clients on pay-per-appointment.

export const refundBizNorm = (business: unknown) =>
  String(business ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Businesses (normalized) that may use it: the PPA roster (financing sheet
 *  "PPA"/"PPS", Live or Paused), V3 only, minus billing-exempt clients (they
 *  are never charged, so there is no fee to keep). */
export function ppaKeepFeeBizNorms(roster: V3Client[], exemptOwnerKeys: Set<string>): string[] {
  return [...new Set(
    roster
      .filter((c) => /v3/i.test(c.version) && c.bizNorm && !exemptOwnerKeys.has(c.ownerKey))
      .map((c) => c.bizNorm),
  )];
}

export async function exemptOwnerKeys(svc: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await svc.from("ppa_config").select("owner_key").eq("billing_exempt", true);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r) => String((r as { owner_key: string }).owner_key)));
}

export type KeepFeeRefund = { id: string; business: string | null; email: string | null; deposit_date: string | null };

const usDate = (d: string) => {
  const m = d.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // sheet dates are DD/MM/YYYY
  return m ? `${m[2].padStart(2, "0")}/${m[1].padStart(2, "0")}/${m[3]}` : d.trim();
};

/** Refund id → why "keep the fee" must NOT be used for it (missing = allowed).
 *  - The same appointment is already billed through ANOTHER deposit of that
 *    lead (AI took a second deposit for a booking that already had one —
 *    Kelly Winston, 11/11/2026). Keeping this one too would bill the artist
 *    twice for one visit; the normal refund already leaves one fee.
 *  - The deposit is before the client's PPS start date: it is never billed.
 *  An other deposit that is refunded, before the start date, or voided with
 *  Exclude on PPA Billing does not count — it never bills.
 *  Matches deposits to a refund the same way the ppa_refunded_deposits view
 *  does (business + email + deposit date). Throws when it can't tell. */
export async function keepFeeBlocks(svc: SupabaseClient, refunds: KeepFeeRefund[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const bizNorms = [...new Set(refunds.map((r) => refundBizNorm(r.business)).filter(Boolean))];
  if (!bizNorms.length) return out;

  type Dep = { appt_id: string; biz_norm: string; email: string | null; deposit_date: string | null };
  const { data: depData, error: depErr } = await svc.from("ppa_deposit_rows")
    .select("appt_id, biz_norm, email, deposit_date").in("biz_norm", bizNorms);
  if (depErr) throw new Error(depErr.message);
  const deps = (depData ?? []) as Dep[];
  const ids = [...new Set(deps.map((d) => d.appt_id))];
  if (!ids.length) return out;

  type Bill = { appt_id: string; owner_key: string; start_time: string | null; charge_status: string };
  type Appt = { appt_id: string; title: string | null };
  const [billRes, apptRes, chgRes] = await Promise.all([
    svc.from("ppa_deposit_billing").select("appt_id, owner_key, start_time, charge_status").in("appt_id", ids),
    svc.from("ppa_deposit_appointment").select("appt_id, title").in("appt_id", ids),
    svc.from("ppa_charges").select("appt_id, excluded").in("appt_id", ids),
  ]);
  if (billRes.error) throw new Error(billRes.error.message);
  if (apptRes.error) throw new Error(apptRes.error.message);
  if (chgRes.error) throw new Error(chgRes.error.message);
  // A deposit voided with Exclude on PPA Billing never bills, so it can't be
  // "the other deposit that already carries the fee".
  const excluded = new Set(((chgRes.data ?? []) as Array<{ appt_id: string; excluded: boolean | null }>)
    .filter((c) => c.excluded === true).map((c) => c.appt_id));
  const bill = new Map(((billRes.data ?? []) as Bill[]).map((b) => [b.appt_id, b]));
  const title = new Map(((apptRes.data ?? []) as Appt[]).map((a) => [a.appt_id, String(a.title ?? "").trim().toLowerCase()]));
  const depById = new Map(deps.map((d) => [d.appt_id, d]));
  const key = (s: unknown) => String(s ?? "").trim().toLowerCase();

  for (const r of refunds) {
    const bn = refundBizNorm(r.business);
    const mine = deps.filter((d) => d.biz_norm === bn && key(d.email) === key(r.email) && key(d.deposit_date) === key(r.deposit_date));
    if (!mine.length) continue; // not in PPA billing (yet) — keeping the fee can't double-bill
    const myIds = new Set(mine.map((d) => d.appt_id));
    const myBills = mine.map((d) => bill.get(d.appt_id)).filter(Boolean) as Bill[];
    if (myBills.length && myBills.every((b) => b.charge_status === "before_start")) {
      out.set(r.id, "This deposit is before the client's PPS start date, so no fee is billed for it anyway.");
      continue;
    }
    for (const b of myBills) {
      if (!b.start_time) continue;
      const other = [...bill.values()].find((o) =>
        !myIds.has(o.appt_id) && o.owner_key === b.owner_key && o.start_time === b.start_time
        && title.get(o.appt_id) === title.get(b.appt_id)
        && o.charge_status !== "refunded" && o.charge_status !== "before_start" && !excluded.has(o.appt_id));
      if (other) {
        const when = depById.get(other.appt_id)?.deposit_date;
        out.set(r.id, `This visit is already billed through the lead's other deposit${when ? ` (${usDate(when)})` : ""}. Use "Approve & refund": the PPA fee stays once.`);
        break;
      }
    }
  }
  return out;
}
