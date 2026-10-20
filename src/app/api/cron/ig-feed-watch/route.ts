import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { fileAlert } from "@/lib/alerts";
import {
  bestWindow,
  currentWindow,
  dropSignal,
  elfsightProfile,
  elfsightWidgetId,
  weekStart,
  weeklySeries,
  type Window,
} from "@/lib/ig-feed-watch";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

/* Weekly (Monday 13:00 UTC): for every live B2C funnel with an Instagram
   widget, (1) record this week's post count + followers from Elfsight's
   public profile API into ig_feed_history, (2) compare the funnel's best
   4-week deposit-rate run with the last 2 full weeks, and (3) when the
   rate fell to half or less on real volume, file ONE "ig_drop" alert that
   says whether the feed's post count changed since the best run. Alerts
   close only when the rate has clearly recovered — low volume or an old
   best window never closes one. Nothing on the funnel changes here; the
   owner compares both post sets on the Cost/Deposit card and clicks.
   ?dry=1 computes everything but writes nothing. */

const CONCURRENCY = 4;
const TIME_BUDGET_MS = 270_000;

type ClientRow = {
  slug: string;
  client_name: string | null;
  config: { igWidget?: string; elfsightId?: string } | null;
  extras: { template?: string; igWidgetOff?: boolean; igFrozen?: boolean } | null;
};

type HistoryRow = { week_start: string; posts_count: number | null };

/** "Aug 3" — US month-first, UTC so the stored YYYY-MM-DD never shifts a day. */
function usDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A window runs from its first Monday to its last Sunday (to + 6 days). */
function windowLabel(w: Window): string {
  const sunday = new Date(Date.parse(w.to) + 6 * 864e5).toISOString().slice(0, 10);
  return `${usDay(w.from)} – ${usDay(sunday)}`;
}

function pct(w: Window): string {
  return (w.rate * 100).toFixed(1);
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const t0 = Date.now();
  const now = new Date();
  const week = weekStart(now);
  const svc = createServiceClient();

  try {
    // onebox_clients has no id column — page by slug.
    const clients: ClientRow[] = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await svc
        .from("onebox_clients")
        .select("slug, client_name, config, extras")
        .eq("status", "live")
        .order("slug")
        .range(i, i + 999);
      if (error) throw new Error(error.message);
      clients.push(...((data ?? []) as ClientRow[]));
      if (!data || data.length < 1000) break;
    }

    const targets = clients
      .filter((c) => c.slug !== "demo-v3" && c.slug !== "pmu-bookings")
      .filter((c) => c.extras?.template !== "b2b")
      .filter((c) => !c.extras?.igWidgetOff)
      .map((c) => ({ ...c, widget: String(c.config?.igWidget || c.config?.elfsightId || "").trim() }))
      .filter((c) => elfsightWidgetId(c.widget) !== null);

    let checked = 0, recorded = 0, flagged = 0, filed = 0, resolved = 0;
    const skipped: string[] = [];
    const errors: string[] = [];
    /* Recovery is judged against the best run SAVED ON THE OPEN ALERT, not
       the best window recomputed today: once the good weeks age out of
       the rolling series, "best" would sink to the bad period and a still-
       low rate would read as recovered (review, 2026-10-20). */
    const currentBySlug = new Map<string, Window>();

    const processOne = async (c: (typeof targets)[number]) => {
      const business = c.client_name ?? c.slug;

      // 1. This week's feed numbers. null = unreadable → count it, write nothing.
      const p = await elfsightProfile(c.widget);
      if (p) {
        if (!dryRun) {
          const { error } = await svc
            .from("ig_feed_history")
            .upsert({ slug: c.slug, week_start: week, posts_count: p.postsCount, followers: p.followers }, { onConflict: "slug,week_start" });
          if (error) throw new Error(`history upsert: ${error.message}`);
        }
        recorded++;
      } else {
        errors.push(`${c.slug}: Instagram profile not readable`);
      }

      // 2. Deposit-rate windows (mature weeks only — see lib/ig-feed-watch).
      const series = await weeklySeries(svc, c.slug, 12);
      const best = bestWindow(series);
      const current = currentWindow(series);
      const sig = dropSignal(best, current);
      if (current) currentBySlug.set(c.slug, current);
      if (!sig.dropped || !best || !current) return;
      /* A frozen funnel already shows a fixed set of posts, so a drop there
         is not about the live feed changing and "switch to the best-run
         posts" would suggest a click already made — track it, don't flag. */
      if (c.extras?.igFrozen) return;
      flagged++;

      // 3. Did the post count change since the best run? Only THIS week's
      //    row counts as "now" — an older week would hide a fresh change.
      const { data: nowRows } = await svc
        .from("ig_feed_history")
        .select("week_start, posts_count")
        .eq("slug", c.slug)
        .eq("week_start", week)
        .limit(1);
      const { data: thenRows } = await svc
        .from("ig_feed_history")
        .select("week_start, posts_count")
        .eq("slug", c.slug)
        .lte("week_start", best.to)
        .order("week_start", { ascending: false })
        .limit(1);
      const nowRow = ((nowRows ?? [])[0] as HistoryRow | undefined) ?? null;
      const thenRow = ((thenRows ?? [])[0] as HistoryRow | undefined) ?? null;
      const nowPosts = nowRow?.posts_count ?? (dryRun ? p?.postsCount ?? null : null);
      const thenPosts = thenRow?.posts_count ?? null;
      const postsChanged = nowPosts != null && thenPosts != null ? nowPosts !== thenPosts : null;

      // 4. One alert per funnel; re-fires after 14 days if still dropped.
      const postsLine = postsChanged === true
        ? `The Instagram feed has ${nowPosts} posts now vs ${thenPosts} during the best run.`
        : postsChanged === false
          ? "The feed looks unchanged."
          : "We don't have the post count from the best run yet.";
      const title = `${business}: deposit rate fell from ${pct(best)}% to ${pct(current)}%`
        + (postsChanged === true ? " — Instagram posts changed" : postsChanged === false ? " — Instagram posts unchanged" : "");
      const detail = `Best run ${windowLabel(best)}: ${best.deposits} deposits from ${best.leads} leads (${pct(best)}%). `
        + `Last 2 full weeks (${windowLabel(current)}): ${current.deposits} from ${current.leads} (${pct(current)}%). `
        + `${postsLine} Open the client's Cost/Deposit card → 'Posts vs deposit rate' to compare the posts from the best run with today's and switch the funnel to the best-run posts if you want. Nothing changes on its own.`;
      if (dryRun) return;
      const ok = await fileAlert(svc, {
        type: "ig_drop",
        severity: "medium",
        title,
        detail,
        source_key: `ig-drop:${c.slug}`,
        meta: { slug: c.slug, business, best, current, postsChanged, nowPosts, thenPosts },
        resurfaceAfterDays: 14,
      });
      if (ok) filed++;
    };

    let next = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
          const i = next++;
          if (i >= targets.length) return;
          const c = targets[i];
          if (Date.now() - t0 > TIME_BUDGET_MS) { skipped.push(c.slug); continue; }
          checked++;
          try {
            await processOne(c);
          } catch (e) {
            errors.push(`${c.slug}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }),
    );

    // 5. Close open drop alerts ONLY where the rate clearly came back —
    //    measured against the best run the alert itself recorded.
    const { data: openAlerts } = await svc
      .from("alerts")
      .select("id, source_key, meta")
      .eq("type", "ig_drop")
      .eq("status", "open")
      .limit(1000);
    const toClose = (openAlerts ?? []).filter((a) => {
      const slug = String(a.source_key ?? "").replace(/^ig-drop:/, "");
      const cur = currentBySlug.get(slug);
      const savedBest = (a.meta as { best?: { rate?: number } } | null)?.best?.rate;
      return !!cur && typeof savedBest === "number" && dropSignal({ from: "", to: "", leads: 0, deposits: 0, rate: savedBest }, cur).recovered;
    }).map((a) => a.id as number);
    if (toClose.length && !dryRun) {
      const { data: closed, error } = await svc
        .from("alerts")
        .update({ status: "resolved", resolved_by: "system (deposit rate recovered)", resolved_at: new Date().toISOString() })
        .in("id", toClose)
        .select("id");
      if (error) errors.push(`resolve: ${error.message}`);
      resolved = closed?.length ?? 0;
    } else if (toClose.length) {
      resolved = toClose.length;
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      week,
      eligible: targets.length,
      checked,
      recorded,
      flagged,
      filed,
      resolved,
      skipped: skipped.length,
      skippedSlugs: skipped.slice(0, 20),
      errors: errors.slice(0, 5),
      errorCount: errors.length,
      ms: Date.now() - t0,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
