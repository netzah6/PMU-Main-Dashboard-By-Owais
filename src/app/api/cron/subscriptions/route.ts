import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { autochargeEnabled, chargePeriod, chargeSubscription, priceForPeriod, type Subscription } from "@/lib/subscriptions";

export const maxDuration = 300;

// Daily run for dashboard subscriptions. It charges ONLY subscriptions an
// admin has activated, and only while the global autocharge switch is on —
// which ships off. With the switch off it reports what it would have charged
// and moves no money, so the schedule can be watched for a cycle first.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronOk = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const auth = await getAuth();
    if (!auth || auth.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createServiceClient();
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await svc
    .from("client_subscriptions").select("*")
    .eq("status", "active").lte("next_charge_on", today);
  const due = (data ?? []) as Subscription[];

  const enabled = await autochargeEnabled(svc);
  if (!enabled) {
    return NextResponse.json({
      autocharge: false,
      wouldCharge: await Promise.all(due.map(async (s) => ({
        owner: s.client_label ?? s.owner_key,
        amount: (await priceForPeriod(svc, s, chargePeriod(s, today))).amountCents / 100,
        due: s.next_charge_on,
      }))),
      note: "Autocharge is off — nothing was charged.",
    });
  }

  const results = [];
  for (const sub of due) {
    const r = await chargeSubscription(svc, sub, today, "cron");
    results.push({
      owner: sub.client_label ?? sub.owner_key,
      amount: r.ok ? r.amountCents / 100 : (await priceForPeriod(svc, sub, chargePeriod(sub, today))).amountCents / 100,
      ...(r.ok ? { charged: true, paymentId: r.paymentId } : { charged: false, error: r.error }),
    });
  }
  return NextResponse.json({ autocharge: true, due: due.length, results });
}
