/* Was the money for this show really collected? ONE rule for every PPA screen
   (owner, 11/11/2026: "the numbers have to match exactly" — the coach view
   counted a booked-in-chat show as "paid us" while the admin view still had
   it in Ready).

   A row with charged=true is collected when it has a Square payment id, or is
   a calendar/deposit/self-booked show marked charged, or was settled from
   account credit. A booked-in-chat show ("chat:…") saved with NO payment id
   is billed but NOT collected yet: it stays in Ready until the card or a
   payment link pays it. */
export type ChargeLike = {
  appt_id: string;
  charged: boolean | null;
  excluded?: boolean | null;
  square_payment_id?: string | null;
  note?: string | null;
};

export const coveredByCredit = (note: string | null | undefined) =>
  String(note ?? "").startsWith("Covered by account credit");

export function isCollected(r: ChargeLike): boolean {
  if (!r.charged || r.excluded) return false;
  if (r.square_payment_id) return true;
  if (!r.appt_id.startsWith("chat:")) return true;
  return coveredByCredit(r.note);
}

/** Billed in chat, still waiting for the money (shows in Ready). */
export function isChatAwaiting(r: ChargeLike): boolean {
  return !!r.charged && !r.excluded && r.appt_id.startsWith("chat:") && !isCollected(r);
}
