import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { listAllTransactions } from "@/lib/fanbasis";

export const maxDuration = 120;

// Read-only reconcile: Commas/Fanbasis transactions vs the Deposits sheet
// (mirrored in the `deposits` table). Lists deposit-range payments that exist
// in Commas but never made it into the sheet. Gated by CRON_SECRET — no writes.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const since = req.nextUrl.searchParams.get("since") || "2026-06-01";
  const maxAmount = Number(req.nextUrl.searchParams.get("maxAmount") || "100"); // deposit range only

  // Commas side
  const txns = await listAllTransactions(new Date(since + "T00:00:00Z").toISOString());

  // Sheet side (the `deposits` table mirrors the Deposits tab)
  const svc = createServiceClient();
  const { data } = await svc.from("deposits").select("data");
  const emailSet = new Set<string>();
  const nameSet = new Set<string>();
  for (const r of (data ?? []) as Array<{ data: Record<string, unknown> }>) {
    const e = String(r.data?.["Email"] ?? "").trim().toLowerCase();
    const n = norm(String(r.data?.["Full Name"] ?? ""));
    if (e) emailSet.add(e);
    if (n) nameSet.add(n);
  }

  // Missing = deposit-range Commas payment whose buyer isn't in the sheet at all.
  const missing = txns
    .filter((t) => t.amountDollars == null || t.amountDollars <= maxAmount)
    .filter((t) => {
      const inByEmail = t.email && emailSet.has(t.email);
      const inByName = t.name && nameSet.has(norm(t.name));
      return !inByEmail && !inByName;
    })
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));

  return NextResponse.json({
    since, maxAmount,
    commasTransactions: txns.length,
    sheetDeposits: emailSet.size,
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
