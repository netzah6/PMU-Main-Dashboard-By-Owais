import type { SupabaseClient } from "@supabase/supabase-js";

/* Instagram-feed watch (owner, 2026-10-15).
   The owner's hypothesis: a funnel's deposit rate moves when the client
   posts new Instagram content, because the live widget under the booking
   step changes with it. So we keep (1) a weekly deposit-rate series per
   funnel, (2) the feed's post count per week (Elfsight's public profile
   API — no auth), and (3) dated snapshots of the posts themselves
   (ig_snapshots, self-hosted copies). From those: the funnel's BEST
   4-week window, the CURRENT 2-week window, and a "dropped" signal when
   the current rate is at most half the best one on real volume. Nothing
   switches on its own — the team compares both post sets and decides.

   Volume caveat (verified 2026-10-15): the median funnel gets ~14 leads a
   week, so a single week's rate is noise. Windows and minimum-lead floors
   below exist to keep the signal honest.

   Maturity caveat (review, 2026-10-15): a lead needs days to pay — 96% of
   deposits land within 5 days — so a week is only COMPARED once it has
   been over for at least MATURE_DAYS. The in-progress week is shown in
   the series but never used for the best or the current window. */

export const PAID = ["booked", "paid", "paid-not-booked", "paid-followup"];
export const MATURE_DAYS = 5;

export type WeekPoint = { week: string; leads: number; picked: number; deposits: number };
export type Window = { from: string; to: string; leads: number; deposits: number; rate: number };

/** Monday (UTC) that starts the ISO week containing `iso`, as YYYY-MM-DD. */
export function weekStart(iso: string | Date): string {
  const t = new Date(iso);
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Weekly leads / picked / deposits for one funnel over the last `weeks`
    ISO weeks (oldest first, empty weeks included, current week last). */
export async function weeklySeries(svc: SupabaseClient, slug: string, weeks = 12): Promise<WeekPoint[]> {
  const now = new Date();
  const first = new Date(Date.parse(weekStart(now)) - (weeks - 1) * 7 * 864e5);
  const points = new Map<string, WeekPoint>();
  for (let i = 0; i < weeks; i++) {
    const w = new Date(first.getTime() + i * 7 * 864e5).toISOString().slice(0, 10);
    points.set(w, { week: w, leads: 0, picked: 0, deposits: 0 });
  }
  type Row = { created_at: string; ghl_status: string | null; picked_time_at: string | null };
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc
      .from("onebox_leads")
      .select("created_at, ghl_status, picked_time_at")
      .eq("slug", slug)
      .gte("created_at", first.toISOString())
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Row[]) {
      const p = points.get(weekStart(r.created_at));
      if (!p) continue;
      p.leads++;
      const paid = PAID.includes(r.ghl_status ?? "");
      if (paid || r.picked_time_at) p.picked++;
      if (paid) p.deposits++;
    }
    if (!data || data.length < 1000) break;
  }
  return [...points.values()];
}

function sum(points: WeekPoint[]): Window | null {
  if (!points.length) return null;
  const leads = points.reduce((s, p) => s + p.leads, 0);
  const deposits = points.reduce((s, p) => s + p.deposits, 0);
  return { from: points[0].week, to: points[points.length - 1].week, leads, deposits, rate: leads ? deposits / leads : 0 };
}

/** The weeks whose leads have had MATURE_DAYS to pay: a week counts once
    its Sunday is at least MATURE_DAYS behind `now`. */
export function matureWeeks(series: WeekPoint[], now: Date = new Date()): WeekPoint[] {
  const cutoff = now.getTime() - MATURE_DAYS * 864e5;
  return series.filter((p) => Date.parse(p.week) + 7 * 864e5 <= cutoff);
}

/** Best `win`-week window among mature weeks with at least `minLeads`
    leads; null when no window qualifies. */
export function bestWindow(series: WeekPoint[], win = 4, minLeads = 30, now: Date = new Date()): Window | null {
  const mature = matureWeeks(series, now);
  let best: Window | null = null;
  for (let i = 0; i + win <= mature.length; i++) {
    const w = sum(mature.slice(i, i + win));
    if (!w || w.leads < minLeads) continue;
    if (!best || w.rate > best.rate) best = w;
  }
  return best;
}

/** The last `win` MATURE weeks — never the week in progress, never a week
    whose leads haven't had time to pay. */
export function currentWindow(series: WeekPoint[], win = 2, now: Date = new Date()): Window | null {
  return sum(matureWeeks(series, now).slice(-win));
}

export type DropSignal = {
  /** great run, then at most half of it on real volume */
  dropped: boolean;
  /** enough current volume AND back above 75% of the best rate — the only
      state that may close an open drop alert ("not dropped" alone can just
      mean "too few leads to tell") */
  recovered: boolean;
  bestRate: number | null;
  currentRate: number | null;
};

export function dropSignal(best: Window | null, current: Window | null, minCurrentLeads = 20): DropSignal {
  if (!best || !current) return { dropped: false, recovered: false, bestRate: best?.rate ?? null, currentRate: current?.rate ?? null };
  const enough = current.leads >= minCurrentLeads;
  const dropped = best.rate >= 0.06 && enough && current.rate <= best.rate * 0.5;
  const recovered = enough && current.rate > best.rate * 0.75;
  return { dropped, recovered, bestRate: best.rate, currentRate: current.rate };
}

/* Elfsight widget → Instagram username → public profile numbers. Two boot
   schemas exist (old: dataServiceSource, new: sources); both are public,
   no key. The posts API itself needs auth — we never call it; post IMAGES
   come from browser-rendered snapshots (scripts/ig-snapshot.mjs). */
export function elfsightWidgetId(igWidget: string): string | null {
  const hex = (igWidget.match(/([a-f0-9]{32})/i)?.[1] ?? igWidget.match(/([a-f0-9-]{36})/i)?.[1] ?? "").replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** null whenever the numbers can't be read (unknown widget, 404 profile —
    which comes back as `{payload: []}` — or network trouble); never a row
    of nulls, so callers can't mistake "unknown" for "0". */
export async function elfsightProfile(igWidget: string, pageUrl = "https://book.pmu-care.com/"): Promise<{ username: string; postsCount: number; followers: number | null } | null> {
  const id = elfsightWidgetId(igWidget);
  if (!id) return null;
  try {
    const boot = (await (await fetch(`https://core.service.elfsight.com/p/boot/?page=${encodeURIComponent(pageUrl)}&w=${id}`, { signal: AbortSignal.timeout(10000) })).json()) as {
      data?: { widgets?: Record<string, { data?: { settings?: { dataServiceSource?: { name?: string }[]; sources?: { source?: string; name?: string }[] } } }> };
    };
    const settings = boot.data?.widgets?.[id]?.data?.settings;
    const raw = settings?.dataServiceSource?.[0]?.name
      ?? settings?.sources?.[0]?.source?.replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "")
      ?? "";
    const username = raw.replace(/^@/, "").trim();
    if (!username || /^instagram$/i.test(username)) return null;
    const prof = (await (await fetch(`https://widget-data.service.elfsight.com/api/instagram/profile?username=${encodeURIComponent(username)}`, { signal: AbortSignal.timeout(10000) })).json()) as {
      payload?: unknown;
    };
    const d = prof.payload;
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    const { postsCount, followersCount } = d as { postsCount?: unknown; followersCount?: unknown };
    if (typeof postsCount !== "number") return null;
    return { username, postsCount, followers: typeof followersCount === "number" ? followersCount : null };
  } catch {
    return null;
  }
}
