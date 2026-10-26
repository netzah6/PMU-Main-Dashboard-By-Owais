import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

/* Readout for A/B pair #2 (engine v93, coins start 2026-10-13T07:00Z):
     scar    — slot scarcity: a = up to 5 slots/day shown, b = up to 3.
     shortq2 — survey length: a = full survey, b = commutable + aftercare
               questions dropped (owner's cut, 2026-10-13; the first draft
               — tagged plain "shortq", dropped had_pmu/age instead — ran
               for a few hours on Oct 13 and is excluded by the new tag).
   Variants are recorded on every lead as answers.scar / answers.shortq2.
   Visitors aren't tagged (the coins flip client-side), but each flip is a
   fair 50/50, so half the funnel hits since a test's start is the right
   per-arm denominator — same approach as the phone-bar card. shortq2
   started at its own deploy, so its start = its first tagged lead. */
const TEST_START = "2026-10-13T07:00:00Z";
/* Scarcity locked to "b" on 10/26/2026 (owner): every lead after this moment
   carries scar:"b" by default, so the test's numbers stop here. */
const SCAR_END = "2026-10-26T02:40:09-07:00";

const PAID = ["booked", "paid", "paid-not-booked", "paid-followup"];

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sb = createServiceClient();
  const count = async (tag: "scar" | "shortq2" | "offer3", v: "a" | "b" | "c", since: string, kind: "leads" | "picked" | "paid", until?: string) => {
    let q = sb
      .from("onebox_leads")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .eq(`answers->>${tag}`, v);
    if (until) q = q.lt("created_at", until);
    if (kind === "picked") q = q.or(`picked_time_at.not.is.null,ghl_status.in.(${PAID.join(",")})`);
    if (kind === "paid") q = q.in("ghl_status", PAID);
    const { count: n, error } = await q;
    if (error) throw new Error(error.message);
    return n ?? 0;
  };
  const hitsSince = async (since: string, slugs?: string[]) => {
    let q = sb.from("onebox_hits").select("id", { count: "exact", head: true }).gte("created_at", since);
    if (slugs) q = q.in("slug", slugs.length ? slugs : ["-"]);
    const { count: n } = await q;
    return Math.round((n ?? 0) / 2);
  };

  try {
    const started = Date.now() >= Date.parse(TEST_START);
    if (!started) return NextResponse.json({ since: TEST_START, started: false });
    const side = async (tag: "scar" | "shortq2" | "offer3", v: "a" | "b" | "c", since: string, until?: string) => ({
      leads: await count(tag, v, since, "leads", until),
      picked: await count(tag, v, since, "picked", until),
      paid: await count(tag, v, since, "paid", until),
    });
    const { data: firstShort } = await sb
      .from("onebox_leads")
      .select("created_at")
      .gte("created_at", TEST_START)
      .not("answers->>shortq2", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const shortSince = (firstShort?.created_at as string | undefined) ?? new Date().toISOString();
    /* Calendar-urgency test (#3, engine v100): only funnels whose offer is
       a plain "$X OFF" (optionally "for new clients") and that have no
       custom booking headline flip the coin, so its visitors come from
       those funnels' hits alone, counted from its first tagged lead. */
    const { data: firstOffer } = await sb
      .from("onebox_leads")
      .select("created_at")
      .in("answers->>offer3", ["a", "c"])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const offerSince = (firstOffer?.created_at as string | undefined) ?? null;
    const { data: clients } = await sb.from("onebox_clients").select("slug, config, extras").eq("status", "live");
    const offerSlugs = (clients ?? [])
      .filter((c) => {
        const cfg = (c.config ?? {}) as Record<string, string>;
        return (c.extras as { template?: string } | null)?.template !== "b2b" && /^\$?\s*\d[\d,]*\s*OFF(\s+for\s+new\s+clients)?\s*!?$/i.test(String(cfg.offer ?? "").trim()) && !cfg.bookingHead;
      })
      .map((c) => c.slug as string);
    const zero = { leads: 0, picked: 0, paid: 0 };
    const [scarA, scarB, shortA, shortB, scarVisitors, shortVisitors, offerA, offerB, offerC] = await Promise.all([
      side("scar", "a", TEST_START, SCAR_END), side("scar", "b", TEST_START, SCAR_END),
      side("shortq2", "a", shortSince), side("shortq2", "b", shortSince),
      hitsSince(TEST_START), hitsSince(shortSince),
      offerSince ? side("offer3", "a", offerSince) : zero, offerSince ? side("offer3", "b", offerSince) : zero,
      offerSince ? side("offer3", "c", offerSince) : zero,
    ]);
    return NextResponse.json({
      since: TEST_START,
      started: true,
      visitorsPerArm: scarVisitors,
      scar: { a: scarA, b: scarB },
      shortq: { a: shortA, b: shortB, since: shortSince, visitorsPerArm: shortVisitors },
      offer: { a: offerA, b: offerB, c: offerC, since: offerSince ?? undefined, funnels: offerSlugs.length },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
