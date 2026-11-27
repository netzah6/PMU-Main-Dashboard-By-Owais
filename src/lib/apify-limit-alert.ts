import { fileAlert } from "@/lib/alerts";
import type { SupabaseClient } from "@supabase/supabase-js";

/* The Instagram grid on every funnel is filled by Apify. When the account's
   monthly money limit is reached, Apify refuses every run, so NEW funnels get
   no pictures and old ones stop refreshing — silently. Owner (11/27/2026):
   "if it happens you must let me know in the Alerts tab". One open box at a
   time; it closes by itself on the next successful fetch. */

const TYPE = "apify_limit";
const KEY = "apify";
export const APIFY_LIMITS_URL = "https://console.apify.com/billing/limits";

export function isApifyLimit(err: string | undefined | null): boolean {
  return !!err && /usage limit|platform-feature-disabled|not enough usage|exceeded.*(credit|usage)/i.test(err);
}

export async function fileApifyLimitAlert(svc: SupabaseClient, err: string, slugs: string[] = []): Promise<void> {
  await fileAlert(svc as unknown as Parameters<typeof fileAlert>[0], {
    type: TYPE,
    source_key: KEY,
    severity: "high",
    title: "Instagram pictures stopped: the picture service (Apify) reached its monthly money limit",
    detail:
      "New funnels get NO Instagram pictures and the others stop refreshing until the limit is raised in Apify " +
      "(Billing → Limits → monthly usage limit). This box closes by itself once pictures load again." +
      (slugs.length ? `\nWaiting: ${slugs.slice(0, 12).join(", ")}` : "") +
      `\n\nApify said: ${err.slice(0, 300)}`,
    meta: { link: APIFY_LIMITS_URL, waiting: slugs.slice(0, 50) },
  });
}

export async function resolveApifyLimitAlert(svc: SupabaseClient): Promise<void> {
  await svc.from("alerts")
    .update({ status: "resolved", resolved_by: "system (Instagram pictures loading again)", resolved_at: new Date().toISOString() })
    .eq("type", TYPE).eq("status", "open");
}
