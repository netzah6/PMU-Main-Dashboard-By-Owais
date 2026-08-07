import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { listAllTransactions } from "@/lib/fanbasis";

export const maxDuration = 120;

// Read-only reconcile: Commas/Fanbasis transactions vs the Deposits sheet
// (mirrored in the `deposits` table). Lists deposit-range payments that exist
// in Commas but never made it into the sheet. Gated by CRON_SECRET — no writes.
//
// Matching is COUNT-BASED on the buyer's email: a repeat customer with two
// deposits must have two sheet rows, else one is missing. This catches second
// deposits that a simple "email seen anywhere" check misses.
//
// Business name is deliberately NOT part of the key. It used to be, derived from
// the product title ("Owner Name - Business Name") by splitting on the first
// dash — but that breaks on hyphenated owner names ("Fatima Al-Zeheri",
// "Generose Danao-Uy", "Rachel Tate-Study") and on ad-account suffixes
// ("GlamourEyes & More - Ad Account 2"), where the sheet stores a shorter name.
// The result was 26 false positives out of 28 flagged rows. Email is unique
// enough on its own; the product title is still reported for context.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const since = req.nextUrl.searchParams.get("since") || "2026-06-01";
  const maxAmount = Number(req.nextUrl.searchParams.get("maxAmount") || "100"); // deposit range only

  const txns = await listAllTransactions(new Date(since + "T00:00:00Z").toISOString());

  // Sheet side (the `deposits` table mirrors the Deposits tab). Build multisets
  // keyed by email and by normalized name, so we consume one per matched deposit.
  // .range() is explicit: PostgREST caps an unbounded select at 1000 rows, and
  // silently truncating the sheet side would invent "missing" deposits.
  const svc = createServiceClient();
  const { data } = await svc.from("deposits").select("data").range(0, 49999);
  const byEmail = new Map<string, number>();
  const byName = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of (data ?? []) as Array<{ data: Record<string, unknown> }>) {
    const e = String(r.data?.["Email"] ?? "").trim().toLowerCase();
    const n = norm(String(r.data?.["Full Name"] ?? ""));
    if (e) bump(byEmail, e);
    if (n) bump(byName, n);
  }

  const missing: typeof txns = [];
  for (const t of txns) {
    if (t.amountDollars != null && t.amountDollars > maxAmount) continue;
    const nk = norm(t.name);
    if (t.email && (byEmail.get(t.email) ?? 0) > 0) { byEmail.set(t.email, byEmail.get(t.email)! - 1); continue; }
    // Name fallback: the sheet occasionally stores a different buyer name than
    // Commas does for the same payment (e.g. the cardholder vs the lead).
    if (nk && (byName.get(nk) ?? 0) > 0) { byName.set(nk, byName.get(nk)! - 1); continue; }
    missing.push(t);
  }
  missing.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));

  return NextResponse.json({
    since, maxAmount,
    commasTransactions: txns.length,
    sheetDepositRows: (data ?? []).length,
    missingCount: missing.length,
    missing: missing.map((t) => ({
      name: t.name || "(no name)",
      email: t.email || "(no email)",
      amount: t.amountDollars,
      date: t.createdAt,
      product: t.product,
      transactionId: t.id,
    })),
  });
}
