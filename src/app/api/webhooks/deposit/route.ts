import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

// Direct deposit intake: GHL / Fanbasis POST straight here, we write straight to
// Supabase. No Google Sheet in the path.
//
// Why this exists: the "PMU Data (Synced)" workbook became unreadable — the
// Vercel cron, a plain Sheets API call, and even Apps Script running *inside*
// the file all time out (400s+ without returning). Deposits are the most
// time-sensitive data in the dashboard, so they no longer depend on that file.
//
// The row we write is shaped EXACTLY like a sheet-synced row, so every existing
// consumer (Deposits tab, PPS billing, cost-per-deposit, realtime) works
// unchanged. sheet_row stays null; external_id is the idempotency key.

export const maxDuration = 30;

/** Accept the first non-empty value among several possible field names. */
function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/** Sheet rows store dates as DD/MM/YYYY — match that exactly. */
function toSheetDate(raw: string): string {
  if (!raw) return new Date().toLocaleDateString("en-GB");
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return raw; // already DD/MM/YYYY
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Sheet rows store amounts as "$50" — match that. */
function toSheetAmount(raw: string): string {
  if (!raw) return "";
  const t = raw.trim();
  if (t.startsWith("$")) return t;
  const n = Number(t.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? t : `$${n % 1 === 0 ? n : n.toFixed(2)}`;
}

export async function POST(req: NextRequest) {
  // Shared-secret auth. Accepts a dedicated secret, or falls back to CRON_SECRET
  // so this works without provisioning a new env var first.
  const expected = process.env.DEPOSIT_WEBHOOK_SECRET || process.env.CRON_SECRET;
  if (expected) {
    const got =
      req.headers.get("x-webhook-secret") ||
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
      new URL(req.url).searchParams.get("secret") ||
      "";
    if (got !== expected) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // GHL/Fanbasis payloads vary in shape — accept the common spellings.
  const first = pick(body, ["first_name", "firstName", "contact_first_name"]);
  const last = pick(body, ["last_name", "lastName", "contact_last_name"]);
  const fullName =
    pick(body, ["Full Name", "full_name", "fullName", "name", "contact_name", "customer_name"]) ||
    [first, last].filter(Boolean).join(" ");

  const email = pick(body, ["Email", "email", "contact_email", "customer_email"]);
  const business = pick(body, [
    "Business Name", "business_name", "businessName", "location_name", "locationName", "business",
  ]);
  const amount = toSheetAmount(pick(body, ["Amount", "amount", "price", "total", "value"]));
  const productId = pick(body, ["Product ID", "product_id", "productId", "product"]);
  const date = toSheetDate(pick(body, ["Date", "date", "created_at", "createdAt", "timestamp"]));
  const source = pick(body, ["Source", "source"]) || "Fanbasis";

  if (!fullName && !email) {
    return NextResponse.json(
      { error: "need at least a name or an email to record a deposit" },
      { status: 400 }
    );
  }

  // Idempotency: prefer a real transaction id; otherwise derive a stable key so
  // a retried webhook can never create a second row for the same deposit.
  const externalId =
    pick(body, ["external_id", "transaction_id", "transactionId", "payment_id", "id", "charge_id"]) ||
    `derived:${email.toLowerCase()}|${amount}|${date}|${productId}`;

  const supabase = createServiceClient();
  const now = new Date().toISOString();

  // The dashboard sorts deposits newest-first by data.row_number (see
  // sortNewestFirst in lib/utils). Without one, a direct row falls back to 0 and
  // sinks below every sheet-sourced row — invisible in practice.
  //
  // Make sends the row number the Google Sheets module just created, so the
  // direct row lines up exactly with its sheet twin: it sorts correctly AND a
  // later sheet sync upserts onto the same row instead of duplicating it.
  // Without it, fall back to one past the current highest.
  const sheetRowFromMake = Number(pick(body, ["row_number", "rowNumber", "sheet_row"])) || null;
  let rowNumber = sheetRowFromMake ?? 0;
  if (!rowNumber) {
    // Order by the row number itself, not by synced_at: a sheet sync stamps every
    // row with an identical synced_at, so "most recently synced" returns an
    // arbitrary slice and the max found there can be hundreds of rows too low.
    // row_number is stored as a JSON *number* on every row, so `data->row_number`
    // sorts numerically.
    const { data: top } = await supabase
      .from("deposits")
      .select("data")
      .order("data->row_number", { ascending: false })
      .limit(1);
    const highest = Number((top?.[0]?.data as Record<string, unknown> | null)?.row_number) || 0;
    rowNumber = highest + 1;
  }

  const data: Record<string, string | number> = {
    "Date": date,
    "Email": email,
    "Amount": amount,
    "Source": source,
    "Full Name": fullName,
    "Product ID": productId,
    "Business Name": business,
    row_number: rowNumber,
  };

  // If the same deposit already arrived via the sheet, adopt that row instead of
  // creating a duplicate — the sheet path may still be running in parallel.
  if (email && amount) {
    const { data: twin } = await supabase
      .from("deposits")
      .select("id, external_id")
      .is("external_id", null)
      .eq("data->>Email", email)
      .eq("data->>Amount", amount)
      .eq("data->>Date", date)
      .limit(1);

    if (twin && twin.length > 0) {
      await supabase
        .from("deposits")
        .update({ external_id: externalId, synced_at: now })
        .eq("id", twin[0].id);
      return NextResponse.json({ ok: true, action: "matched-existing", externalId });
    }
  }

  const { error } = await supabase
    .from("deposits")
    .upsert(
      // sheet_row is set only when Make told us the real sheet row, so a later
      // sheet sync upserts onto this row rather than creating a twin. Left NULL
      // otherwise (Postgres allows many NULLs in a unique index).
      { external_id: externalId, sheet_row: sheetRowFromMake, data, synced_at: now },
      { onConflict: "external_id" }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, action: "recorded", externalId, deposit: data });
}

// Lets you confirm the endpoint is live from a browser without sending data.
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "deposit intake",
    method: "POST",
    auth: "x-webhook-secret header (or ?secret=)",
    accepts: ["Full Name / first_name+last_name", "Email", "Amount", "Business Name", "Product ID", "Date", "external_id"],
  });
}
