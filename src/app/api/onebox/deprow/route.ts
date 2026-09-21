import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

/* Fleet-wide deposit-row wording test (engine v89, live 2026-09-21):
   every visitor is stuck to side "a" (the original guarantee line) or
   "b" (the secure-green wallet line) via localStorage, and every lead
   submission records that side in answers.deprow. It runs on every
   funnel at once — independent of the per-slug experiment system — so
   its readout is fleet-wide too: population = leads that picked a time,
   success = paid the deposit. */
const TEST_START = "2026-09-21T20:00:00Z"; // first tagged lead 20:56 UTC

// Same definition of "paid" as onebox-insights (paid-followup = via the
// AI's payment link — the deposit row is shown on that path too).
const PAID = ["booked", "paid", "paid-not-booked", "paid-followup"];

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sb = createServiceClient();
  const count = async (v: "a" | "b", kind: "leads" | "picked" | "paid") => {
    let q = sb
      .from("onebox_leads")
      .select("id", { count: "exact", head: true })
      .gte("created_at", TEST_START)
      .eq("answers->>deprow", v);
    if (kind === "picked") q = q.or(`picked_time_at.not.is.null,ghl_status.in.(${PAID.join(",")})`);
    if (kind === "paid") q = q.in("ghl_status", PAID);
    const { count: n, error } = await q;
    if (error) throw new Error(error.message);
    return n ?? 0;
  };

  try {
    const [aLeads, aPicked, aPaid, bLeads, bPicked, bPaid] = await Promise.all([
      count("a", "leads"), count("a", "picked"), count("a", "paid"),
      count("b", "leads"), count("b", "picked"), count("b", "paid"),
    ]);
    return NextResponse.json({
      since: TEST_START,
      a: { leads: aLeads, picked: aPicked, paid: aPaid },
      b: { leads: bLeads, picked: bPicked, paid: bPaid },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
