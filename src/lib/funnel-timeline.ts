import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findClientProgram, type ProgramRow } from "@/lib/client-program";
import { ensureEngineCopy, INTERNAL_FUNNELS } from "@/lib/funnel-freeze-server";
import { ONEBOX_ENGINE_V } from "@/lib/onebox-engine";
import { snapshotFunnelPage, type FrozenPage, type OneboxRow } from "@/lib/onebox-page";

// Funnel timeline (owner, 11/04/2026): "start a timeline from right now... if we
// change something and the percentage was higher before, we can track it and move
// it back." Every funnel's page and settings are saved when they change. "restorable"
// items come back with "Go back to this"; the rest are only logged, because they
// stay live on a locked page (see LIVE_KEYS in onebox-page.ts).

export type TrackedItem = { l: string; h: string; v?: string; r: boolean };
export type Fingerprint = Record<string, TrackedItem>;
export type ChangeItem = { key: string; label: string; restorable: boolean; from?: string; to?: string };

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const short = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}...` : s);
const countList = (s: string) => s.split(",").filter((x) => x.trim()).length;

/* Shown with their value on the timeline. */
const PAGE_TEXT: Record<string, string> = {
  offer: "Offer", biz: "Business name", headline: "Headline", sub: "Subheadline", congrats: "Congrats line",
  bookingHead: "Booking headline", depositHead: "Deposit headline", igLink: "Instagram link",
};
/* Live on the page or used by the AI: logged, never restored. Secrets stay out. */
const DETAIL_TEXT: Record<string, string> = {
  deposit: "Deposit amount", phone: "Phone", address: "Address", thankYouPath: "Thank-you page", depositFunnelUrl: "AI deposit link",
  originalPrice: "Original price", discountedPrice: "Discounted price",
  originalPriceBrowsHadPmu: "Original price, brows had PMU", discountedPriceBrowsHadPmu: "Discounted price, brows had PMU",
  originalPriceEyeliner: "Original price, eyeliner", discountedPriceEyeliner: "Discounted price, eyeliner",
  originalPriceLips: "Original price, lips", discountedPriceLips: "Discounted price, lips",
  touchupPrice: "Touch-up price", firstTouchup: "First touch-up", services: "Services", businessHours: "Business hours",
  ownerName: "Owner name", otherLocations: "Other locations", yearsInBusiness: "Years in business",
};
const DETAIL_HIDDEN: Record<string, string> = { calendarId: "Calendar", fanbasisProductId: "Checkout product", metaPixelId: "Meta pixel" };

export function fingerprintFunnel(
  row: OneboxRow,
  page: FrozenPage,
  engine: number,
  ctx: { label?: string; budget?: number; test?: string },
): Fingerprint {
  const out: Fingerprint = {};
  const add = (key: string, label: string, raw: string, r: boolean, v?: string) => { out[key] = { l: label, h: hash(raw), v, r }; };
  const src = page.source ?? {};

  add("engine", "Page version", String(engine), true, String(engine));
  for (const [k, label] of Object.entries(PAGE_TEXT)) add(k, label, src[k] ?? "", true, short(src[k] ?? ""));
  add("title", "Page title", page.title ?? "", true);
  add("logo", "Logo", src.logo ?? "", true);
  add("surveyRaw", "Survey questions", src.surveyRaw ?? "", true);
  add("faqs", "FAQs", JSON.stringify((page.faqs ?? []).map((f) => [f.q, f.a, f.v ?? ""])), true);
  const results = [src.resultImgs, src.resultCvImgs].filter(Boolean).join(",");
  add("resultPhotos", "Result photos", results, true, `${countList(results)} photos`);
  const studio = [src.studioImgs, src.studioCvImgs].filter(Boolean).join(",");
  add("studioPhotos", "Studio photos", studio, true, `${countList(studio)} photos`);

  /* Instagram and reviews: only what a visitor sees. Their saved JSON also holds
     dates ("2 weeks ago"), which change with no change on the page. */
  let igImgs: string[] = String(page.cfg?.igFrozenImgs ?? "").split(",").filter((u) => u.trim());
  if (!igImgs.length) {
    try { igImgs = (JSON.parse(page.cfg?.igFeed || "{}") as { imgs?: string[] }).imgs ?? []; } catch { igImgs = []; }
  }
  add("instagram", "Instagram pictures", igImgs.join(","), true, `${igImgs.length} pictures`);
  let reviews: { rating?: number | null; count?: number | null; reviews?: { name?: string; stars?: number; text?: string }[] } = {};
  try { reviews = JSON.parse(page.cfg?.gReviews || "{}"); } catch { reviews = {}; }
  add("reviews", "Google reviews", JSON.stringify([reviews.rating ?? null, reviews.count ?? null, (reviews.reviews ?? []).map((x) => [x.name, x.stars, x.text])]), true,
    `${reviews.reviews?.length ?? 0} shown`);

  const cfg = row.config ?? {};
  for (const [k, label] of Object.entries(DETAIL_TEXT)) {
    if (k in cfg) add(k, label, cfg[k] ?? "", false, short(String(cfg[k] ?? "")));
  }
  for (const [k, label] of Object.entries(DETAIL_HIDDEN)) {
    if (k in cfg) add(k, label, cfg[k] ?? "", false);
  }
  add("status", "Funnel status", row.status ?? "", false, row.status ?? "");
  add("frozen", "Locked", row.frozen_engine != null ? "yes" : "no", false, row.frozen_engine != null ? "yes" : "no");
  add("freeBooking", "Free booking", row.extras?.freeBooking ? "on" : "off", false, row.extras?.freeBooking ? "on" : "off");
  add("consultMode", "Video visits", row.extras?.consultMode ?? "", false, row.extras?.consultMode || "off");
  /* Read from other tables: missing means "couldn't read", and diffFingerprints
     keeps the last value instead of logging a change that didn't happen. */
  if (ctx.label !== undefined) add("label", "Program label", ctx.label, false, ctx.label);
  if (ctx.budget !== undefined) add("budget", "Ad budget per day", String(ctx.budget), false, `$${ctx.budget}`);
  if (ctx.test !== undefined) add("test", "Split test", ctx.test, false, ctx.test || "none");
  return out;
}

export function diffFingerprints(prev: Fingerprint, next: Fingerprint): ChangeItem[] {
  const out: ChangeItem[] = [];
  for (const [key, item] of Object.entries(next)) {
    const was = prev[key];
    if (!was || was.h === item.h) continue;
    const showValues = was.v !== undefined && item.v !== undefined && was.v !== item.v;
    out.push(showValues ? { key, label: item.l, restorable: item.r, from: was.v, to: item.v } : { key, label: item.l, restorable: item.r });
  }
  return out;
}

export const samePage = (a: Fingerprint, b: Fingerprint) =>
  Object.entries(a).every(([k, item]) => !item.r || b[k]?.h === item.h) && Object.entries(b).every(([k, item]) => !item.r || a[k]?.h === item.h);

export type TimelineRun = { checked: number; saved: number; changed: number; failed: string[]; engineCopyError?: string; sample?: unknown };

export async function runFunnelTimeline(svc: SupabaseClient, opts: { origin: string; slug?: string; dry?: boolean }): Promise<TimelineRun> {
  const engineCopyError = opts.dry ? null : await ensureEngineCopy(svc, opts.origin);

  let q = svc.from("onebox_clients").select("slug, location_id, client_name, status, cv_synced_at, config, extras, frozen_engine, frozen_page");
  if (opts.slug) q = q.eq("slug", opts.slug);
  const [clients, latest, programs, budgets, tests] = await Promise.all([
    q,
    svc.rpc("funnel_latest_versions"),
    svc.from("client_program_rows").select("sheet_row, business_name, version, owner_name"),
    svc.from("deposit_overview").select("owner_name, daily_budget"),
    svc.from("onebox_experiments").select("slug, name").eq("status", "running"),
  ]);
  if (clients.error) throw new Error(clients.error.message);
  /* Without the last version every funnel would look brand new. */
  if (latest.error) throw new Error(latest.error.message);

  const lastBySlug = new Map(((latest.data ?? []) as { slug: string; fingerprint: Fingerprint }[]).map((v) => [v.slug, v.fingerprint]));
  const budgetByOwner = new Map(((budgets.data ?? []) as { owner_name: string | null; daily_budget: number | string | null }[])
    .map((b) => [String(b.owner_name ?? "").toLowerCase().trim(), Number(b.daily_budget ?? 0)]));
  const testBySlug = new Map(((tests.data ?? []) as { slug: string; name: string }[]).map((t) => [t.slug, t.name]));

  const inserts: Record<string, unknown>[] = [];
  const failed: string[] = [];
  let changed = 0;
  let sample: unknown;
  const rows = (clients.data ?? []) as unknown as OneboxRow[];
  const tracked = rows.filter((r) => opts.slug || ((r.extras as { template?: string } | null)?.template !== "b2b" && !INTERNAL_FUNNELS.has(r.slug)));
  for (const raw of tracked) {
    try {
      const row: OneboxRow = { ...raw, config: raw.config ?? {}, extras: raw.extras ?? {} };
      const locked = row.frozen_engine != null && !!row.frozen_page;
      const page = locked ? (row.frozen_page as FrozenPage) : snapshotFunnelPage(row);
      const engine = row.frozen_engine ?? ONEBOX_ENGINE_V;
      const program = programs.error ? null : findClientProgram((programs.data ?? []) as ProgramRow[], String(row.client_name ?? ""));
      /* A zero budget usually means the ads sheet is mid-sync, so it is treated
         as unknown. A real pause shows in the leads and in any note. */
      const budget = program ? budgetByOwner.get(program.ownerName.toLowerCase().trim()) : undefined;
      const next = fingerprintFunnel(row, page, engine, {
        label: program?.version,
        budget: budget && budget > 0 ? budget : undefined,
        test: tests.error ? undefined : testBySlug.get(row.slug) ?? "",
      });
      const prev = lastBySlug.get(row.slug);
      if (prev) for (const [k, item] of Object.entries(prev)) if (!(k in next)) next[k] = item;
      const changes = prev ? diffFingerprints(prev, next) : [];
      if (prev && !changes.length) continue;
      if (prev) changed++;
      if (sample === undefined) sample = { slug: row.slug, changes, keys: Object.keys(next).length };
      inserts.push({ slug: row.slug, engine, frozen: locked, page, fingerprint: next, changes });
    } catch (e) {
      failed.push(`${raw.slug}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  if (!opts.dry) {
    for (let i = 0; i < inserts.length; i += 25) {
      const { error } = await svc.from("funnel_versions").insert(inserts.slice(i, i + 25));
      if (error) failed.push(`save ${i}: ${error.message}`);
    }
  }
  return { checked: tracked.length, saved: opts.dry ? 0 : inserts.length, changed, failed, engineCopyError: engineCopyError ?? undefined, sample: opts.dry ? sample : undefined };
}
