import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

/* Readout for A/B pair #2 (engine v93, coins start 2026-10-13T07:00Z):
     scar   — slot scarcity: a = up to 5 slots/day shown, b = up to 3.
     shortq — survey length: a = full survey, b = 3 questions dropped.
   Variants are recorded on every lead as answers.scar / answers.shortq.
   Visitors aren't tagged (the coins flip client-side), but each flip is a
   fair 50/50, so half the funnel hits since the start date is the right
   per-arm denominator — same approach as the phone-bar card. */
const TEST_START = "2026-10-13T07:00:00Z";

const PAID = ["booked", "paid", "paid-not-booked", "paid-followup"];

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sb = createServiceClient();
  const count = async (tag: "scar" | "shortq", v: "a" | "b", kind: "leads" | "picked" | "paid") => {
    let q = sb
      .from("onebox_leads")
      .select("id", { count: "exact", head: true })
      .gte("created_at", TEST_START)
      .eq(`answers->>${tag}`, v);
    if (kind === "picked") q = q.or(`picked_time_at.not.is.null,ghl_status.in.(${PAID.join(",")})`);
    if (kind === "paid") q = q.in("ghl_status", PAID);
    const { count: n, error } = await q;
    if (error) throw new Error(error.message);
    return n ?? 0;
  };

  try {
    const started = Date.now() >= Date.parse(TEST_START);
    if (!started) return NextResponse.json({ since: TEST_START, started: false });
    const side = async (tag: "scar" | "shortq", v: "a" | "b") => ({
      leads: await count(tag, v, "leads"),
      picked: await count(tag, v, "picked"),
      paid: await count(tag, v, "paid"),
    });
    const [scarA, scarB, shortA, shortB, hitsRes] = await Promise.all([
      side("scar", "a"), side("scar", "b"), side("shortq", "a"), side("shortq", "b"),
      sb.from("onebox_hits").select("id", { count: "exact", head: true }).gte("created_at", TEST_START),
    ]);
    return NextResponse.json({
      since: TEST_START,
      started: true,
      visitorsPerArm: Math.round((hitsRes.count ?? 0) / 2),
      scar: { a: scarA, b: scarB },
      shortq: { a: shortA, b: shortB },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
