import { createServiceClient } from "@/lib/supabase/server";

// Direct row intake for the sheet-backed activity tables.
//
// Why this exists: leads, bookings, outgoing calls and deposits all live in the
// "PMU Data (Synced)" workbook, which reads pathologically slowly — even a
// 3-row header read can hang for 10+ minutes, so the 15-minute sheet cron
// leaves those tables hours stale (measured: 2h for leads, 4.5h for calls).
// WRITING to that workbook still works fine, so Make.com keeps writing each new
// row to the sheet as a free backup and ALSO posts it straight here.
//
// Rows written here are shaped EXACTLY like sheet-synced rows, so every existing
// consumer (the Leads/Bookings/Calls/Deposits tabs, the normalizers, realtime)
// works unchanged. `sheet_row` stays NULL unless the caller tells us the real
// one; `external_id` is the idempotency key.

export type IngestTable =
  | "deposits"
  | "leads_master"
  | "bookings"
  | "outgoing_calls"
  | "signed_agreements";

// Accept the sheet tab name, the table name, and the obvious short forms, so
// whatever a Make module happens to send lands on the right table.
const TABLE_ALIASES: Record<string, IngestTable> = {
  deposit: "deposits", deposits: "deposits",
  lead: "leads_master", leads: "leads_master", leadsmaster: "leads_master",
  booking: "bookings", bookings: "bookings", bookingsmaster: "bookings",
  call: "outgoing_calls", calls: "outgoing_calls",
  outgoingcall: "outgoing_calls", outgoingcalls: "outgoing_calls", outgoingcallmaster: "outgoing_calls",
  agreement: "signed_agreements", agreements: "signed_agreements", signedagreements: "signed_agreements",
};

export function resolveTable(raw: unknown): IngestTable | null {
  const k = String(raw ?? "").toLowerCase().replace(/[^a-z]+/g, "");
  return TABLE_ALIASES[k] ?? null;
}

/** Accept the first non-empty value among several possible field names. */
export function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function parseDate(raw: string): Date | null {
  if (!raw) return null;
  // DD/MM/YYYY and D/M/YYYY are ambiguous with the US order Date() assumes, so
  // parse them by hand. Everything else (ISO, RFC) goes through Date().
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// The studio's calendar day, not the server's. Make and the Google Sheets module
// both write the org-local date; formatting the same moment in UTC put every
// record created between 8pm Eastern and midnight UTC on the FOLLOWING day. The
// sheet said Aug 7, the webhook said Aug 8, the fingerprints stopped matching,
// and the same call was stored twice.
// US Pacific — confirmed as the Make organisation's timezone, which is what the
// Google Sheets module stamps rows with. Keep these in step: if the Make org
// timezone ever changes, this must change with it or direct rows and sheet rows
// will disagree by a day again.
const BUSINESS_TZ = "America/Los_Angeles";

/**
 * Calendar parts for a value.
 *
 * A bare DD/MM/YYYY has no time in it, so it is passed straight through — the
 * caller already decided which day it means. Only an instant (an ISO timestamp,
 * or "now") gets resolved through the studio's timezone.
 */
function dateParts(raw: string): { y: number; m: number; d: number } {
  const lit = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (lit) return { d: Number(lit[1]), m: Number(lit[2]), y: Number(lit[3]) };

  const parsed = raw ? parseDate(raw) : null;
  const at = parsed ?? new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** "07/08/2026" — zero-padded, used by the Deposits tab and the col_6 column. */
export function toPaddedDate(raw: string): string {
  const { y, m, d } = dateParts(raw);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d)}/${p(m)}/${y}`;
}

/** "7/8/2026" — unpadded, the format the Leads/Bookings/Calls tabs store. */
function toLooseDate(raw: string): string {
  const { y, m, d } = dateParts(raw);
  return `${d}/${m}/${y}`;
}

/** Sheet rows store amounts as "$50" — match that. */
export function toSheetAmount(raw: string): string {
  if (!raw) return "";
  const t = raw.trim();
  if (t.startsWith("$")) return t;
  const n = Number(t.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? t : `$${n % 1 === 0 ? n : n.toFixed(2)}`;
}

// The sheet stores phone numbers as bare numbers (14703579451), not strings.
// Keep that so a direct row and its sheet twin compare equal.
function toPhone(raw: string): string | number {
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return "";
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : digits;
}

export interface IngestInput {
  fullName: string;
  email: string;
  phone: string;
  business: string;
  date: string;
  amount: string;
  productId: string;
  source: string;
}

/** Pull the common fields out of whatever shape the caller sent. */
export function readInput(body: Record<string, unknown>): IngestInput {
  const first = pick(body, ["first_name", "firstName", "contact_first_name"]);
  const last = pick(body, ["last_name", "lastName", "contact_last_name"]);
  return {
    fullName:
      pick(body, ["Full Name", "full_name", "fullName", "name", "contact_name", "customer_name"]) ||
      [first, last].filter(Boolean).join(" "),
    email: pick(body, ["Email", "email", "contact_email", "customer_email"]),
    phone: pick(body, ["Phone Number", "phone_number", "phone", "phoneNumber", "contact_phone"]),
    business: pick(body, [
      "Business Name", "business_name", "businessName", "location_name", "locationName", "business",
    ]),
    date: pick(body, ["Date", "date", "created_at", "createdAt", "timestamp", "date_created", "Signed Date"]),
    amount: pick(body, ["Amount", "amount", "price", "total", "value"]),
    productId: pick(body, ["Product ID", "product_id", "productId", "product"]),
    source: pick(body, ["Source", "source"]),
  };
}

/**
 * Build the row body for a table, matching its sheet columns exactly.
 *
 * The Leads / Bookings / Outgoing Call tabs share one layout, including two
 * concatenation columns the sheet computes as dedupe keys and a handful of
 * trailing blanks. The dashboard's normalizers only read Full Name / Email /
 * Phone Number / Business Name / Date, but the extra columns are reproduced so
 * a direct row is byte-comparable with the sheet twin the cron may later fetch.
 */
export function buildRow(table: IngestTable, v: IngestInput): Record<string, unknown> {
  if (table === "deposits") {
    return {
      "Date": toPaddedDate(v.date),
      "Email": v.email,
      "Amount": toSheetAmount(v.amount),
      "Source": v.source || "Fanbasis",
      "Full Name": v.fullName,
      "Product ID": v.productId,
      "Business Name": v.business,
    };
  }

  if (table === "signed_agreements") {
    return { "Full Name": v.fullName, "Signed Date": toPaddedDate(v.date) };
  }

  const phone = toPhone(v.phone);
  const row: Record<string, unknown> = {
    "Date": toLooseDate(v.date),
    "Full Name": v.fullName,
    "Phone Number": phone,
    "Email": v.email,
    "Business Name": v.business,
    "Business Name_2": "",
    "col_6": toPaddedDate(v.date),
    "Full NamePhone NumberBusiness Name": `${v.fullName}${phone}${v.business}`,
    "Full NamePhone NumberBusiness Name_2": "",
  };
  // Bookings and Outgoing Call Master carry five trailing blank columns.
  if (table !== "leads_master") for (const c of [8, 9, 10, 11, 12]) row[`col_${c}`] = "";
  return row;
}

/**
 * Content fingerprint used to recognise the same record arriving twice — once
 * directly and once through the sheet. Deliberately built from the identifying
 * columns only, so formatting differences in the trailing/computed columns
 * don't stop a match.
 */
export function fingerprint(table: IngestTable, row: Record<string, unknown>): string {
  const n = (x: unknown) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const parts = [
    n(row["Full Name"]),
    n(row["Email"]),
    n(row["Phone Number"]),
    n(row["Business Name"]),
    n(row["Date"] ?? row["Signed Date"]),
  ];
  if (table === "deposits") parts.push(n(row["Amount"]));
  return `${table}|${parts.join("|")}`;
}

export interface IngestResult {
  ok: boolean;
  action?: "recorded" | "matched-existing";
  table?: IngestTable;
  externalId?: string;
  row?: Record<string, unknown>;
  error?: string;
  status?: number;
}

export async function ingestRow(table: IngestTable, body: Record<string, unknown>): Promise<IngestResult> {
  const v = readInput(body);

  if (!v.fullName && !v.email && !v.phone) {
    return { ok: false, status: 400, error: "need at least a name, email or phone to record a row" };
  }

  const row = buildRow(table, v);

  // Idempotency: prefer a real upstream id; otherwise derive a stable key so a
  // retried webhook can never create a second row for the same record.
  const externalId =
    pick(body, [
      "external_id", "transaction_id", "transactionId", "payment_id",
      "contact_id", "contactId", "appointment_id", "id", "charge_id",
    ]) || `derived:${fingerprint(table, row)}`;

  const supabase = createServiceClient();
  const now = new Date().toISOString();

  // The dashboard sorts newest-first by data.row_number (sortNewestFirst in
  // lib/utils), so a row without one sinks to the bottom — saved but invisible.
  //
  // max_row_number() is a SQL function rather than an order+limit query: doing
  // it through PostgREST (order=data->row_number.desc) silently returned no row
  // from supabase-js while the identical raw REST call worked, which produced
  // row_number 1 with no error to notice. Errors here are fatal on purpose — a
  // wrong row number is worse than a rejected webhook, because the row lands
  // looking fine and is simply never seen.
  // A retried webhook must not move the row: reuse the number it already holds,
  // otherwise re-delivering an old record jumps it to the top of the tab.
  const { data: already } = await supabase
    .from(table)
    .select("data")
    .eq("external_id", externalId)
    .limit(1);
  const priorRow = Number((already?.[0]?.data as Record<string, unknown> | null)?.row_number) || null;

  const givenRow = Number(pick(body, ["row_number", "rowNumber", "sheet_row"])) || null;
  let rowNumber = givenRow ?? priorRow ?? 0;
  if (!rowNumber) {
    const { data: max, error: maxErr } = await supabase.rpc("max_row_number", { tbl: table });
    if (maxErr) return { ok: false, status: 500, error: `row number lookup failed: ${maxErr.message}` };
    rowNumber = Math.floor(Number(max) || 0) + 1;
  }
  row.row_number = rowNumber;

  // If the sheet path already delivered this record, adopt that row rather than
  // creating a duplicate — both paths run in parallel by design.
  //
  // Narrow on ONE identifying field before comparing fingerprints, and pick a
  // field that is actually indexed. Order matters: the funnel that feeds this is
  // "Phone Number Only Leads", so email is usually absent and phone is the
  // reliable identifier. Falling through to the name was a sequential scan of
  // 38k rows (measured: 8.4s), which timed the webhook out and filled Make's
  // incomplete-executions queue.
  const fp = fingerprint(table, row);
  let q = supabase.from(table).select("id, data").is("external_id", null).limit(50);
  if (v.email) q = q.eq("data->>Email", v.email);
  else if (v.phone) q = q.eq("data->>Phone Number", String(toPhone(v.phone)));
  else q = q.eq("data->>Full Name", v.fullName);
  const { data: candidates, error: twinErr } = await q;
  // A slow or failed duplicate check must not lose the row: fall through and
  // write it. external_id still guards against the same delivery arriving twice.
  if (twinErr) console.warn("direct-ingest: duplicate check failed:", twinErr.message);
  const twin = (candidates ?? []).find(
    (r) => fingerprint(table, (r.data ?? {}) as Record<string, unknown>) === fp
  );
  if (twin) {
    await supabase.from(table).update({ external_id: externalId, synced_at: now }).eq("id", twin.id);
    return { ok: true, action: "matched-existing", table, externalId };
  }

  const { error } = await supabase.from(table).upsert(
    // sheet_row is set only when the caller told us the real sheet row, so a
    // later sheet sync upserts onto this row rather than creating a twin. Left
    // NULL otherwise (a plain unique index allows many NULLs).
    { external_id: externalId, sheet_row: givenRow, data: row, synced_at: now },
    { onConflict: "external_id" }
  );
  if (error) return { ok: false, status: 500, error: error.message };

  return { ok: true, action: "recorded", table, externalId, row };
}
