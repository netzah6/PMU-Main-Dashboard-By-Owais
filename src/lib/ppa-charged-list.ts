// What a PPS artist was charged for, one line per card charge. Shared by
// /api/ppa/client (the drill's "Charged & went through" box) and the billing
// tab's "copy list" button, which pastes this to the artist when she asks
// which of her customers she was billed for. Pure — no I/O — so it can be run
// against real rows directly.

export type ChargeLite = {
  appt_id: string; charged: boolean; amount: number | null; note: string | null;
  charged_at: string | null; charged_by: string | null; square_payment_id?: string | null;
};
export type ApptLite = { apptId: string; contactName: string | null; appointmentDate: string | null; chargeStatus: string };
export type CreditApplication = { credit_id: string | number | null; amount: number | null; square_payment_id: string | null; applied_at: string | null };
export type PartCredit = { id: string | number; amount: number | null; reason: string | null; decided_at: string | null; requested_at: string | null };
export type ChargedItem = { name: string; date: string | null; dateLabel: string | null };

export type PayGroup = {
  paymentId: string | null; chargedAt: string | null; chargedBy: string | null;
  shows: number;
  gross: number;   // shows × fee — ppa_charges.amount is always the gross fee
  credit: number;  // account credit (a discount) that came off this charge
  // Part-payment leftovers are HER cash, not a discount: prepaidExtra is the
  // leftover this card charge took beyond its shows; prepaidUsed is leftover
  // from an earlier charge that reduced this one.
  prepaidUsed: number; prepaidExtra: number;
  total: number;   // what this card charge actually was
  manual: boolean; creditOnly: boolean; prepaidOnly: boolean;
  contacts: string[];
  items: ChargedItem[];
};

/** "Square abc123 — Jane Doe" → "Jane Doe": the name saved with a charge. */
export function nameFromNote(note: string | null): string {
  const parts = String(note ?? "").split(" — ");
  return parts.length > 1 ? parts[parts.length - 1].trim() : "";
}

/** Settled entirely by account credit — no Square payment id by design. */
export const coveredByCredit = (note: string | null) => String(note ?? "").startsWith("Covered by account credit");

const ms = (d: string | null | undefined) => (d ? new Date(d).getTime() : NaN);

// Which date to show next to a charged show, and what it means. Only a date
// that can be the session: a deposit lead's date is her LATEST appointment and
// a self-booked date is her last stage move, so either one after the charge
// (a touch-up, a later review stage) is left out; a chat bill's date is when
// we billed, so it gets none. A show whose source row has left the views has
// no date at all — ppa_charges doesn't store one.
function showDate(r: ChargeLite, a: ApptLite | undefined): { date: string | null; dateLabel: string | null } {
  if (r.appt_id.startsWith("chat:")) return { date: null, dateLabel: "booked in chat" };
  if (!a?.appointmentDate) return { date: null, dateLabel: null };
  if (ms(a.appointmentDate) > ms(r.charged_at)) return { date: null, dateLabel: null };
  return { date: a.appointmentDate, dateLabel: a.chargeStatus === "self_booked" ? "marked done" : "appointment" };
}

/** Every charge that went through, grouped per card charge, newest first.
 *  One Square payment covers several shows (same square_payment_id); manual
 *  marks and credit-only settlements batch by minute + marker. */
export function groupCharges(
  charges: ChargeLite[], appointments: ApptLite[],
  creditApps: CreditApplication[], partCredits: PartCredit[],
): PayGroup[] {
  const apptById = new Map(appointments.map((a) => [a.apptId, a]));
  const groups = new Map<string, PayGroup>();
  for (const r of charges) {
    if (!r.charged) continue;
    // A chat bill with no Square payment yet is decided, not collected — it
    // shows as ready, so it doesn't belong here. Unless account credit
    // settled it (no payment id by design).
    if (r.appt_id.startsWith("chat:") && !r.square_payment_id && !coveredByCredit(r.note)) continue;
    const key = r.square_payment_id ?? `manual:${(r.charged_at ?? "").slice(0, 16)}:${r.charged_by ?? ""}`;
    const g = groups.get(key) ?? {
      paymentId: r.square_payment_id ?? null, chargedAt: r.charged_at, chargedBy: r.charged_by,
      shows: 0, gross: 0, credit: 0, prepaidUsed: 0, prepaidExtra: 0, total: 0,
      manual: !r.square_payment_id, creditOnly: false, prepaidOnly: false, contacts: [], items: [],
    };
    const a = apptById.get(r.appt_id);
    const name = a?.contactName || nameFromNote(r.note) || "(name not recorded)";
    g.shows++;
    g.gross += Number(r.amount) || 0;
    if (!r.square_payment_id && coveredByCredit(r.note)) g.creditOnly = true;
    g.contacts.push(name);
    g.items.push({ name, ...showDate(r, a) });
    if ((r.charged_at ?? "") > (g.chargedAt ?? "")) g.chargedAt = r.charged_at;
    groups.set(key, g);
  }

  // Credit that came off these charges. Without it a $135 run paid $100 by
  // card + $35 credit would read $135. Same matching as /api/ppa/payments: by
  // payment id, and a credit-only settlement (no payment id) by day. A "Part
  // payment <id>" credit is cash she already paid on card <id>, so it counts
  // as prepaid — every line then equals what that card charge actually was.
  const partIds = new Set(partCredits.map((c) => String(c.id)));
  for (const c of creditApps) {
    const prepaid = partIds.has(String(c.credit_id));
    const add = (g: PayGroup, amt: number) => { if (prepaid) g.prepaidUsed += amt; else g.credit += amt; };
    let left = Number(c.amount) || 0;
    if (c.square_payment_id) {
      const g = groups.get(c.square_payment_id);
      if (g) add(g, left);
      continue;
    }
    // Credit-only: spread over that day's credit-settled groups (a run that
    // crosses a minute boundary lands in two manual groups).
    const day = String(c.applied_at ?? "").slice(0, 10);
    for (const g of groups.values()) {
      if (left <= 0 || !g.creditOnly || String(g.chargedAt ?? "").slice(0, 10) !== day) continue;
      const take = Math.min(left, Math.max(0, g.gross - g.credit - g.prepaidUsed));
      add(g, take);
      left -= take;
    }
  }
  // The leftover itself was collected on its own card charge: add it to that
  // payment's line, or — when it settled no whole show — list it on its own.
  for (const pc of partCredits) {
    const pid = /^Part payment (\S+)/.exec(pc.reason ?? "")?.[1];
    const amt = Number(pc.amount) || 0;
    if (!pid || amt <= 0) continue;
    const g = groups.get(pid);
    if (g) { g.prepaidExtra += amt; continue; }
    groups.set(pid, {
      paymentId: pid, chargedAt: pc.decided_at ?? pc.requested_at, chargedBy: null,
      shows: 0, gross: 0, credit: 0, prepaidUsed: 0, prepaidExtra: amt, total: 0,
      manual: false, creditOnly: false, prepaidOnly: true, contacts: [], items: [],
    });
  }
  for (const g of groups.values()) g.total = Math.max(0, g.gross - g.credit - g.prepaidUsed) + g.prepaidExtra;
  return [...groups.values()].sort((a, b) => String(b.chargedAt ?? "").localeCompare(String(a.chargedAt ?? "")));
}

type ListGroup = Pick<PayGroup, "chargedAt" | "shows" | "total"> &
  Partial<Pick<PayGroup, "gross" | "credit" | "prepaidUsed" | "prepaidExtra" | "prepaidOnly" | "contacts" | "items">>;

function money(n: number): string {
  return "$" + (n || 0).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0 });
}
function fmtDate(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Paste-ready text for the artist: every line's amount is that card charge,
 *  so the charged total is what she paid by card; account credit (a
 *  discount) is shown on top of it. */
export function chargedListText(who: string, pays: ListGroup[]): string {
  const shows = pays.reduce((n, p) => n + p.shows, 0);
  if (shows === 0) return `${who}: no shows charged yet.`;
  const plural = (n: number) => `${n} show${n === 1 ? "" : "s"}`;
  const paid = pays.reduce((n, p) => n + p.total, 0);
  const credit = pays.reduce((n, p) => n + (p.credit ?? 0), 0);
  const lines = [`${who} — clients we charged you for`,
    `Total: ${plural(shows)} · ${money(paid)} charged${credit > 0 ? ` + ${money(credit)} covered by account credit` : ""}`];
  for (const p of pays) {
    const credited = p.credit ?? 0, earlier = p.prepaidUsed ?? 0, ahead = p.prepaidExtra ?? 0;
    const gross = p.gross ?? p.total;
    let head: string;
    if (p.prepaidOnly) {
      head = `Charged ${fmtDate(p.chargedAt)} — ${money(p.total)} (paid ahead, applied to your next shows)`;
    } else if (p.total === 0) {
      const by = [credited > 0 && "account credit", earlier > 0 && "your earlier payment"].filter(Boolean).join(" + ");
      head = `Covered by ${by || "account credit"} ${fmtDate(p.chargedAt)} — ${plural(p.shows)} (${money(gross)})`;
    } else {
      const less = [credited > 0 && `less ${money(credited)} account credit`, earlier > 0 && `less ${money(earlier)} paid earlier`].filter(Boolean);
      head = `Charged ${fmtDate(p.chargedAt)} — ${money(p.total)} (${plural(p.shows)}`
        + (less.length ? `; ${money(gross)} ${less.join(", ")}` : "")
        + (ahead > 0 ? `; includes ${money(ahead)} paid ahead` : "") + ")";
    }
    lines.push("", head);
    // Dated shows in session order; undated ones (chat, touch-up pending) last.
    const items = [...(p.items ?? (p.contacts ?? []).map((name) => ({ name, date: null, dateLabel: null })))]
      .sort((x, y) => (x.date ? 0 : 1) - (y.date ? 0 : 1) || (x.date && y.date ? ms(x.date) - ms(y.date) : 0));
    for (const it of items) {
      const when = it.dateLabel ? ` — ${it.dateLabel}${it.date ? ` ${fmtDate(it.date)}` : ""}` : "";
      lines.push(`  • ${it.name}${when}`);
    }
  }
  return lines.join("\n");
}
