import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { listAllTransactions } from "@/lib/fanbasis";

export const maxDuration = 120;

// Read-only reconcile: Commas/Fanbasis transactions vs the Deposits sheet
// (mirrored in the `deposits` table). Lists deposit-range payments that exist
// in Commas but never made it into the sheet. Gated by CRON_SECRET — no writes.
//
// Matching is COUNT-BASED per (email + business): a repeat customer with two
// deposits under the same artist must have two sheet rows, else one is missing.
// This catches second deposits that a simple "email seen anywhere" check misses.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
// Product title is "Owner Name - Business Name"; take everything after the 1st dash.
function bizFromProduct(p: string | null): string {
  if (!p) return "";
  const i = p.indexOf("-");
  return norm(i >= 0 ? p.slice(i + 1) : p);
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const since = req.nextUrl.searchParams.get("since") || "2026-06-01";
  const maxAmount = Number(req.nextUrl.searchParams.get("maxAmount") || "100"); // deposit range only

  const txns = await listAllTransactions(new Date(since + "T00:00:00Z").toISOString());

  // Sheet side (the `deposits` table mirrors the Deposits tab). Build multisets
  // keyed by email+biz and name+biz so we can consume one per matched deposit.
  const svc = createServiceClient();
  const { data } = await svc.from("deposits").select("data");
  const emailBiz = new Map<string, number>();
  const nameBiz = new Map<string, number>();
  const emailAny = new Set<string>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of (data ?? []) as Array<{ data: Record<string, unknown> }>) {
    const e = String(r.data?.["Email"] ?? "").trim().toLowerCase();
    const n = norm(String(r.data?.["Full Name"] ?? ""));
    const b = norm(String(r.data?.["Business Name"] ?? ""));
    if (e) { bump(emailBiz, e + "|" + b); emailAny.add(e); }
    if (n) bump(nameBiz, n + "|" + b);
  }

  const missing: typeof txns = [];
  for (const t of txns) {
    if (t.amountDollars != null && t.amountDollars > maxAmount) continue;
    const b = bizFromProduct(t.product);
    const ek = t.email + "|" + b;
    const nk = norm(t.name) + "|" + b;
    if (t.email && (emailBiz.get(ek) ?? 0) > 0) { emailBiz.set(ek, emailBiz.get(ek)! - 1); continue; }
    if (t.name && (nameBiz.get(nk) ?? 0) > 0) { nameBiz.set(nk, nameBiz.get(nk)! - 1); continue; }
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
      // whether this buyer's email exists in the sheet under a DIFFERENT business
      emailSeenElsewhere: t.email ? emailAny.has(t.email) : false,
      transactionId: t.id,
    })),
  });
}
