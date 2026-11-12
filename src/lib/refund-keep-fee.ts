import type { V3Client } from "@/lib/ppa";

// "Refund, but keep the PPA fee" is only for V3 clients on pay-per-appointment
// (owner, 11/11/2026). The PPA roster already holds only pay-per-appointment
// clients (financing sheet "PPA"/"PPS", Live or Paused); this keeps the V3 ones.
export const refundBizNorm = (business: unknown) =>
  String(business ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function ppaKeepFeeBizNorms(roster: V3Client[]): string[] {
  return [...new Set(
    roster.filter((c) => /v3/i.test(c.version) && c.bizNorm).map((c) => c.bizNorm),
  )];
}
