import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";
import { capiTokens, sendCapiWithTokens, recordCapi, pickFbc } from "@/lib/meta-capi";

/* Meta "RealClient" event from the artist's GHL pipeline (owner, 11/20/2026).

   Many clients never pay inside the funnel: the artist calls them, takes the
   deposit, and moves the lead between pipeline stages by hand. Meta never
   hears about those clients, so it can't tell which ads bring real clients.

   So: the first time a lead reaches "Deposit Collected", "Session Done" or
   "5 Stars Google Review" in GHL, the server sends ONE "RealClient" event to
   the funnel's dataset. Once per lead, ever — a lead that goes Deposit
   Collected → Session Done → 5-star counts once (owner's rule). Funnel
   payers get it too (they reach Deposit Collected as well), so the event
   counts every real client, however they paid. "Purchase" is untouched.

   Why the first of the three and not Session Done alone: Meta credits an
   event to an ad only inside the 7-day click window. Session Done comes a
   median 26 days after the lead (20% within 7 days); Deposit Collected a
   median 0.4 days (81% within 7 days) — checked in the GHL copy 11/20.

   How: every hour, for each live one-box funnel's GHL account, ask GHL
   live for the opportunities in those stages (filtered by stage id), and
   keep a one-row-per-lead log in `stage_conversions`. An account seen for
   the first time is only recorded ("seeded"), not sent: its existing
   clients are old news, and sending them would flood Meta on day one.
   Meta takes event_time up to 7 days back; older moves are logged as
   skipped. No GHL workflow changes — nothing for the artists to do. */

const BASE = "https://services.leadconnectorhq.com";
const DAY = 86_400_000;
const WINDOW_MS = 7 * DAY - 2 * 3600_000; // Meta's 7-day limit, with margin
const MAX_ATTEMPTS = 3;
const MAX_PAGES = 20;                      // 2,000 opportunities per stage
const SEED_MARK = "*";                     // contact_id of the "account seeded" marker row
export const REAL_CLIENT_EVENT = "RealClient" as const;

const TARGET = /^\s*(deposit collected|session done|5 stars google review)/i;
function stageLabel(name: string): string {
  if (/^\s*deposit/i.test(name)) return "Deposit Collected";
  if (/^\s*session/i.test(name)) return "Session Done";
  return "5-Star Review";
}

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
export const realClientEventId = (locationId: string, contactId: string) => `rc-${sha(`${locationId}|${contactId}`).slice(0, 32)}`;

type Funnel = { slug: string; location_id: string | null; config: Record<string, string> | null; extras: { metaPixelId?: string; capiToken?: string; template?: string } | null };
type Opp = {
  id: string; contactId?: string; pipelineStageId?: string; status?: string;
  lastStageChangeAt?: string; updatedAt?: string;
  contact?: { id?: string; name?: string; email?: string; phone?: string };
};
type LogRow = { location_id: string; contact_id: string; status: string; attempts: number };
type Lead = { phone: string | null; full_name: string | null; visitor_id: string | null; click: Record<string, string> | null; answers: Record<string, unknown> | null };

export type StageRunResult = {
  accounts: number; done: number; seededAccounts: number; seeded: number;
  sent: string[]; failed: string[]; skippedOld: number; already: number;
  errors: string[]; wouldSend?: string[];
};

async function ghlGet(token: string, url: string): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (r && r.status === 429) { await new Promise((res) => setTimeout(res, 1500 * 2 ** i)); continue; }
    if (!r || !r.ok) return null;
    return (await r.json().catch(() => null)) as Record<string, unknown> | null;
  }
  return null;
}

/* Every opportunity in one stage, live from GHL; null when GHL didn't answer
   (that account is then left for the next run, never half-seeded). */
async function oppsInStage(token: string, locationId: string, stageId: string): Promise<Opp[] | null> {
  const out: Opp[] = [];
  let url: string | null = `${BASE}/opportunities/search?location_id=${encodeURIComponent(locationId)}&pipeline_stage_id=${encodeURIComponent(stageId)}&limit=100`;
  for (let p = 0; p < MAX_PAGES && url; p++) {
    const j = await ghlGet(token, url);
    if (!j) return null;
    const opps = ((j.opportunities as Opp[]) ?? []).filter((o) => o.pipelineStageId === stageId);
    out.push(...opps);
    const next = ((j.meta as Record<string, unknown>) ?? {}).nextPageUrl as string | undefined;
    if (((j.opportunities as unknown[]) ?? []).length < 100 || !next) break;
    url = next.includes("pipeline_stage_id=") ? next : `${next}${next.includes("?") ? "&" : "?"}pipeline_stage_id=${encodeURIComponent(stageId)}`;
  }
  return out;
}

async function logRows(svc: SupabaseClient, locationId: string): Promise<Map<string, LogRow> | null> {
  const out = new Map<string, LogRow>();
  for (let i = 0; ; i += 1000) {
    const { data, error } = await svc.from("stage_conversions").select("location_id, contact_id, status, attempts")
      .eq("location_id", locationId).order("contact_id").range(i, i + 999);
    if (error) return null;
    for (const r of (data ?? []) as LogRow[]) out.set(r.contact_id, r);
    if (!data || data.length < 1000) return out;
  }
}

async function upsertLog(svc: SupabaseClient, rows: Record<string, unknown>[]): Promise<string | null> {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await svc.from("stage_conversions").upsert(rows.slice(i, i + 500), { onConflict: "location_id,contact_id" });
    if (error) return error.message;
  }
  return null;
}

/* `dry` reads GHL and the log but writes and sends nothing. With
   `assumeSeeded` (dry only) every account counts as already seeded, so a
   back-test shows who the hourly run would send in a normal week. */
export async function sendStageConversions(
  svc: SupabaseClient,
  opts: { now?: number; dry?: boolean; assumeSeeded?: boolean; timeBudgetMs?: number; onlyLocation?: string } = {},
): Promise<StageRunResult> {
  const now = opts.now ?? Date.now();
  const stopAt = opts.timeBudgetMs ? now + opts.timeBudgetMs : Infinity;
  const res: StageRunResult = { accounts: 0, done: 0, seededAccounts: 0, seeded: 0, sent: [], failed: [], skippedOld: 0, already: 0, errors: [], ...(opts.dry ? { wouldSend: [] } : {}) };

  const { data: fRows, error: fErr } = await svc.from("onebox_clients").select("slug, location_id, config, extras").eq("status", "live");
  if (fErr) throw new Error(fErr.message);
  const funnels = ((fRows ?? []) as Funnel[]).filter((f) =>
    f.location_id && f.extras?.template !== "b2b" && !/demo/i.test(f.slug)
    && (!opts.onlyLocation || f.location_id === opts.onlyLocation));
  const byLoc = new Map<string, Funnel>();
  for (const f of funnels) if (!byLoc.has(f.location_id!)) byLoc.set(f.location_id!, f);
  res.accounts = byLoc.size;
  if (!byLoc.size) return res;

  const locIds = [...byLoc.keys()];
  const stagesByLoc = new Map<string, Array<{ id: string; name: string }>>();
  for (let i = 0; i < locIds.length; i += 100) {
    const { data, error } = await svc.from("ghl_stage_map").select("location_id, stage_id, stage_name").in("location_id", locIds.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const s of (data ?? []) as Array<{ location_id: string; stage_id: string; stage_name: string }>) {
      if (!TARGET.test(s.stage_name ?? "")) continue;
      const l = stagesByLoc.get(s.location_id) ?? [];
      if (!l.some((x) => x.id === s.stage_id)) l.push({ id: s.stage_id, name: s.stage_name });
      stagesByLoc.set(s.location_id, l);
    }
  }

  /* Shuffled, so a run cut short by the time budget doesn't always skip the
     same accounts. */
  const order = locIds.map((l) => [Math.random(), l] as const).sort((a, b) => a[0] - b[0]).map(([, l]) => l);
  let next = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (next < order.length && Date.now() < stopAt) {
      const loc = order[next++];
      try { await runAccount(svc, byLoc.get(loc)!, stagesByLoc.get(loc) ?? [], now, !!opts.dry, !!(opts.dry && opts.assumeSeeded), res); res.done++; }
      catch (e) { res.errors.push(`${byLoc.get(loc)!.slug}: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`); }
    }
  }));
  return res;
}

async function runAccount(svc: SupabaseClient, f: Funnel, stages: Array<{ id: string; name: string }>, now: number, dry: boolean, assumeSeeded: boolean, res: StageRunResult): Promise<void> {
  const loc = f.location_id!;
  const log = (await logRows(svc, loc)) ?? (dry ? new Map<string, LogRow>() : null);
  if (!log) throw new Error("log table unreadable");
  const seeding = !log.has(SEED_MARK) && !assumeSeeded;

  /* Each lead once: the earliest move among the three stages. */
  const first = new Map<string, { opp: Opp; at: number; stage: string }>();
  if (stages.length) {
    const tok = await getAppLocationToken(loc);
    if (!tok.token) throw new Error(`no GHL token (${tok.error ?? "?"})`);
    for (const s of stages) {
      const opps = await oppsInStage(tok.token, loc, s.id);
      if (!opps) throw new Error("GHL did not answer");
      for (const o of opps) {
        const cid = o.contactId ?? o.contact?.id;
        if (!cid || o.status === "lost" || o.status === "abandoned") continue;
        const at = Date.parse(o.lastStageChangeAt ?? o.updatedAt ?? "");
        if (!Number.isFinite(at)) continue;
        const cur = first.get(cid);
        if (!cur || at < cur.at) first.set(cid, { opp: o, at, stage: stageLabel(s.name) });
      }
    }
  }

  if (seeding) {
    res.seededAccounts++;
    const rows: Record<string, unknown>[] = [{ location_id: loc, contact_id: SEED_MARK, slug: f.slug, status: "seeded", note: "account first seen" }];
    for (const [cid, v] of first) if (!log.has(cid)) rows.push({ location_id: loc, contact_id: cid, slug: f.slug, stage: v.stage, stage_at: new Date(v.at).toISOString(), status: "seeded" });
    res.seeded += rows.length - 1;
    if (!dry) { const err = await upsertLog(svc, rows); if (err) throw new Error(`log write: ${err}`); }
    return;
  }

  const pixelId = String(f.config?.metaPixelId || f.extras?.metaPixelId || "").replace(/\D/g, "");
  const tokens = capiTokens(f.extras);
  const later: Record<string, unknown>[] = [];

  for (const [cid, v] of first) {
    const prev = log.get(cid);
    if (prev && (prev.status !== "retry" || prev.attempts >= MAX_ATTEMPTS)) { res.already++; continue; }
    const base = { location_id: loc, contact_id: cid, slug: f.slug, stage: v.stage, stage_at: new Date(v.at).toISOString() };
    if (now - v.at > WINDOW_MS) { res.skippedOld++; later.push({ ...base, status: "skipped", error: "moved more than 7 days ago" }); continue; }

    const eventId = realClientEventId(loc, cid);
    const firstName = String(v.opp.contact?.name ?? "").trim().split(/\s+/)[0] || "lead";
    if (dry) { res.wouldSend!.push(`${firstName} (${f.slug}, ${v.stage}${pixelId ? "" : ", no pixel"})`); continue; }
    const attempts = (prev?.attempts ?? 0) + 1;
    if (!pixelId || !tokens.length) {
      const why = !pixelId ? "no pixel on funnel" : "no META_CAPI_TOKEN";
      await recordCapi(svc, { slug: f.slug, eventName: REAL_CLIENT_EVENT, eventId, pixelId, ok: false, error: why });
      later.push({ ...base, status: "failed", event_id: eventId, error: why, attempts });
      res.failed.push(`${f.slug}: ${why}`);
      continue;
    }

    const { data: lr } = await svc.from("onebox_leads").select("phone, full_name, visitor_id, click, answers")
      .eq("ghl_contact_id", cid).order("created_at", { ascending: false }).limit(5);
    const leads = (lr ?? []) as Lead[];
    const withClick = leads.find((l) => l.click?.fbc) ?? leads.find((l) => l.click);
    const fbc = pickFbc(null, withClick?.click?.fbc, null);
    const email = String(v.opp.contact?.email || leads.find((l) => l.answers?.email)?.answers?.email || "").trim();
    const phone = String(v.opp.contact?.phone || leads.find((l) => l.phone)?.phone || "");
    const sendRes = await sendCapiWithTokens({
      pixelId, eventName: REAL_CLIENT_EVENT, eventId,
      eventSourceUrl: `https://book.pmu-care.com/f/${f.slug}`,
      eventTime: Math.floor(Math.min(v.at, now) / 1000),
      customData: { stage: v.stage },
      user: {
        email, phone,
        fullName: String(v.opp.contact?.name || leads.find((l) => l.full_name)?.full_name || ""),
        fbc: fbc.fbc,
        fbp: String(leads.find((l) => l.click?.fbp)?.click?.fbp ?? ""),
        userAgent: withClick?.click?.ua,
        externalId: (withClick ?? leads.find((l) => l.visitor_id))?.visitor_id ?? null,
      },
    }, tokens).catch(() => ({ ok: false, error: "send threw", status: undefined as number | undefined }));
    await recordCapi(svc, { slug: f.slug, eventName: REAL_CLIENT_EVENT, eventId, pixelId, phone, ok: sendRes.ok, error: sendRes.error, fbcSrc: fbc.src });
    if (sendRes.ok) {
      res.sent.push(`${firstName} (${f.slug}, ${v.stage})`);
      later.push({ ...base, status: "sent", event_id: eventId, error: null, attempts, sent_at: new Date().toISOString() });
    } else {
      /* A Meta hiccup is tried again next hour; a refusal (no access to the
         dataset, bad pixel) is final. */
      const s = (sendRes as { status?: number }).status;
      const retry = !s || s >= 500 || s === 429;
      later.push({ ...base, status: retry && attempts < MAX_ATTEMPTS ? "retry" : "failed", event_id: eventId, error: (sendRes.error ?? "refused").slice(0, 300), attempts });
      res.failed.push(`${f.slug}: ${(sendRes.error ?? "refused").slice(0, 80)}`);
    }
  }
  if (!dry && later.length) { const err = await upsertLog(svc, later); if (err) res.errors.push(`${f.slug}: log write: ${err}`); }
}
