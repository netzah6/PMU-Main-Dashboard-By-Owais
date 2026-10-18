// Payment Check (owner 2026-10-18): one month of the Financing sheet matched
// against the money that actually moved — Square payments, dashboard
// subscription charges and PPS charges — so the owner only reviews the rows
// that don't line up. The sheet is READ ONLY here; decisions live in
// payment_checks. The owner wants to verify by hand at first and later let
// clean matches confirm on their own (app_settings.payment_check_autoconfirm).
import { createServiceClient } from "@/lib/supabase/server";
import { getSheetsClient, getTabNames } from "@/lib/sheets";
import { normalizeOwnerKey } from "@/lib/normalizers";
import { FINANCING_SHEET_ID, isSkipRow, mapColumns, monthOf, parseUsd } from "@/lib/payments";
import { listAllCustomers, listDisputes, listPaymentsBetween, squareConfigured, type SquareCustomer } from "@/lib/square";
import { peopleKeys } from "@/lib/subscriptions";

type Svc = ReturnType<typeof createServiceClient>;

// The Financing sheet is "… 2026": its month tabs are this year's months.
const SHEET_YEAR = 2026;

export type MonthTab = { month: string; tab: string; label: string };

export type Evidence = {
  kind: "square" | "dashboard" | "pps" | "plan" | "declined" | "scheduled" | "refund" | "chargeback";
  text: string;
  amountCents?: number;
  at?: string;
  receiptUrl?: string | null;
};

export type Category =
  | "declined"     // card failed this month, nothing collected
  | "amount"       // paid, but not the amount on the sheet
  | "unrecorded"   // money came in, sheet doesn't say Paid
  | "norecord"     // sheet says Paid, no payment found
  | "late"         // pay day passed, nothing paid
  | "match"        // paid and the sheet agrees
  | "scheduled"    // Square / dashboard will charge later this month
  | "later"        // pay day still ahead
  | "upfront"      // paid upfront / prepaid plan still running, no payment this month
  | "pps_none"     // PPS client, no appointment charges this month
  | "noamount"     // no monthly amount on the sheet
  | "inactive";    // Paused / Grace / Need More Bookings

export const REVIEW: Category[] = ["declined", "amount", "unrecorded", "norecord", "late"];

export type CheckRow = {
  ownerKey: string;
  name: string;
  usd: number | null;
  sheetStatus: string;
  billing: string;
  payDay: string;
  notes: string;
  paidCents: number;
  evidence: Evidence[];
  category: Category;
  suggested: "paid" | "not_paid" | null;
  /** What the payment sources showed — kept so edits can re-sort a row without re-matching. */
  facts: Facts;
  /** The sheet's own values, before any edit made on the dashboard. */
  sheet: SheetFields;
  /** Fields changed on the dashboard (the sheet itself is never written). */
  edited?: EditField[];
  /** Client added on the dashboard, not on the sheet. */
  added?: boolean;
};

export type Facts = { hasPaid: boolean; covered: boolean; failed: boolean; scheduled: boolean };
export type SheetFields = { usd: number | null; sheetStatus: string; billing: string; payDay: string; notes: string };
export const EDIT_FIELDS = ["usd", "sheetStatus", "billing", "payDay", "notes"] as const;
export type EditField = (typeof EDIT_FIELDS)[number];
export type PaymentEdit = { owner_key: string; client_name: string | null; fields: Partial<Record<EditField, string | number | null>>; added: boolean; hidden: boolean };

/** Sort one row into its bucket from the sheet values + what the sources showed. */
export function categorize(r: SheetFields & { paidCents: number; facts: Facts }, month: string): { category: Category; suggested: CheckRow["suggested"] } {
  const start = `${month}-01`;
  const end = addMonths(start, 1);
  const today = new Date().toISOString().slice(0, 10);
  const isPast = today >= end;
  const dayOfMonth = isPast ? 31 : today >= start ? Number(today.slice(8, 10)) : 0;
  const st = r.sheetStatus.toLowerCase();
  const sheetPaid = st.startsWith("paid");
  const isPps = st === "pps" || st === "ppa";
  const inactive = ["paused", "grace", "need more bookings", "churned", "cancelled", "canceled"].some((w) => st.includes(w));
  const { hasPaid, covered, failed, scheduled } = r.facts;
  const day = /^\d{1,2}$/.test(r.payDay.trim()) ? Number(r.payDay.trim()) : null;
  const amountOff = !!r.usd && r.paidCents > 0 && !isPps && Math.abs(r.paidCents / 100 - r.usd) > 1;

  let category: Category;
  if (failed && !hasPaid) category = "declined";
  else if (hasPaid && (sheetPaid || isPps)) category = amountOff ? "amount" : "match";
  else if (hasPaid) category = "unrecorded";
  else if (covered) category = sheetPaid ? "match" : "upfront";
  else if (sheetPaid) category = st.includes("upfront") ? "upfront" : "norecord";
  else if (inactive) category = "inactive";
  else if (isPps) category = "pps_none";
  else if (scheduled) category = "scheduled";
  else if (!r.usd) category = "noamount";
  else if (day != null && day <= dayOfMonth) category = "late";
  else if (day == null && isPast) category = "late";
  else category = "later";

  const suggested = ["match", "amount", "unrecorded"].includes(category) ? "paid"
    : ["declined", "norecord", "late"].includes(category) ? "not_paid" : null;
  return { category, suggested };
}

/** Lay dashboard edits over the sheet values and re-sort the rows.
 *  Removed clients come back separately so they can be restored. */
export function applyEdits(month: string, rows: CheckRow[], edits: PaymentEdit[]): { rows: CheckRow[]; removed: CheckRow[] } {
  const byKey = new Map(edits.map((e) => [e.owner_key, e]));
  const out: CheckRow[] = [];
  const removed: CheckRow[] = [];
  const seen = new Set<string>();
  const noFacts: Facts = { hasPaid: false, covered: false, failed: false, scheduled: false };
  const blank: SheetFields = { usd: null, sheetStatus: "", billing: "", payDay: "", notes: "" };
  // Added since the month was last matched: shown now, matched on the next Refresh.
  const extra = edits.filter((e) => e.added && !rows.some((r) => r.ownerKey === e.owner_key)).map((e): CheckRow => ({
    ownerKey: e.owner_key, name: e.client_name || e.owner_key, ...blank, paidCents: 0, evidence: [],
    category: "noamount", suggested: null, facts: noFacts, sheet: blank, added: true,
  }));
  for (const base of [...rows, ...extra]) {
    if (seen.has(base.ownerKey)) continue;
    seen.add(base.ownerKey);
    const sheet = base.sheet ?? { usd: base.usd, sheetStatus: base.sheetStatus, billing: base.billing, payDay: base.payDay, notes: base.notes };
    const e = byKey.get(base.ownerKey);
    const row: CheckRow = { ...base, ...sheet, sheet, edited: [], added: base.added || e?.added };
    for (const f of EDIT_FIELDS) {
      if (!e || !(f in e.fields)) continue;
      const v = e.fields[f];
      if (f === "usd") row.usd = v === "" || v == null ? null : Number(v);
      else row[f] = String(v ?? "");
      row.edited!.push(f);
    }
    Object.assign(row, categorize(row, month));
    (e?.hidden ? removed : out).push(row);
  }
  return { rows: out, removed };
}

export type UnmatchedPayment = { id: string; customer: string; amountCents: number; at: string; note: string | null; receiptUrl: string | null };

export type MonthPayload = {
  month: string;
  tab: string;
  rows: CheckRow[];
  unmatched: UnmatchedPayment[];
  squareChecked: boolean;
  warnings: string[];
  builtAt: string;
};

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" });
const usDay = (iso: string) => SHORT.format(new Date(iso.length <= 10 ? iso + "T12:00:00Z" : iso));
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "").slice(-10);

/** Month tabs of the Financing sheet, newest first, one per month ("October V2" beats "October"). */
export async function listMonthTabs(): Promise<MonthTab[]> {
  const tabs = await getTabNames(process.env.SHEET5_ID || FINANCING_SHEET_ID);
  const best = new Map<number, string>();
  for (const t of tabs) {
    const m = monthOf(t);
    // Jan–March are an older income ledger with no payment-status column, so
    // there is nothing to check them against; only the V2 client tabs count.
    if (m == null || !/v\d/i.test(t)) continue;
    const prev = best.get(m);
    if (!prev || /v\d/i.test(t) || !/v\d/i.test(prev)) best.set(m, t);
  }
  const now = new Date();
  const cap = now.getUTCFullYear() > SHEET_YEAR ? 12 : now.getUTCMonth() + 1;
  return [...best.entries()]
    .filter(([m]) => m <= cap)
    .sort((a, b) => b[0] - a[0])
    .map(([m, tab]) => {
      const month = `${SHEET_YEAR}-${String(m).padStart(2, "0")}`;
      return { month, tab, label: MONTH_LABEL.format(new Date(`${month}-15T12:00:00Z`)) };
    });
}

type SheetRow = { ownerKey: string; name: string; usd: number | null; status: string; billing: string; payDay: string; notes: string };

async function readMonth(tab: string): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET5_ID || FINANCING_SHEET_ID,
    range: `'${tab}'!A1:H1000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = (res.data.values ?? []) as string[][];
  const cols = mapColumns(rows);
  if (!cols) throw new Error(`No CLIENT NAME header found in "${tab}"`);
  const seen = new Set<string>();
  const out: SheetRow[] = [];
  const cell = (row: string[], i: number) => (i >= 0 ? String(row[i] ?? "").trim() : "");
  for (let i = cols.headerRow + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const name = cell(row, cols.name);
    if (isSkipRow(name)) continue;
    const key = normalizeOwnerKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      ownerKey: key, name,
      usd: cols.usd >= 0 ? parseUsd(row[cols.usd]) : null,
      status: cell(row, cols.payStatus), billing: cell(row, cols.billStatus),
      payDay: cell(row, cols.payDay), notes: cell(row, cols.notes),
    });
  }
  return out;
}

const CADENCE_MONTHS: Record<string, number> = { MONTHLY: 1, EVERY_TWO_MONTHS: 2, QUARTERLY: 3, EVERY_SIX_MONTHS: 6, ANNUAL: 12 };
const CADENCE_LABEL: Record<string, string> = { QUARTERLY: "3-month", EVERY_SIX_MONTHS: "6-month", ANNUAL: "yearly", EVERY_TWO_MONTHS: "2-month" };
function addMonths(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** Match one month. Never writes to the sheet. */
export async function buildMonth(svc: Svc, mt: MonthTab): Promise<MonthPayload> {
  const warnings: string[] = [];
  const sheetRows = await readMonth(mt.tab);
  // Clients added on the dashboard get matched too.
  const { data: addedRows } = await svc.from("payment_edits").select("owner_key, client_name").eq("month", mt.month).eq("added", true);
  for (const a of (addedRows ?? []) as Array<{ owner_key: string; client_name: string | null }>)
    if (!sheetRows.some((r) => r.ownerKey === a.owner_key))
      sheetRows.push({ ownerKey: a.owner_key, name: a.client_name || a.owner_key, usd: null, status: "", billing: "", payDay: "", notes: "" });
  const start = `${mt.month}-01`;
  const end = addMonths(start, 1);
  const today = new Date().toISOString().slice(0, 10);
  const isCurrent = today >= start && today < end;
  // Pacific midnight, so a charge late on the last evening stays in its month.
  const beginTs = `${start}T07:00:00Z`;
  const endTs = `${end}T07:00:00Z`;

  // Which sheet row a normalized name belongs to (partners on one row count too).
  const keyToRow = new Map<string, string>();
  for (const r of sheetRows) {
    keyToRow.set(r.ownerKey, r.ownerKey);
    for (const k of peopleKeys(r.name)) if (!keyToRow.has(k)) keyToRow.set(k, r.ownerKey);
  }
  const rowFor = (name: unknown) => keyToRow.get(normalizeOwnerKey(name)) ?? null;

  const [subQ, ppaQ, masterQ, linkQ, prefQ, snapQ, dsQ] = await Promise.all([
    svc.from("subscription_charges").select("owner_key, amount_cents, status, square_payment_id, receipt_url, error, charged_at")
      .gte("charged_at", beginTs).lt("charged_at", endTs),
    svc.from("ppa_charges").select("owner_key, amount, square_payment_id, charged_at, excluded")
      .eq("charged", true).gte("charged_at", beginTs).lt("charged_at", endTs),
    svc.from("clients_master").select("data"),
    svc.from("client_subscriptions").select("owner_key, square_customer_id"),
    svc.from("ppa_card_prefs").select("owner_key, customer_id"),
    svc.from("square_subscriptions_snapshot").select("payload").order("fetched_at", { ascending: false }).limit(1),
    svc.from("client_subscriptions").select("owner_key, status, next_charge_on, amount_cents").eq("status", "active"),
  ]);
  for (const [name, q] of [["subscription charges", subQ], ["PPS charges", ppaQ], ["Clients Master", masterQ]] as const)
    if (q.error) warnings.push(`Couldn't read ${name}: ${q.error.message}`);

  const ev = new Map<string, Evidence[]>();
  const paid = new Map<string, number>();
  const push = (key: string, e: Evidence) => { ev.set(key, [...(ev.get(key) ?? []), e]); };
  const addPaid = (key: string, cents: number) => paid.set(key, (paid.get(key) ?? 0) + cents);
  const booked = new Set<string>();
  // Square payment id → sheet row, so refunds and chargebacks come off the right client.
  const payOwner = new Map<string, string>();

  // Dashboard subscription charges.
  const okSub = new Set<string>();
  type SubC = { owner_key: string; amount_cents: number; status: string; square_payment_id: string | null; receipt_url: string | null; error: string | null; charged_at: string };
  const subRows = (subQ.data ?? []) as SubC[];
  for (const c of subRows) {
    if (c.square_payment_id) booked.add(c.square_payment_id);
    const key = rowFor(c.owner_key);
    if (!key || c.status !== "succeeded") continue;
    if (c.square_payment_id) payOwner.set(c.square_payment_id, key);
    okSub.add(key);
    addPaid(key, c.amount_cents);
    push(key, { kind: "dashboard", text: `Dashboard charged ${money(c.amount_cents)} on ${usDay(c.charged_at)}`, amountCents: c.amount_cents, at: c.charged_at, receiptUrl: c.receipt_url });
  }
  const fails = new Map<string, { n: number; err: string }>();
  for (const c of subRows) {
    const key = rowFor(c.owner_key);
    if (!key || c.status !== "failed" || okSub.has(key)) continue;
    const f = fails.get(key) ?? { n: 0, err: "" };
    fails.set(key, { n: f.n + 1, err: c.error ?? f.err });
  }

  // PPS appointment charges.
  type PpaC = { owner_key: string; amount: number | string | null; square_payment_id: string | null; charged_at: string; excluded: boolean | null };
  const pps = new Map<string, { n: number; cents: number; last: string }>();
  for (const c of (ppaQ.data ?? []) as PpaC[]) {
    if (c.square_payment_id) booked.add(c.square_payment_id);
    if (c.excluded) continue;
    const key = rowFor(c.owner_key);
    if (!key) continue;
    if (c.square_payment_id) payOwner.set(c.square_payment_id, key);
    const cents = Math.round(Number(c.amount ?? 0) * 100);
    const p = pps.get(key) ?? { n: 0, cents: 0, last: "" };
    pps.set(key, { n: p.n + 1, cents: p.cents + cents, last: c.charged_at > p.last ? c.charged_at : p.last });
  }
  for (const [key, p] of pps) {
    addPaid(key, p.cents);
    push(key, { kind: "pps", text: `${p.n} PPS charge${p.n > 1 ? "s" : ""} (${money(p.cents)}), last ${usDay(p.last)}`, amountCents: p.cents, at: p.last });
  }

  // Square payments not already booked above, tied to a client through their Square customer.
  const unmatched: UnmatchedPayment[] = [];
  let squareChecked = false;
  if (!squareConfigured()) warnings.push("Square isn't connected here, so one-off Square payments weren't checked.");
  else {
    try {
      const payments = await listPaymentsBetween(beginTs, endTs);
      squareChecked = true;
      const custToRow = new Map<string, string | null>(); // null = ambiguous
      const link = (cid: string | null | undefined, key: string | null) => {
        if (!cid || !key) return;
        const prev = custToRow.get(cid);
        custToRow.set(cid, prev === undefined || prev === key ? key : null);
      };
      // Explicit links an admin made win over name matching.
      const explicit = new Map<string, string>();
      for (const r of [...((linkQ.data ?? []) as Array<{ owner_key: string; square_customer_id: string | null }>).map((x) => [x.square_customer_id, x.owner_key] as const),
        ...((prefQ.data ?? []) as Array<{ owner_key: string; customer_id: string | null }>).map((x) => [x.customer_id, x.owner_key] as const)]) {
        const key = rowFor(r[1]);
        if (r[0] && key) explicit.set(r[0], key);
      }
      // Clients Master gives each sheet row an email, phone and business name.
      const byEmail = new Map<string, string>(), byPhone = new Map<string, string>(), byBusiness = new Map<string, string>();
      for (const m of (masterQ.data ?? []) as Array<{ data: Record<string, unknown> }>) {
        const key = rowFor(m.data?.["Owner Full Name"]);
        if (!key) continue;
        const e = String(m.data["Email"] ?? "").trim().toLowerCase();
        const p = digits(m.data["Phone"]);
        const b = normalizeOwnerKey(m.data["Business Name"]);
        if (e) byEmail.set(e, key);
        if (p.length === 10) byPhone.set(p, key);
        if (b) byBusiness.set(b, key);
      }
      const need = new Set(payments.filter((p) => p.customerId && !booked.has(p.id)).map((p) => p.customerId as string));
      let customers: SquareCustomer[] = [];
      if (need.size) {
        const all = await listAllCustomers();
        customers = all.customers.filter((c) => need.has(c.id));
        if (all.truncated) warnings.push("Square has more customers than the scan reads; a few payments may show as unmatched.");
      }
      const custById = new Map(customers.map((c) => [c.id, c]));
      for (const c of customers) {
        if (explicit.has(c.id)) continue;
        link(c.id, rowFor(c.name));
        if (c.email) link(c.id, byEmail.get(c.email.toLowerCase()) ?? null);
        const p = digits(c.phone);
        if (p.length === 10) link(c.id, byPhone.get(p) ?? null);
        const co = normalizeOwnerKey(c.company);
        if (co) link(c.id, byBusiness.get(co) ?? null);
      }
      for (const [cid, key] of explicit) custToRow.set(cid, key);
      for (const p of payments) {
        if (booked.has(p.id)) continue;
        const key = p.customerId ? custToRow.get(p.customerId) ?? null : null;
        if (!key) {
          const c = p.customerId ? custById.get(p.customerId) : undefined;
          unmatched.push({ id: p.id, customer: c?.name ?? "No customer on payment", amountCents: p.amountCents, at: p.createdAt, note: p.note, receiptUrl: p.receiptUrl });
          continue;
        }
        payOwner.set(p.id, key);
        addPaid(key, p.amountCents);
        push(key, { kind: "square", text: `Square payment ${money(p.amountCents)} on ${usDay(p.createdAt)}`, amountCents: p.amountCents, at: p.createdAt, receiptUrl: p.receiptUrl });
      }
      // Refunds come off what the client paid, whichever way the payment was made.
      for (const p of payments) {
        const key = payOwner.get(p.id);
        if (!key || !p.refundedCents) continue;
        addPaid(key, -p.refundedCents);
        push(key, { kind: "refund", text: `Refunded ${money(p.refundedCents)} of the ${usDay(p.createdAt)} payment`, amountCents: -p.refundedCents });
      }
      // Chargebacks on this month's payments, unless we won them.
      try {
        for (const d of await listDisputes()) {
          const key = d.paymentId ? payOwner.get(d.paymentId) : undefined;
          if (!key || d.state === "WON") continue;
          addPaid(key, -d.amountCents);
          push(key, { kind: "chargeback", text: `Chargeback ${money(d.amountCents)} (${d.state.toLowerCase().replace(/_/g, " ")})`, amountCents: -d.amountCents });
        }
      } catch (e) {
        warnings.push(`Couldn't read Square chargebacks: ${String(e).slice(0, 120)}`);
      }
    } catch (e) {
      warnings.push(`Couldn't read Square payments: ${String(e).slice(0, 160)}`);
    }
  }

  // Square subscriptions: a 3/6/12-month plan paid earlier still covers this
  // month; a monthly one that renews later this month is just not due yet.
  type SnapSub = { customerName: string; customerEmail: string | null; status: string; cadence: string; amountCents: number | null; chargedThroughDate: string | null };
  const snap = ((snapQ.data?.[0] as { payload?: { subscriptions?: SnapSub[] } } | undefined)?.payload?.subscriptions ?? []);
  const scheduled = new Map<string, string>();
  const covered = new Set<string>(); // prepaid plan still running — no new money expected
  for (const s of snap) {
    if (!s.chargedThroughDate || !["ACTIVE", "PAUSE SCHEDULED", "PAUSED"].includes(s.status)) continue;
    const key = rowFor(s.customerName);
    if (!key) continue;
    const months = CADENCE_MONTHS[s.cadence];
    if (!months) continue;
    const thru = s.chargedThroughDate;
    const lastCharge = addMonths(addDays(thru, 1), -months);
    // A plan that ran out mid-month renews with a new payment, which the
    // Square step above already sees — so it only "covers" the month when it
    // reaches the month's last day (or today, for the current month).
    const lastDay = addDays(end, -1);
    const needThru = isCurrent && today < lastDay ? today : lastDay;
    if (months > 1 && lastCharge < start && thru >= needThru && !paid.has(key) && !covered.has(key)) {
      covered.add(key);
      push(key, { kind: "plan", text: `Square ${CADENCE_LABEL[s.cadence] ?? ""} plan${s.amountCents ? ` ${money(s.amountCents)}` : ""} paid ${usDay(lastCharge)}, covers to ${usDay(thru)}` });
    }
    const renew = addDays(thru, 1);
    if (isCurrent && s.status === "ACTIVE" && renew > today && renew < end) scheduled.set(key, `Square renews ${usDay(renew)}`);
  }
  if (isCurrent) for (const d of (dsQ.data ?? []) as Array<{ owner_key: string; next_charge_on: string | null }>) {
    const key = rowFor(d.owner_key);
    if (key && d.next_charge_on && d.next_charge_on >= today && d.next_charge_on < end && !scheduled.has(key))
      scheduled.set(key, `Dashboard charges ${usDay(d.next_charge_on)}`);
  }

  const rows: CheckRow[] = sheetRows.map((r) => {
    const evidence = [...(ev.get(r.ownerKey) ?? [])];
    const hasPaid = paid.has(r.ownerKey);
    const fail = fails.get(r.ownerKey);
    if (fail && !hasPaid) evidence.push({ kind: "declined", text: `Card declined ${fail.n}× this month${fail.err ? ` (${fail.err.replace(/^Square payment failed \(\d+\):\s*/, "").slice(0, 70)})` : ""}` });
    const sched = scheduled.get(r.ownerKey);
    if (sched && !hasPaid) evidence.push({ kind: "scheduled", text: sched });
    const sheet: SheetFields = { usd: r.usd, sheetStatus: r.status, billing: r.billing, payDay: r.payDay, notes: r.notes };
    const facts: Facts = { hasPaid, covered: covered.has(r.ownerKey), failed: !!fail, scheduled: !!sched };
    const paidCents = paid.get(r.ownerKey) ?? 0;
    return { ownerKey: r.ownerKey, name: r.name, ...sheet, paidCents, evidence, facts, sheet, ...categorize({ ...sheet, paidCents, facts }, mt.month) };
  });

  unmatched.sort((a, b) => b.at.localeCompare(a.at));
  return { month: mt.month, tab: mt.tab, rows, unmatched, squareChecked, warnings, builtAt: new Date().toISOString() };
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function autoconfirmEnabled(svc: Svc): Promise<boolean> {
  const { data } = await svc.from("app_settings").select("value").eq("key", "payment_check_autoconfirm").maybeSingle();
  return (data?.value as { enabled?: boolean } | null)?.enabled === true;
}
