import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { DEP_ASK_START, depAskSlugs } from "@/lib/dep-ask";
import { COMP_AB_START, compAbLocations } from "@/lib/compliment-ab";

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
/* Instagram grid test (#4): side "b" became the in-house 3 × 2 feed on
   10/26/2026 (before that it was an Elfsight Grid copy on 11 funnels), so
   the test counts from this deploy, not from its first tagged lead. */
const IGW_START = "2026-10-26T13:30:00Z";
/* …and ended the same day (owner): our grid for everyone, Elfsight out. */
const IGW_END = "2026-10-27T06:30:00Z";
/* Shorter survey and calendar urgency both ended 11/02/2026 (owner): ties
   on deposits — the full survey (A) and the plain offer line (A) stay for
   everyone. Leads after the lock carry "a" by default, so both readouts
   stop at engine v127's deploy. */
const SHORTQ_END = "2026-11-02T12:00:00Z";
const OFFER_END = "2026-11-02T12:00:00Z";

const PAID = ["booked", "paid", "paid-not-booked", "paid-followup"];

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sb = createServiceClient();
  const count = async (tag: "scar" | "shortq2" | "offer3" | "igw", v: "a" | "b" | "c", since: string, kind: "leads" | "picked" | "paid", until?: string) => {
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
  const hitsSince = async (since: string, slugs?: string[], until?: string) => {
    let q = sb.from("onebox_hits").select("id", { count: "exact", head: true }).gte("created_at", since);
    if (until) q = q.lt("created_at", until);
    if (slugs) q = q.in("slug", slugs.length ? slugs : ["-"]);
    const { count: n } = await q;
    return Math.round((n ?? 0) / 2);
  };

  try {
    const started = Date.now() >= Date.parse(TEST_START);
    if (!started) return NextResponse.json({ since: TEST_START, started: false });
    const side = async (tag: "scar" | "shortq2" | "offer3" | "igw", v: "a" | "b" | "c", since: string, until?: string) => ({
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
    /* Instagram grid test (#4): funnels with an in-house feed (or a Grid
       copy) flip the coin; counted from IGW_START, once the deploy is live. */
    const igwSince = Date.now() >= Date.parse(IGW_START) ? IGW_START : null;
    const igwFunnels = (clients ?? []).filter((c) => {
      const ex = (c.extras as { igGridWidget?: string; igFeed?: { imgs?: string[] }; igFrozen?: boolean; igWidgetOff?: boolean } | null) ?? {};
      const cfg = (c.config ?? {}) as Record<string, string>;
      return !!cfg.igWidget && !ex.igFrozen && !ex.igWidgetOff && (!!ex.igGridWidget || !!ex.igFeed?.imgs?.length);
    }).length;
    const zero = { leads: 0, picked: 0, paid: 0 };
    const [scarA, scarB, shortA, shortB, scarVisitors, shortVisitors, offerA, offerB, offerC] = await Promise.all([
      side("scar", "a", TEST_START, SCAR_END), side("scar", "b", TEST_START, SCAR_END),
      side("shortq2", "a", shortSince, SHORTQ_END), side("shortq2", "b", shortSince, SHORTQ_END),
      hitsSince(TEST_START), hitsSince(shortSince, undefined, SHORTQ_END),
      offerSince ? side("offer3", "a", offerSince, OFFER_END) : zero, offerSince ? side("offer3", "b", offerSince, OFFER_END) : zero,
      offerSince ? side("offer3", "c", offerSince, OFFER_END) : zero,
    ]);
    const [igwA, igwB] = await Promise.all([igwSince ? side("igw", "a", igwSince, IGW_END) : zero, igwSince ? side("igw", "b", igwSince, IGW_END) : zero]);
    /* Deposit-ask test (owner, 10/28/2026): only leads who texted the AI
       back before paying can show the difference (owner, 10/29: paying on
       the page isn't a conversion for either side) — one row per contact in
       dep_ask_results, filled hourly by /api/cron/dep-ask (src/lib/dep-ask.ts). */
    const depRows: { arm: string; reply_at: string | null; paid: boolean }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("dep_ask_results").select("arm, reply_at, paid").range(from, from + 999);
      if (error) throw new Error(error.message);
      depRows.push(...((data ?? []) as typeof depRows));
      if (!data || data.length < 1000) break;
    }
    const depSide = (arm: "a" | "b") => {
      const r = depRows.filter((x) => x.arm === arm);
      return {
        picked: r.length,
        pagePaid: r.filter((x) => x.paid && !x.reply_at).length,
        reached: r.filter((x) => x.reply_at).length,
        paid: r.filter((x) => x.reply_at && x.paid).length,
      };
    };
    const depSlugs = await depAskSlugs(sb);
    /* Photo-compliment test (owner, 11/11/2026): one row per slay conversation
       in compliment_ab_results, filled hourly by /api/cron/compliment-ab. The
       side is the text the AI actually sent; "wrong" counts leads whose phone
       digit says the other side (the CloseBot split check). */
    const compRows: { line: string; expected: string | null; reply_at: string | null; reply_kind: string | null; booked: boolean; paid: boolean }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("compliment_ab_results").select("line, expected, reply_at, reply_kind, booked, paid").range(from, from + 999);
      if (error) throw new Error(error.message);
      compRows.push(...((data ?? []) as typeof compRows));
      if (!data || data.length < 1000) break;
    }
    const compSide = (line: "old" | "new") => {
      const r = compRows.filter((x) => x.line === line);
      return {
        sent: r.length,
        replied: r.filter((x) => x.reply_at).length,
        happy: r.filter((x) => x.reply_kind === "happy").length,
        putdown: r.filter((x) => x.reply_kind === "putdown").length,
        booked: r.filter((x) => x.booked).length,
        paid: r.filter((x) => x.paid).length,
      };
    };
    const compChecked = compRows.filter((x) => x.expected);
    const compAccounts = (await compAbLocations(sb)).length;
    return NextResponse.json({
      since: TEST_START,
      started: true,
      visitorsPerArm: scarVisitors,
      scar: { a: scarA, b: scarB },
      shortq: { a: shortA, b: shortB, since: shortSince, until: SHORTQ_END, visitorsPerArm: shortVisitors },
      offer: { a: offerA, b: offerB, c: offerC, since: offerSince ?? undefined, until: OFFER_END, funnels: offerSlugs.length },
      igw: { a: igwA, b: igwB, since: igwSince ?? undefined, until: IGW_END, funnels: igwFunnels },
      dep: { a: depSide("a"), b: depSide("b"), since: DEP_ASK_START, funnels: depSlugs?.length },
      comp: { a: compSide("old"), b: compSide("new"), since: COMP_AB_START, accounts: compAccounts, checked: compChecked.length, wrong: compChecked.filter((x) => x.expected !== x.line).length },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
