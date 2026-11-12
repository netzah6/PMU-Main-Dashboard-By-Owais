import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { appOwner, loadApp } from "@/lib/client-app";
import { fileAlert } from "@/lib/alerts";

/* Client app · daily ad budget (owner, 11/12/2026): "by default, we will
   start with $25 per day. We will recommend to them to change the budget when
   it's necessary." She may pick another amount; the choice is kept on her row
   and the team gets one alert to set it in Facebook. Nothing here touches
   Facebook or any budget by itself — a person on the team makes the change. */

export const BUDGET_DEFAULT = 25;
export const BUDGET_OPTIONS = [25, 30, 40, 50] as const;

export const loadBudget = cache(async (token: string): Promise<{ daily: number; chosenAt: string | null } | null> => {
  const ownerKey = await appOwner(token);
  if (!ownerKey) return null;
  const { data } = await createServiceClient().from("client_app_settings").select("ad_budget_daily, ad_budget_at").eq("owner_key", ownerKey).maybeSingle();
  const s = data as { ad_budget_daily?: number | null; ad_budget_at?: string | null } | null;
  return { daily: s?.ad_budget_daily ?? BUDGET_DEFAULT, chosenAt: s?.ad_budget_at ?? null };
});

export async function saveBudget(token: string, amount: unknown): Promise<boolean> {
  const daily = Number(amount);
  if (!BUDGET_OPTIONS.some((o) => o === daily)) return false;
  const [ownerKey, app, cur] = await Promise.all([appOwner(token), loadApp(token), loadBudget(token)]);
  if (!ownerKey || !app || !cur) return false;
  if (cur.daily === daily) return true; // nothing changed — nothing for the team to do
  const svc = createServiceClient();
  const now = new Date().toISOString();
  const { error } = await svc.from("client_app_settings")
    .upsert({ owner_key: ownerKey, ad_budget_daily: daily, ad_budget_at: now, updated_at: now }, { onConflict: "owner_key" });
  if (error) return false;
  const who = app.view.business || app.view.ownerName;
  await fileAlert(svc, {
    type: "client_budget", severity: "medium",
    title: `${who} asked for a $${daily}/day ad budget`,
    detail: `Picked in the client app (was $${cur.daily}/day there). Set the daily budget in her Facebook campaign, then resolve this.`,
    source_key: `client_budget:${ownerKey}:${daily}:${now.slice(0, 10)}`,
    meta: { owner_key: ownerKey, daily, from: cur.daily },
  }).catch(() => false);
  return true;
}
