import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

/* Fleet-wide "Call Us Today" bar test (engine v91, live 2026-10-01):
   a = bar shown (control), b = bar hidden — the quiz sits higher on the
   first mobile screen. Stuck per visitor via localStorage, recorded on
   every lead as answers.topbar. Because the bar lives on the FIRST
   screen, its effect shows up as MORE COMPLETED SURVEYS: the coin is a
   fair 50/50 at page load, so the a-vs-b lead COUNTS are the completion
   comparison (a skew from 50/50 is the effect). Downstream pay-through
   is reported too, in case trust moves payment. */
const TEST_START = "2026-10-01T13:28:00Z"; // first tagged lead 13:28 UTC

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
      .eq("answers->>topbar", v);
    if (kind === "picked") q = q.or(`picked_time_at.not.is.null,ghl_status.in.(${PAID.join(",")})`);
    if (kind === "paid") q = q.in("ghl_status", PAID);
    const { count: n, error } = await q;
    if (error) throw new Error(error.message);
    return n ?? 0;
  };

  try {
    const [aLeads, aPicked, aPaid, bLeads, bPicked, bPaid, hitsRes] = await Promise.all([
      count("a", "leads"), count("a", "picked"), count("a", "paid"),
      count("b", "leads"), count("b", "picked"), count("b", "paid"),
      /* The coin flips client-side, so page hits carry no variant — but the
         flip is a fair 50/50, so half the total visitors per arm is the
         right denominator for a visitor→lead rate. */
      sb.from("onebox_hits").select("id", { count: "exact", head: true }).gte("created_at", TEST_START),
    ]);
    const visitors = hitsRes.count ?? 0;
    return NextResponse.json({
      since: TEST_START,
      visitors,
      visitorsPerArm: Math.round(visitors / 2),
      a: { leads: aLeads, picked: aPicked, paid: aPaid },
      b: { leads: bLeads, picked: bPicked, paid: bPaid },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
