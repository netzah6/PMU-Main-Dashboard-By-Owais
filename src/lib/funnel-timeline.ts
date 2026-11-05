import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findClientProgram, type ProgramRow } from "@/lib/client-program";
import { ensureEngineCopy, INTERNAL_FUNNELS } from "@/lib/funnel-freeze-server";
import { addDays, AUTOMATIC_KEYS, changeWindows, fellAfterChange, GO_BACK_Z, isOtherCause, isOurChange, pacificDay, sumDays, zFell, type DayCounts, type GoBackSuggestion } from "@/lib/funnel-timeline-view";
import { signLogoUrl } from "@/lib/logo-sign";
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
/* By whole characters: half an emoji is invalid in jsonb and would fail the save. */
const short = (s: string) => { const c = Array.from(s); return c.length > 80 ? `${c.slice(0, 77).join("")}...` : s; };
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
  ownerName: "Owner name", otherLocations: "Other locations", yearsInBusiness: "Years in business", extraNotes: "Extra notes for the AI",
};
const DETAIL_HIDDEN: Record<string, string> = { calendarId: "Calendar", fanbasisProductId: "Checkout product" };
/* Always logged, even the first time they can be read. */
const FROM_OTHER_TABLES = new Set(["label", "budget", "test"]);

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
  add("faqs", "FAQs", JSON.stringify((page.faqs ?? []).map((f) => [f.q, f.a, f.v ?? "", f.p ?? ""])), true);
  const results = [src.resultImgs, src.resultCvImgs].filter(Boolean).join(",");
  add("resultPhotos", "Result photos", results, true, `${countList(results)} photos`);
  const studio = [src.studioImgs, src.studioCvImgs].filter(Boolean).join(",");
  add("studioPhotos", "Studio photos", studio, true, `${countList(studio)} photos`);

  /* Instagram and reviews: only what a visitor sees. Each fetch saves the same
     posts under new addresses, and reviews carry dates ("2 weeks ago"), so those
     alone would log a change with no change on the page. */
  let igImgs: string[] = String(page.cfg?.igFrozenImgs ?? "").split(",").filter((u) => u.trim());
  if (!igImgs.length) {
    try { igImgs = (JSON.parse(page.cfg?.igFeed || "{}") as { imgs?: string[] }).imgs ?? []; } catch { igImgs = []; }
  }
  add("instagram", "Instagram pictures", page.ig ? JSON.stringify([page.ig.posts, page.ig.first, page.ig.picks, page.ig.profile]) : igImgs.join(","), true, `${igImgs.length} pictures`);
  let reviews: { rating?: number | null; count?: number | null; reviews?: { name?: string; stars?: number; text?: string }[] } = {};
  try { reviews = JSON.parse(page.cfg?.gReviews || "{}"); } catch { reviews = {}; }
  add("reviews", "Google reviews", JSON.stringify([reviews.rating ?? null, reviews.count ?? null, (reviews.reviews ?? []).map((x) => [x.name, x.stars, x.text])]), true,
    `${reviews.reviews?.length ?? 0} shown, ${reviews.count ?? "no"} reviews`);

  const cfg = row.config ?? {};
  for (const [k, label] of Object.entries(DETAIL_TEXT)) {
    if (k in cfg) add(k, label, cfg[k] ?? "", false, short(String(cfg[k] ?? "")));
  }
  for (const [k, label] of Object.entries(DETAIL_HIDDEN)) {
    if (k in cfg) add(k, label, cfg[k] ?? "", false);
  }
  add("metaPixelId", "Meta pixel", String(cfg.metaPixelId || row.extras?.metaPixelId || "").replace(/\D/g, ""), false);
  add("status", "Funnel status", row.status ?? "", false, row.status ?? "");
  add("frozen", "Locked", row.frozen_engine != null ? "yes" : "no", false, row.frozen_engine != null ? "yes" : "no");
  add("freeBooking", "Free booking", row.extras?.freeBooking ? "on" : "off", false, row.extras?.freeBooking ? "on" : "off");
  add("consultMode", "Video visits", row.extras?.consultMode ?? "", false, row.extras?.consultMode || "off");
  /* Read from other tables: missing means "couldn't read", and diffFingerprints
     keeps the last value instead of logging a change that didn't happen. */
  if (ctx.label !== undefined) add("label", "Program label", ctx.label, false, ctx.label);
  if (ctx.budget !== undefined) add("budget", "Ad budget per day", String(ctx.budget), false, ctx.budget > 0 ? `$${ctx.budget}` : "$0 (ads off)");
  if (ctx.test !== undefined) add("test", "Split test", ctx.test, false, ctx.test || "none");
  return out;
}

export function diffFingerprints(prev: Fingerprint, next: Fingerprint): ChangeItem[] {
  const out: ChangeItem[] = [];
  for (const [key, item] of Object.entries(next)) {
    const was = prev[key];
    if (!was) {
      /* Keys added to this code later aren't changes on the funnel. */
      if (FROM_OTHER_TABLES.has(key)) out.push({ key, label: item.l, restorable: item.r, to: item.v });
      continue;
    }
    if (was.h === item.h) continue;
    const showValues = was.v !== undefined && item.v !== undefined && was.v !== item.v;
    out.push(showValues ? { key, label: item.l, restorable: item.r, from: was.v, to: item.v } : { key, label: item.l, restorable: item.r });
  }
  return out;
}

/* True when going from one to the other would change nothing for a visitor,
   apart from the values that always stay live. */
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

  const lastBySlug = new Map(((latest.data ?? []) as { slug: string; id: number; fingerprint: Fingerprint }[]).map((v) => [v.slug, v]));
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
      const next = fingerprintFunnel(row, page, engine, {
        label: program?.version,
        budget: program && !budgets.error ? budgetByOwner.get(program.ownerName.toLowerCase().trim()) : undefined,
        test: tests.error ? undefined : testBySlug.get(row.slug) ?? "",
      });
      const last = lastBySlug.get(row.slug);
      const prev = last?.fingerprint;
      if (prev) for (const [k, item] of Object.entries(prev)) if (!(k in next)) next[k] = item;
      const changes = prev ? diffFingerprints(prev, next) : [];
      if (prev && !changes.length) continue;
      if (prev) changed++;
      if (sample === undefined) sample = { slug: row.slug, changes, keys: Object.keys(next).length };
      inserts.push({ slug: row.slug, engine, frozen: locked, page, fingerprint: next, changes, prev_id: last?.id ?? 0 });
    } catch (e) {
      failed.push(`${raw.slug}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  if (!opts.dry) {
    /* prev_id: if another run already saved this change, this one is skipped.
       One bad row can't block the rest of its batch: a failed batch retries by row. */
    const save = (batch: Record<string, unknown>[]) =>
      svc.from("funnel_versions").upsert(batch, { onConflict: "slug,prev_id", ignoreDuplicates: true });
    for (let i = 0; i < inserts.length; i += 25) {
      const batch = inserts.slice(i, i + 25);
      const { error } = await save(batch);
      if (!error) continue;
      for (const one of batch) {
        const { error: oneError } = await save([one]);
        if (oneError) failed.push(`${one.slug}: ${oneError.message}`);
      }
    }
  }
  return { checked: tracked.length, saved: opts.dry ? 0 : inserts.length, changed, failed, engineCopyError: engineCopyError ?? undefined, sample: opts.dry ? sample : undefined };
}

export type DailyRow = {
  slug: string;
  client_name: string;
  status: string;
  template: string | null;
  free_booking: boolean;
  frozen_engine: number | null;
  frozen_at: string | null;
  business: string | null;
  owner_name: string | null;
  client_status: string | null;
  days: Record<string, DayCounts>;
};

/* The counting takes about 5 s and covers every funnel, so opening several
   histories in a row shares one result. Display-only. */
let dailyMemo: { at: number; since: string; rows: DailyRow[] } | null = null;
export async function loadDaily(svc: SupabaseClient, since: string): Promise<DailyRow[]> {
  if (dailyMemo && dailyMemo.since <= since && Date.now() - dailyMemo.at < 120_000) return dailyMemo.rows;
  const { data, error } = await svc.rpc("funnel_timeline_daily", { p_since: since });
  if (error) throw new Error(error.message);
  dailyMemo = { at: Date.now(), since, rows: (data ?? []) as DailyRow[] };
  return dailyMemo.rows;
}

/* The change windows look up to 28 days back, for changes up to 56 days old. */
export const dailySince = (today: string) => addDays(today, -84);

/* Would going back change anything we changed? Instagram and reviews refresh by
   themselves, so a difference only there means the change was already undone. */
const sameOurPage = (a: Fingerprint, b: Fingerprint) =>
  Object.entries(a).every(([k, item]) => !item.r || AUTOMATIC_KEYS.has(k) || !b[k] || b[k].h === item.h);

type ChangeRow = { id: number; slug: string; saved_at: string; changes: ChangeItem[]; prev_id: number; day: string };

/* Which funnels fell clearly after a change we made, where the page from before that
   change is saved and really differs from today's. Costs nothing until a change exists.
   Throws on a failed read, so the screen can say it couldn't check. */
export async function findGoBackSuggestions(
  svc: SupabaseClient,
  funnels: { slug: string; client_name: string; client_status: string | null }[],
  programs: ProgramRow[],
  now: Date,
): Promise<Map<string, GoBackSuggestion>> {
  const out = new Map<string, GoBackSuggestion>();
  const today = pacificDay(now);
  const lookBack = addDays(today, -56);
  const rows: ChangeRow[] = [];
  /* Older rows too: a change that can't be undone inside a window still counts as another cause. */
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("funnel_versions").select("id, slug, saved_at, changes, prev_id")
      .gt("prev_id", 0).gte("saved_at", `${dailySince(today)}T00:00:00Z`).order("saved_at", { ascending: false }).order("id", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) rows.push({ ...(r as Omit<ChangeRow, "day">), changes: (r.changes ?? []) as ChangeItem[], day: pacificDay(new Date(r.saved_at as string)) });
    if ((data ?? []).length < 1000) break;
  }
  if (!rows.some((r) => r.day >= lookBack && r.changes.some(isOurChange))) return out;

  const [{ data: states, error: stateError }, { data: locks, error: lockError }, daily] = await Promise.all([
    svc.from("funnel_freeze").select("slug, declined_at, history"),
    svc.from("onebox_clients").select("slug, frozen_engine"),
    loadDaily(svc, dailySince(today)),
  ]);
  if (stateError ?? lockError) throw new Error((stateError ?? lockError)?.message);
  const stateBySlug = new Map(((states ?? []) as { slug: string; declined_at: string | null; history: { action: string; at: string }[] | null }[]).map((s) => [s.slug, s]));
  const locked = new Set(((locks ?? []) as { slug: string; frozen_engine: number | null }[]).filter((c) => c.frozen_engine != null).map((c) => c.slug));
  const isV1 = (name: string) => findClientProgram(programs, name)?.version === "(V1)";
  const days = new Map(daily.map((d) => [d.slug, d.days]));

  /* A page update reaches every funnel, so one funnel falling after it is usually that
     funnel's own wobble. It counts only if funnels fell together on those same days. */
  const fleetDays = daily.filter((d) => d.template !== "b2b" && !INTERNAL_FUNNELS.has(d.slug) && d.client_status === "live" && !isV1(d.client_name)).map((d) => d.days);
  const fleetMemo = new Map<string, boolean>();
  const fleetFell = (day: string) => {
    if (!fleetMemo.has(day)) {
      const end = changeWindows({}, day, today).afterDays - 1;
      const sum = (from: string, to: string) => fleetDays.reduce((a, d) => { const c = sumDays(d, from, to); return { b: a.b + c.b, p: a.p + c.p }; }, { b: 0, p: 0 });
      const before = sum(addDays(day, -14), addDays(day, -1));
      const after = sum(day, addDays(day, end));
      fleetMemo.set(day, zFell(after.p, after.b, before.p, before.b) >= GO_BACK_Z);
    }
    return fleetMemo.get(day) as boolean;
  };

  const bySlug = new Map<string, ChangeRow[]>();
  for (const r of rows) {
    const list = bySlug.get(r.slug);
    if (list) list.push(r); else bySlug.set(r.slug, [r]);
  }

  const picks: { slug: string; row: ChangeRow; older: ChangeRow[]; fall: NonNullable<ReturnType<typeof fellAfterChange>> }[] = [];
  for (const f of funnels) {
    if ((f.client_status ?? "") !== "live" || locked.has(f.slug) || isV1(f.client_name)) continue;
    const history = bySlug.get(f.slug) ?? [];
    const state = stateBySlug.get(f.slug);
    /* Don't ask again about what was already tried or turned down. */
    const lastGoBack = (state?.history ?? []).filter((h) => h.action === "goback").map((h) => h.at).sort().pop() ?? "";
    const declinedAt = state?.declined_at ?? "";
    const causeDays = history.filter((h) => h.changes.some(isOtherCause)).map((h) => h.day);
    const found: { row: ChangeRow; fall: NonNullable<ReturnType<typeof fellAfterChange>> }[] = [];
    for (const row of history) {
      if (row.day < lookBack || row.saved_at <= lastGoBack || row.saved_at <= declinedAt) continue;
      const ours = row.changes.filter(isOurChange);
      if (!ours.length) continue;
      if (ours.every((c) => c.key === "engine") && !fleetFell(row.day)) continue;
      if (causeDays.some((d) => d >= addDays(row.day, -28) && d <= addDays(row.day, 27))) continue;
      const fall = fellAfterChange(days.get(f.slug) ?? {}, row.day, today);
      if (fall) found.push({ row, fall });
    }
    /* A later change also looks guilty, because its "before" days are mostly from before
       the fall. The strongest fall points at the real one. */
    found.sort((a, b) => b.fall.z - a.fall.z);
    if (found[0]) picks.push({ slug: f.slug, ...found[0], older: history });
  }
  if (!picks.length) return out;

  const [targets, latest, copies, running] = await Promise.all([
    svc.from("funnel_versions").select("id, saved_at, engine, fingerprint").in("id", picks.map((p) => p.row.prev_id)),
    svc.rpc("funnel_latest_versions"),
    svc.from("onebox_engine_copies").select("version"),
    svc.from("onebox_experiments").select("slug").eq("status", "running"),
  ]);
  const readError = targets.error ?? latest.error ?? copies.error ?? running.error;
  if (readError) throw new Error(readError.message);
  const targetById = new Map(((targets.data ?? []) as { id: number; saved_at: string; engine: number; fingerprint: Fingerprint }[]).map((v) => [v.id, v]));
  const nowBySlug = new Map(((latest.data ?? []) as { slug: string; fingerprint: Fingerprint }[]).map((v) => [v.slug, v.fingerprint]));
  const saved = new Set(((copies.data ?? []) as { version: number }[]).map((c) => c.version));
  const testing = new Set(((running.data ?? []) as { slug: string }[]).map((e) => e.slug));
  for (const { slug, row, older, fall } of picks) {
    const target = targetById.get(row.prev_id);
    const current = nowBySlug.get(slug);
    /* Only what can really come back. */
    if (!target || !current || !saved.has(target.engine) || testing.has(slug) || sameOurPage(target.fingerprint, current)) continue;
    const undoes = Array.from(new Set(older.filter((h) => h.saved_at >= row.saved_at).flatMap((h) => h.changes.filter(isOurChange).map((c) => c.label))));
    out.set(slug, { ...fall, versionId: target.id, savedAt: target.saved_at, previewSig: signLogoUrl(`fzv:${target.id}`), changeAt: row.saved_at, changes: row.changes.filter(isOurChange), undoes });
  }
  return out;
}
