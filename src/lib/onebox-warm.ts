import { waitUntil } from "@vercel/functions";

/* Under the funnel page's long stale-while-revalidate window, a quiet
   funnel could keep serving pre-edit copy for as long as nobody visits.
   After any dashboard-driven config change we act as the funnel's next
   visitor once the 60s fresh window has lapsed, so the edge revalidates
   with the new copy within ~2 minutes. The "ob-warm" UA is in the funnel
   route's scraper list: on A/B-test clients (always no-store) the ping is
   a harmless no-op that mints no assignment row. */

export function warmFunnel(slug: string) {
  waitUntil((async () => {
    /* Two pings: an in-flight pre-save render can be stored by the CDN
       seconds after the save, making a single +65s ping land inside that
       entry's fresh minute and revalidate nothing. The second ping at
       +150s is past any such window. */
    for (const delayMs of [75_000, 150_000]) {
      await new Promise((r) => setTimeout(r, delayMs === 75_000 ? delayMs : delayMs - 75_000));
      await fetch(`https://book.pmu-care.com/${slug}`, {
        cache: "no-store",
        headers: { "user-agent": "ob-warm/1 (cache refresh after dashboard save)" },
      }).catch(() => {});
    }
  })());
}
