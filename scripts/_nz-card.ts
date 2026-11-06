import { readFileSync } from "node:fs";
import { createServiceClient } from "@/lib/supabase/server";
import { RUNBOOK } from "@/lib/setup-runbook";
import { advanceSetup } from "@/lib/setup-run";
const LOC = "qGleG1D8UX2prsmj2dAJ", BY = "netzach55@gmail.com", now = () => new Date().toISOString();
(async () => {
  const svc = createServiceClient();
  const { data: ex } = await svc.from("onboardings").select("id, form").order("created_at", { ascending: false });
  if ((ex ?? []).some((o: any) => /prettyinked/i.test(o.form?.business_name ?? ""))) { console.log("card exists already", (ex ?? []).find((o: any) => /prettyinked/i.test(o.form?.business_name ?? ""))?.id); return; }
  const bk = JSON.parse(readFileSync("/Users/netzahmizrahi/Run Claude Code Here/backups/prettyinkedbyk-before-snapshot-2026-11-01.json", "utf8"));
  const old = (n: string) => String((bk.customValues as any[]).find((c) => c.name === n)?.value ?? "").trim();
  const form: Record<string, string> = {
    business_name: "Prettyinkedbyk", owner_name: "Kailee Strahan", email: "kaileestrahan4488@gmail.com", phone: "(602) 884-2796",
    address: "5420 S Lakeshore Dr, Tempe, AZ 85283", services: "Lip Blush, Powder Brows", version: "V3",
    assigned: "Dana", media_buyer: "Marie", offer: "$150 OFF",
    original_price: "$499", discounted_price: "$349", deposit_amount: "$30",
    business_hours: "Monday - Friday 8AM - 2PM", years_in_business: "10", first_touchup: "6-8 weeks",
    ig_link: "https://www.instagram.com/prettyinkedbyk", fb_link: "https://www.facebook.com/profile.php?id=61591864176678",
    old_funnel_url: "https://prettyinkedbyk.service-pmu.com/pmu-survey-landing-page", meta_pixel_id: "2431839780676257",
    connect_caller_id: "no", master_row: "631", master_contact_id: "jnSCgmYzqINPPWREowc7",
    logo_url: old("CC - Funnel Logo"),
    eyebrows_ba_1: old("CC - Eyebrows Before & After 1"), eyebrows_ba_2: old("CC - Eyebrows Before & After 2"), eyebrows_ba_3: old("CC - Eyebrows Before & After 3"),
    lipblush_ba_1: old("CC - Lip blush Before & After 1"), lipblush_ba_2: old("CC - Lip blush Before & After 2"), lipblush_ba_3: old("CC - Lip blush Before & After 3"),
  };
  for (const k of Object.keys(form)) if (!form[k]) delete form[k];
  const { data: card, error } = await svc.from("onboardings").insert({ form, created_by: BY }).select("id").single();
  if (error || !card) throw new Error(error?.message);
  const id = (card as { id: string }).id;
  const steps: Record<string, any> = {};
  for (const s of RUNBOOK) if (!["api", "mini", "ask"].includes(s.who) || s.later) steps[s.key] = { status: "manual" };
  const done = (k: string, note: string) => (steps[k] = { status: "done", who: BY, at: now(), note });
  const skip = (k: string, note: string) => (steps[k] = { status: "skipped", who: BY, at: now(), note });
  done("account_check", "existing account — never wiped (returning/live client, V1 → V3 upgrade)");
  done("account_take", "her own account qGleG1D8UX2prsmj2dAJ (Prettyinkedbyk); V3 snapshot loaded 11/01 with overwrite (funnels kept)");
  skip("phone_buy", "she already has her number");
  done("user_create", "existing login kaileestrahan4488@gmail.com");
  skip("user_password", "she keeps her own password");
  skip("user_settings", "her login is an Account Admin — permissions trimmed only by Netzah");
  skip("first_cycle", "already a live client — no went-live texts");
  for (const k of ["fb_bm", "fb_campaign", "fb_adset", "fb_ad", "fb_publish"]) skip(k, "ads already running — old funnel redirects to the one-box");
  skip("client_connect", "already connected");
  const setup = { v: 1, approved_by: BY, approved_at: now(), location_id: LOC, pool_name: "Prettyinkedbyk (existing account)", status: "running", steps,
    log: [{ at: now(), key: "run", msg: `Started by hand by Claude for ${BY}: V1 → V3 upgrade on her existing account (no wipe)` }], preapproved: [] };
  const { error: e2 } = await svc.from("onboardings").update({ setup, status: "in_progress" }).eq("id", id);
  if (e2) throw new Error(e2.message);
  const st = await advanceSetup(svc, id);
  const sum = Object.entries(st.steps).map(([k, v]: any) => `${k}=${v.status}`).join(", ");
  console.log("CARD", id, "\nRUN", st.status, "\n", sum);
})();
