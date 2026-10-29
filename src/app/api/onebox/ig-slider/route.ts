import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";
export const maxDuration = 60;

/* Instagram slider — do visitors tap a post and keep swiping? (owner,
   10/29/2026: "should the slider show more than 12?"). Feeds the 📱 card on
   the Funnels tab; the decision is taken together once enough people have
   used the slider.

   Grid viewers = visitor-days whose browser drew the 6-tile grid on the
   booking step (onebox_render_reports, engine v125+). Slider use =
   onebox_ig_views (one row per visitor / funnel / day). Outcome = the lead
   with the same visitor id (engine v126+ sends it with the form): picked a
   time / paid on the funnel. Slider users are keener people to begin with,
   so the outcome rows show who books, not what the slider causes. */

const START = "2026-10-29T11:15:00Z"; // engine v125 live
const DECIDE_OPENERS = 300; // slider users before the numbers are worth deciding on
const END_SHARE = 25; // % of slider users who view every post → worth testing more posts
const PAID = new Set(["booked", "paid", "paid-not-booked"]);

type Render = { slug: string; visitor_id: string; day: string; grid_tiles: number | null; engine_v: string | null };
type View = { slug: string; visitor_id: string; day: string; opens: number; first_tile: number | null; seen: number; deepest: number; past6: number; avail: number | null; swipes: number; reels: number };
type Lead = { slug: string; visitor_id: string; ghl_status: string | null; picked_time_at: string | null };

async function all<T>(q: (from: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const pct = (k: number, n: number) => (n ? Math.round((k / n) * 1000) / 10 : null);

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  let renders: Render[], views: View[], leads: Lead[];
  try {
    [renders, views, leads] = await Promise.all([
      all<Render>((f) => svc.from("onebox_render_reports").select("slug, visitor_id, day, grid_tiles, engine_v").eq("kind", "render").gte("created_at", START).order("id").range(f, f + 999)),
      all<View>((f) => svc.from("onebox_ig_views").select("slug, visitor_id, day, opens, first_tile, seen, deepest, past6, avail, swipes, reels").gte("day", START.slice(0, 10)).order("id").range(f, f + 999)),
      all<Lead>((f) => svc.from("onebox_leads").select("slug, visitor_id, ghl_status, picked_time_at").not("visitor_id", "is", null).gte("created_at", START).order("id").range(f, f + 999)),
    ]);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  // Who saw the grid (visitor-days), plus anyone whose slider beacon arrived without a render report.
  const key = (r: { slug: string; visitor_id: string; day: string }) => `${r.slug}|${r.visitor_id}|${r.day}`;
  const seenGrid = new Set(renders.filter((r) => Number(r.engine_v) >= 125 && (r.grid_tiles ?? 0) >= 3).map(key));
  for (const v of views) seenGrid.add(key(v));
  const viewers = seenGrid.size;
  const users = views.length;

  const past6 = views.filter((v) => v.past6 > 0).length;
  const ended = views.filter((v) => (v.avail ?? 0) > 0 && v.seen >= (v.avail ?? 0)).length;
  const avg = (f: (v: View) => number) => (users ? Math.round((views.reduce((a, v) => a + f(v), 0) / users) * 10) / 10 : null);
  const buckets = [
    { label: "1 post", min: 1, max: 1 },
    { label: "2–3", min: 2, max: 3 },
    { label: "4–6", min: 4, max: 6 },
    { label: "7–9", min: 7, max: 9 },
    { label: "10+", min: 10, max: 99 },
  ].map((b) => ({ label: b.label, n: views.filter((v) => v.seen >= b.min && v.seen <= b.max).length }));
  const firstTile = [1, 2, 3, 4, 5, 6].map((t) => ({ tile: t, n: views.filter((v) => v.first_tile === t).length }));

  // Per day, newest first.
  const days = [...new Set([...seenGrid].map((k) => k.split("|")[2]))].sort().reverse();
  const daily = days.map((d) => ({
    day: d,
    viewers: [...seenGrid].filter((k) => k.endsWith(`|${d}`)).length,
    users: views.filter((v) => v.day === d).length,
  }));

  // Outcome per person (funnel + visitor): never opened / opened, stayed in the 6 / went past the 6.
  const person = (r: { slug: string; visitor_id: string }) => `${r.slug}|${r.visitor_id}`;
  const usage = new Map<string, "none" | "in6" | "past6">();
  for (const k of seenGrid) { const p = k.split("|").slice(0, 2).join("|"); if (!usage.has(p)) usage.set(p, "none"); }
  for (const v of views) { const p = person(v); if (v.past6 > 0) usage.set(p, "past6"); else if (usage.get(p) !== "past6") usage.set(p, "in6"); }
  const outcome = new Map<string, { picked: boolean; paid: boolean }>();
  for (const l of leads) {
    const p = person(l), o = outcome.get(p) ?? { picked: false, paid: false };
    if (l.picked_time_at || PAID.has(l.ghl_status ?? "")) o.picked = true;
    if (PAID.has(l.ghl_status ?? "")) o.paid = true;
    outcome.set(p, o);
  }
  const group = (g: "none" | "in6" | "past6") => {
    const ps = [...usage.entries()].filter(([, u]) => u === g).map(([p]) => p);
    const linked = ps.filter((p) => outcome.has(p));
    const picked = linked.filter((p) => outcome.get(p)!.picked).length;
    const paid = linked.filter((p) => outcome.get(p)!.paid).length;
    return { people: ps.length, linked: linked.length, picked, pickedPct: pct(picked, linked.length), paid, paidPct: pct(paid, linked.length) };
  };

  const endPct = pct(ended, users);
  const verdict = users < DECIDE_OPENERS
    ? { state: "collecting" as const, text: `Collecting — ${users} of ${DECIDE_OPENERS} slider users so far.` }
    : (endPct ?? 0) >= END_SHARE
      ? { state: "more" as const, text: `${endPct}% of slider users view every post — many run out. Worth testing a longer slider (A/B).` }
      : { state: "enough" as const, text: `Only ${endPct}% view every post — most stop before the end. 12 is enough.` };

  return NextResponse.json({
    since: START,
    viewers, users, openPct: pct(users, viewers),
    avgSeen: avg((v) => v.seen), avgAvail: avg((v) => v.avail ?? 0), avgOpens: avg((v) => v.opens), avgSwipes: avg((v) => v.swipes),
    past6, past6Pct: pct(past6, users),
    ended, endPct,
    reelUsers: views.filter((v) => v.reels > 0).length,
    buckets, firstTile, daily,
    outcome: { none: group("none"), in6: group("in6"), past6: group("past6") },
    decide: { openers: DECIDE_OPENERS, endShare: END_SHARE },
    verdict,
  });
}
