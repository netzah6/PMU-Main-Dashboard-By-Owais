import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { getPpaRoster, type V3Client } from "@/lib/ppa";
import {
  listCards,
  listAllCustomers,
  listRecentPayments,
  createCardPayment,
  type SquareCard,
  type SquareCustomer,
} from "@/lib/square";

// ── PPS payment-method verification ──────────────────────────────────────────
// Answers, per PPS client, the question the billing tab can't: "if we charged
// this artist today, WHO would we charge and on WHAT card?" Read-only — this
// module never moves money. It exists so nothing is ever charged against a
// guessed Square customer or a stale card.
//
// Two rules it is built around:
//  1. Cards are read live, never cached against a client. Artists change their
//     payment method, so a stored card id is a wrong charge waiting to happen.
//  2. Square has no "default card" flag. Whoever charges must pick one; this
//     report names the card it would pick (newest enabled) and flags any client
//     where that choice isn't obvious.

export type FlagLevel = "block" | "warn" | "info";
export interface VerifyFlag { key: string; level: FlagLevel; message: string }

export interface VerifyCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  cardholderName: string | null;
  enabled: boolean;
  expired: boolean;
  expiringSoon: boolean;   // within 60 days
  wouldCharge: boolean;    // the card this report would charge
  lastUsedAt: string | null; // most recent COMPLETED Square payment on this card
  isChosenDefault: boolean;  // admin picked this card on the Payment check tab
}

export interface VerifyShow {
  apptId: string;
  contactName: string | null;
  apptDate: string | null;
  chargeStatus: string;    // served | past_due
}

export type MatchMethod = "email" | "phone" | "name" | "business" | null;
export type MatchConfidence = "high" | "medium" | "low" | "none";

export interface VerifyMatch {
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  method: MatchMethod;
  confidence: MatchConfidence;
  /** Other customers that matched as well — an ambiguous match, not a match. */
  otherCandidates: Array<{ id: string; name: string; email: string | null }>;
}

export interface VerifyRow {
  ownerKey: string;
  ownerName: string;
  business: string;
  status: string;
  version: string;
  /** What we matched FROM (Clients Master). */
  email: string | null;
  phone: string | null;
  fee: number;
  feeSource: "sheet" | "dashboard";
  sheetNotes: string | null;
  autoCharge: boolean;
  readyToCharge: number;
  amount: number;
  pastDue: number;
  shows: VerifyShow[];
  match: VerifyMatch | null;
  cards: VerifyCard[];
  flags: VerifyFlag[];
  /** No blocking or warning flag, and there is actually something to charge. */
  safeToAutoCharge: boolean;
}

export interface VerifyReport {
  clients: VerifyRow[];
  missingFromMaster: string[];
  /** True when the Square customer list hit its page cap during name matching. */
  customerScanTruncated: boolean;
  totals: { clients: number; shows: number; amount: number; ready: number; blocked: number };
  generatedAt: string;
}

const normEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
/** Last 10 digits — ignores +1 / 001 country prefixes on either side. */
const phoneKey = (v: unknown) => { const d = digits(v); return d.length >= 10 ? d.slice(-10) : ""; };
const nameKey = (v: unknown) =>
  String(v ?? "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const bizKey = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function mapWithConcurrency<I, O>(items: I[], limit: number, worker: (item: I) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  async function lane() { while (next < items.length) { const i = next++; out[i] = await worker(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
  return out;
}

/** Expiry checks against the END of the expiry month (cards work all month). */
function expiryState(card: SquareCard, now: Date): { expired: boolean; expiringSoon: boolean } {
  if (!card.expMonth || !card.expYear) return { expired: false, expiringSoon: false };
  const endOfExpiry = new Date(Date.UTC(card.expYear, card.expMonth, 1)); // 1st of the following month
  const expired = endOfExpiry.getTime() <= now.getTime();
  const soon = !expired && endOfExpiry.getTime() - now.getTime() < 60 * 24 * 3600 * 1000;
  return { expired, expiringSoon: soon };
}

// Find the artist's Square customer against a pre-built local index of the
// whole customer list. One paginated list fetch serves every client — the
// per-client SearchCustomers calls this replaces are what tripped Square's
// per-method rate limit and painted the first live run red.
// Email is the only identifier trusted outright; phone is close behind; a
// name match is a suggestion the human has to confirm (name matching has put
// us on the wrong record before).
class CustomerIndex {
  byEmail = new Map<string, SquareCustomer[]>();
  byPhone = new Map<string, SquareCustomer[]>();
  byName = new Map<string, SquareCustomer[]>();
  byBiz = new Map<string, SquareCustomer[]>();
  constructor(customers: SquareCustomer[]) {
    const add = (m: Map<string, SquareCustomer[]>, k: string, c: SquareCustomer) => {
      if (!k) return;
      const list = m.get(k) ?? [];
      list.push(c);
      m.set(k, list);
    };
    for (const c of customers) {
      add(this.byEmail, normEmail(c.email), c);
      add(this.byPhone, phoneKey(c.phone), c);
      add(this.byName, nameKey(c.name), c);
      add(this.byBiz, bizKey(c.company), c);
      add(this.byBiz, bizKey(c.name), c);
    }
  }
}

function matchCustomer(
  c: V3Client,
  email: string | null,
  phone: string | null,
  index: CustomerIndex,
): VerifyMatch | null {
  const pick = (hits: SquareCustomer[], method: MatchMethod, confidence: MatchConfidence): VerifyMatch => {
    const [first, ...rest] = hits;
    return {
      customerId: first.id,
      customerName: first.name,
      customerEmail: first.email,
      customerPhone: first.phone ?? null,
      method,
      confidence: rest.length ? "low" : confidence,
      otherCandidates: rest.map((r) => ({ id: r.id, name: r.name, email: r.email })),
    };
  };

  const byEmail = email ? index.byEmail.get(normEmail(email)) : undefined;
  if (byEmail?.length) return pick(byEmail, "email", "high");

  const byPhone = phone ? index.byPhone.get(phoneKey(phone)) : undefined;
  if (byPhone?.length) return pick(byPhone, "phone", "medium");

  const byName = index.byName.get(nameKey(c.ownerName));
  if (byName?.length) return pick(byName, "name", "low");

  const byBiz = index.byBiz.get(bizKey(c.business));
  if (byBiz?.length) return pick(byBiz, "business", "low");

  return null;
}

type BillingRow = { owner_key: string; appt_id: string; charge_status: string; start_time: string | null };
type ChargeRow = { appt_id: string; charged: boolean | null; excluded: boolean | null };
type DepRow = { appt_id: string; biz_norm: string; contact_name: string | null };

export async function buildVerifyReport(ownerKeyFilter?: string): Promise<VerifyReport> {
  const svc = createServiceClient();
  const { clients: allRoster, missingFromMaster } = await getPpaRoster();
  const roster = ownerKeyFilter ? allRoster.filter((c) => c.ownerKey === ownerKeyFilter) : allRoster;
  const ownerKeys = roster.map((c) => c.ownerKey);
  const bizNorms = roster.map((c) => c.bizNorm).filter(Boolean);

  const [masterRes, cfgRes, billRes, chgRes, depRes] = await Promise.all([
    svc.from("clients_master").select("data"),
    svc.from("ppa_config").select("owner_key, fee_per_appt, auto_charge").in("owner_key", ownerKeys),
    svc.from("ppa_deposit_billing").select("owner_key, appt_id, charge_status, start_time").in("owner_key", ownerKeys),
    svc.from("ppa_charges").select("appt_id, charged, excluded").in("owner_key", ownerKeys),
    svc.from("ppa_deposit_rows").select("appt_id, biz_norm, contact_name").in("biz_norm", bizNorms),
  ]);

  // Contact details come from Clients Master, the same sheet the roster is
  // built from — so a mismatch here is a sheet problem, visible in the report.
  const contactByKey = new Map<string, { email: string | null; phone: string | null }>();
  for (const r of (masterRes.data ?? []) as Array<{ data: Record<string, unknown> }>) {
    const d = r.data ?? {};
    const key = String(d["Owner Full Name"] ?? "").trim().toLowerCase();
    if (!key || contactByKey.has(key)) continue;
    contactByKey.set(key, {
      email: normEmail(d["Email"]) || null,
      phone: String(d["Phone"] ?? "").trim() || null,
    });
  }

  const feeBy = new Map<string, number>();
  const autoBy = new Map<string, boolean>();
  for (const r of (cfgRes.data ?? []) as Array<{ owner_key: string; fee_per_appt: number; auto_charge: boolean | null }>) {
    feeBy.set(r.owner_key, Number(r.fee_per_appt));
    autoBy.set(r.owner_key, !!r.auto_charge);
  }

  const chgBy = new Map<string, ChargeRow>();
  for (const r of (chgRes.data ?? []) as ChargeRow[]) chgBy.set(r.appt_id, r);

  const nameByAppt = new Map<string, string | null>();
  for (const r of (depRes.data ?? []) as DepRow[]) nameByAppt.set(r.appt_id, r.contact_name);

  // Same rule as ppa_billing_summary.ready_to_charge, so the money here always
  // equals the "To charge" worklist on the billing tab.
  const showsBy = new Map<string, VerifyShow[]>();
  const pastDueBy = new Map<string, number>();
  for (const b of (billRes.data ?? []) as BillingRow[]) {
    if (b.charge_status === "past_due") pastDueBy.set(b.owner_key, (pastDueBy.get(b.owner_key) ?? 0) + 1);
    if (b.charge_status !== "served" && b.charge_status !== "past_due") continue;
    const ch = chgBy.get(b.appt_id);
    if (ch?.charged || ch?.excluded) continue;
    const list = showsBy.get(b.owner_key) ?? [];
    list.push({
      apptId: b.appt_id,
      contactName: nameByAppt.get(b.appt_id) ?? null,
      apptDate: b.start_time,
      chargeStatus: b.charge_status,
    });
    showsBy.set(b.owner_key, list);
  }

  // One list fetch, matched locally — never a per-client Square search.
  // Recent payments feed each card's "last used"; if that call fails the
  // report still renders, just without last-used info.
  const [{ customers, truncated }, recentPayments, prefRes] = await Promise.all([
    listAllCustomers(),
    listRecentPayments().catch(() => []),
    svc.from("ppa_card_prefs").select("owner_key, customer_id, card_id").in("owner_key", ownerKeys),
  ]);
  const index = new CustomerIndex(customers);

  // Newest COMPLETED payment per card (payments arrive newest-first). Cards
  // are matched by id when Square includes it, else by fingerprint.
  const lastUsedByCardId = new Map<string, string>();
  const lastUsedByFingerprint = new Map<string, string>();
  for (const p of recentPayments) {
    if (p.cardId && !lastUsedByCardId.has(p.cardId)) lastUsedByCardId.set(p.cardId, p.createdAt);
    if (p.cardFingerprint && !lastUsedByFingerprint.has(p.cardFingerprint)) lastUsedByFingerprint.set(p.cardFingerprint, p.createdAt);
  }

  const prefBy = new Map<string, { customer_id: string; card_id: string }>();
  for (const r of (prefRes.data ?? []) as Array<{ owner_key: string; customer_id: string; card_id: string }>)
    prefBy.set(r.owner_key, { customer_id: r.customer_id, card_id: r.card_id });

  const now = new Date();

  // Concurrency 2: after the customer list, the only Square traffic left is
  // one ListCards call per matched client, kept slow enough to stay under the
  // per-method rate limit even right after other tabs hit Square.
  const rows = await mapWithConcurrency(roster, 2, async (c): Promise<VerifyRow> => {
    const contact = contactByKey.get(c.ownerKey) ?? { email: null, phone: null };
    // The financing sheet's latest month states the fee; dashboard fee is the
    // fallback when the notes don't parse to one.
    const fee = c.sheetFee ?? feeBy.get(c.ownerKey) ?? 30;
    const shows = (showsBy.get(c.ownerKey) ?? []).sort((a, b) =>
      String(b.apptDate ?? "").localeCompare(String(a.apptDate ?? "")));
    const pastDue = pastDueBy.get(c.ownerKey) ?? 0;
    const flags: VerifyFlag[] = [];

    let match: VerifyMatch | null = null;
    let cards: VerifyCard[] = [];
    const pref = prefBy.get(c.ownerKey);
    let prefMissing = false;
    try {
      match = matchCustomer(c, contact.email, contact.phone, index);
      if (match) {
        const raw = await listCards(match.customerId);
        const usable = (k: SquareCard) => k.enabled && !expiryState(k, now).expired;
        const lastUsedOf = (k: SquareCard) =>
          lastUsedByCardId.get(k.id) ?? (k.fingerprint ? lastUsedByFingerprint.get(k.fingerprint) : undefined) ?? null;
        // Which card gets charged, in order of trust:
        //   1. the card the admin explicitly chose (only if still usable —
        //      if it's gone or dead we BLOCK below, never silently switch),
        //   2. the card the client most recently paid with,
        //   3. the newest card on file (adding a card is a signal to use it).
        const chosen = pref && pref.customer_id === match.customerId
          ? raw.find((k) => k.id === pref.card_id)
          : undefined;
        if (pref && pref.customer_id === match.customerId && (!chosen || !usable(chosen))) prefMissing = true;
        const byLastUsed = raw.filter(usable).sort((a, b) =>
          String(lastUsedOf(b) ?? "").localeCompare(String(lastUsedOf(a) ?? "")));
        const wouldChargeId =
          (chosen && usable(chosen) ? chosen.id : null) ??
          (byLastUsed[0] && lastUsedOf(byLastUsed[0]) ? byLastUsed[0].id : null) ??
          raw.find(usable)?.id ?? null;
        cards = raw.map((k) => {
          const e = expiryState(k, now);
          return {
            id: k.id,
            brand: k.brand,
            last4: k.last4,
            expMonth: k.expMonth,
            expYear: k.expYear,
            cardholderName: k.cardholderName,
            enabled: k.enabled,
            expired: e.expired,
            expiringSoon: e.expiringSoon,
            wouldCharge: k.id === wouldChargeId,
            lastUsedAt: lastUsedOf(k),
            isChosenDefault: chosen?.id === k.id,
          };
        });
      }
    } catch (e) {
      flags.push({
        key: "square_error",
        level: "block",
        message: `Square lookup failed: ${e instanceof Error ? e.message : "unknown error"}`,
      });
    }

    // ── Flags ────────────────────────────────────────────────────────────────
    if (!match && !flags.length) {
      flags.push({
        key: "no_customer",
        level: "block",
        message: contact.email
          ? `No Square customer found for ${contact.email}${contact.phone ? `, ${contact.phone}` : ""}, "${c.ownerName}" or "${c.business}".`
          : `No email in Clients Master and no Square customer found for "${c.ownerName}" or "${c.business}".`,
      });
    }
    if (!contact.email) {
      flags.push({ key: "no_email_on_file", level: "warn", message: "No email in Clients Master — can't match on the one identifier we trust." });
    }
    if (match && match.otherCandidates.length) {
      flags.push({
        key: "ambiguous_match",
        level: "block",
        message: `${match.otherCandidates.length + 1} Square customers matched (${[match.customerName, ...match.otherCandidates.map((o) => o.name)].join(", ")}) — pick the right one before charging.`,
      });
    }
    if (match && (match.method === "name" || match.method === "business")) {
      flags.push({
        key: "name_match_only",
        level: "block",
        message: `Matched by ${match.method === "name" ? "name" : "business name"} only — Square has ${match.customerEmail ?? "no email"} on this customer, the sheet has ${contact.email ?? "none"}. Confirm it's the same person.`,
      });
    }
    if (match && match.method === "phone") {
      flags.push({ key: "phone_match", level: "warn", message: `Matched by phone (${contact.phone}) — email didn't match any Square customer.` });
    }
    if (match && !flags.some((f) => f.key === "square_error")) {
      const usable = cards.filter((k) => k.enabled && !k.expired);
      const charging = cards.find((k) => k.wouldCharge);
      if (prefMissing) {
        flags.push({
          key: "chosen_card_gone",
          level: "block",
          message: "The card you picked as default is no longer on file (or expired/disabled) — pick a card again before charging.",
        });
      }
      if (cards.length === 0) {
        flags.push({ key: "no_card", level: "block", message: "No card on file in Square — nothing to charge." });
      } else if (usable.length === 0) {
        flags.push({ key: "no_usable_card", level: "block", message: `${cards.length} card(s) on file, all expired or disabled.` });
      } else if (usable.length > 1 && !charging?.isChosenDefault) {
        const how = charging?.lastUsedAt ? "the one they last paid with" : "the newest";
        flags.push({
          key: "multiple_cards",
          level: "warn",
          message: `${usable.length} usable cards (${usable.map((k) => `${k.brand} ••${k.last4}`).join(", ")}). Square has no default — this would charge ${how}, ${charging?.brand} ••${charging?.last4}. Pick one to silence this.`,
        });
      }
      const expiring = usable.find((k) => k.expiringSoon);
      if (expiring) {
        flags.push({
          key: "card_expiring",
          level: "warn",
          message: `${expiring.brand} ••${expiring.last4} expires ${String(expiring.expMonth).padStart(2, "0")}/${expiring.expYear}.`,
        });
      }
      const expiredCards = cards.filter((k) => k.expired);
      if (expiredCards.length && usable.length) {
        flags.push({
          key: "expired_card_on_file",
          level: "info",
          message: `${expiredCards.length} expired card(s) still on file (${expiredCards.map((k) => `••${k.last4}`).join(", ")}).`,
        });
      }
    }
    if (c.status === "paused") {
      flags.push({ key: "paused", level: "warn", message: "Client is marked Paused in Clients Master." });
    }
    if (pastDue >= 3) {
      flags.push({
        key: "not_organized",
        level: "warn",
        message: `⚠ NOT ORGANIZED — ${pastDue} past appointments still sitting in "confirmed". Billed as shown by default, so double-check before charging.`,
      });
    }
    if (c.sheetFee == null && shows.length > 0) {
      flags.push({
        key: "fee_not_in_sheet",
        level: "warn",
        message: `Couldn't read a per-show fee from the financing sheet notes ("${c.sheetNotes ?? "no notes"}") — using the dashboard fee ${"$" + fee}. State it in the sheet to be sure.`,
      });
    }
    if (shows.length === 0) {
      flags.push({ key: "nothing_to_charge", level: "info", message: "No shows waiting to be charged." });
    }

    const blocking = flags.some((f) => f.level === "block" || f.level === "warn");
    return {
      ownerKey: c.ownerKey,
      ownerName: c.ownerName,
      business: c.business,
      status: c.status,
      version: c.version,
      email: contact.email,
      phone: contact.phone,
      fee,
      feeSource: (c.sheetFee != null ? "sheet" : "dashboard") as "sheet" | "dashboard",
      sheetNotes: c.sheetNotes,
      autoCharge: autoBy.get(c.ownerKey) ?? false,
      readyToCharge: shows.length,
      amount: shows.length * fee,
      pastDue,
      shows,
      match,
      cards,
      flags,
      safeToAutoCharge: shows.length > 0 && !blocking,
    };
  });

  rows.sort((a, b) => b.amount - a.amount || a.ownerName.localeCompare(b.ownerName));

  return {
    clients: rows,
    missingFromMaster: ownerKeyFilter ? [] : missingFromMaster,
    customerScanTruncated: truncated,
    totals: {
      clients: rows.length,
      shows: rows.reduce((s, r) => s + r.readyToCharge, 0),
      amount: rows.reduce((s, r) => s + r.amount, 0),
      ready: rows.filter((r) => r.safeToAutoCharge).length,
      blocked: rows.filter((r) => r.amount > 0 && !r.safeToAutoCharge).length,
    },
    generatedAt: now.toISOString(),
  };
}

// ── Executing a charge ───────────────────────────────────────────────────────
// Shared by the manual Charge button and the Monday auto-charge cron, so both
// paths enforce identical rules. Throws ChargeRefused when the row isn't
// chargeable; throws plain Error when Square declines.

export class ChargeRefused extends Error {}

export interface ChargeOutcome {
  paymentId: string;
  receiptUrl: string | null;
  amount: number;
  shows: number;
  card: string;
  /** Set when the payment succeeded but recording it in the dashboard failed. */
  warning?: string;
}

export async function executeChargeForRow(row: VerifyRow, chargedBy: string): Promise<ChargeOutcome> {
  if (row.readyToCharge === 0) throw new ChargeRefused("Nothing to charge — no ready shows.");
  const blocks = row.flags.filter((f) => f.level === "block");
  if (blocks.length) throw new ChargeRefused(blocks.map((b) => b.message).join(" "));
  if (!row.match) throw new ChargeRefused("No Square customer matched.");
  const card = row.cards.find((c) => c.wouldCharge);
  if (!card) throw new ChargeRefused("No usable card to charge.");

  const apptIds = row.shows.map((s) => s.apptId).sort();
  // Same client + same exact show set → same key → Square returns the one
  // existing payment instead of creating another. Max 45 chars for Square.
  const idempotencyKey = createHash("sha256")
    .update(`pps:${row.ownerKey}:${apptIds.join(",")}`)
    .digest("hex")
    .slice(0, 45);

  const payment = await createCardPayment({
    customerId: row.match.customerId,
    cardId: card.id,
    amountCents: Math.round(row.amount * 100),
    idempotencyKey,
    note: `PPS ${row.readyToCharge} show${row.readyToCharge === 1 ? "" : "s"} × $${row.fee} — ${row.ownerName} (${row.business})`,
    referenceId: row.ownerKey,
  });

  // Mark every included appointment charged, carrying the Square payment id so
  // any later dispute can be traced back to the exact shows it covered.
  const now = new Date().toISOString();
  const svc = createServiceClient();
  const { error } = await svc.from("ppa_charges").upsert(
    apptIds.map((apptId) => ({
      appt_id: apptId,
      owner_key: row.ownerKey,
      charged: true,
      amount: row.fee,
      charged_at: now,
      charged_by: chargedBy,
      square_payment_id: payment.id,
      note: `Square ${payment.id}`,
      excluded: false,
      exclude_reason: null,
      updated_at: now,
    })),
    { onConflict: "appt_id" }
  );

  return {
    paymentId: payment.id,
    receiptUrl: payment.receiptUrl,
    amount: row.amount,
    shows: row.readyToCharge,
    card: `${card.brand} ••${card.last4}`,
    // The payment went through — a bookkeeping failure must be loud but must
    // NOT read as "charge failed" (an explicit retry is safe thanks to the
    // idempotency key, but the human needs to know money moved).
    ...(error ? {
      warning: `CHARGED $${row.amount} (Square ${payment.id}) but recording it in the dashboard failed: ${error.message}. Mark the appointments charged manually.`,
    } : {}),
  };
}
