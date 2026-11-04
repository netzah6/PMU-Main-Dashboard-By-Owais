import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { createServiceClient } from "@/lib/supabase/server";
import { fetchProgramRows, findClientProgram } from "@/lib/client-program";
import { ONEBOX_ENGINE_V, liveEngineSrc } from "@/lib/onebox-engine";
import { warmFunnel } from "@/lib/onebox-warm";
import { checkRule, hasFallen, monthKey, monthLabel, type Board, type BoardRow, type FreezeStatRow, type HistoryEntry } from "@/lib/funnel-freeze";

// The Freeze screen (/funnels/freeze), admins only.
//   GET                                   every funnel: stats, suggestion, frozen state
//   POST {slug, action:"freeze"}          keep this funnel on today's page
//   POST {slug, action:"unfreeze"}        back on the live page
//   POST {slug, action:"decline"}         stop suggesting it
//   POST {slug, action:"undecline"}       suggest it again
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type FreezeRow = {
  slug: string;
  suggested_at: string | null;
  suggested_leads: number | null;
  suggested_deposits: number | null;
  declined_at: string | null;
  declined_note: string | null;
  frozen_by: string | null;
  frozen_leads: number | null;
  frozen_deposits: number | null;
  history: HistoryEntry[] | null;
};

const INTERNAL = new Set(["demo-v3", "pmu-bookings", "pps"]);
const MONTHS_SHOWN = 7;

async function loadStats(svc: ReturnType<typeof createServiceClient>): Promise<FreezeStatRow[]> {
  const { data, error } = await svc.rpc("funnel_freeze_stats");
  if (error) throw new Error(error.message);
  return (data ?? []) as FreezeStatRow[];
}

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  let stats: FreezeStatRow[];
  try {
    stats = await loadStats(svc);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "stats failed" }, { status: 500 });
  }
  const [{ data: freezeRows }, programs] = await Promise.all([
    svc.from("funnel_freeze").select("*"),
    fetchProgramRows(svc),
  ]);
  const bySlug = new Map(((freezeRows ?? []) as FreezeRow[]).map((r) => [r.slug, r]));
  const now = new Date();
  const monthKeys = Array.from({ length: MONTHS_SHOWN }, (_, i) => monthKey(now, MONTHS_SHOWN - 1 - i));

  const firstSeen: { slug: string; suggested_at: string; suggested_leads: number; suggested_deposits: number; updated_at: string }[] = [];
  const stamp = now.toISOString();
  const rows: BoardRow[] = stats
    .filter((s) => s.template !== "b2b" && !INTERNAL.has(s.slug) && (s.status === "live" || s.frozen_engine != null))
    .map((s) => {
      const version = findClientProgram(programs, s.client_name)?.version ?? "";
      const f = bySlug.get(s.slug);
      const rule = checkRule(s, version, now);
      /* The first time the rule picks a client, its rate is written down: that
         is the "when suggested" number the screen compares against later. */
      let suggested = f?.suggested_at ? { at: f.suggested_at, l: f.suggested_leads, d: f.suggested_deposits } : null;
      if (!suggested && rule.ok && s.frozen_engine == null && !f?.declined_at) {
        suggested = { at: stamp, l: s.leads30, d: s.deposits30 };
        firstSeen.push({ slug: s.slug, suggested_at: stamp, suggested_leads: s.leads30, suggested_deposits: s.deposits30, updated_at: stamp });
      }
      return {
        slug: s.slug,
        business: s.business ?? s.client_name,
        owner: s.owner_name ?? "",
        version,
        clientStatus: s.client_status ?? "",
        months: monthKeys.map((m) => ({ m, l: s.months[m]?.l ?? 0, d: s.months[m]?.d ?? 0 })),
        before: { l: s.before_leads, d: s.before_deposits },
        now: { l: s.leads30, d: s.deposits30, picks: s.picks30 },
        lastLead: s.last_lead,
        rule,
        fell: hasFallen(s),
        suggested,
        declined: f?.declined_at ? { at: f.declined_at, note: f.declined_note } : null,
        frozen: s.frozen_engine != null
          ? { engine: s.frozen_engine, at: s.frozen_at, by: f?.frozen_by ?? null, l: f?.frozen_leads ?? null, d: f?.frozen_deposits ?? null }
          : null,
        history: f?.history ?? [],
      };
    });
  if (firstSeen.length) await svc.from("funnel_freeze").upsert(firstSeen, { onConflict: "slug" });

  const others = rows
    .filter((r) => /v3/i.test(r.version) && r.clientStatus === "live" && !r.frozen && !(r.rule.ok && !r.declined))
    .reduce((a, r) => ({ l: a.l + r.now.l, d: a.d + r.now.d }), { l: 0, d: 0 });
  const board: Board = { engine: ONEBOX_ENGINE_V, ruleMonths: [monthLabel(monthKey(now, 2)), monthLabel(monthKey(now, 1))], others, rows };
  return NextResponse.json(board);
}

/* Save today's engine file the first time anyone freezes on this version. It is
   read from the deployed file itself and has to name the version it claims. */
async function ensureEngineCopy(svc: ReturnType<typeof createServiceClient>, origin: string): Promise<string | null> {
  const { data: have } = await svc.from("onebox_engine_copies").select("version").eq("version", ONEBOX_ENGINE_V).maybeSingle();
  if (have) return null;
  const res = await fetch(new URL(liveEngineSrc, origin), { cache: "no-store" }).catch(() => null);
  const body = res?.ok ? await res.text() : "";
  if (!body.includes(`ENGINE_V = "${ONEBOX_ENGINE_V}"`)) return `Couldn't read page version ${ONEBOX_ENGINE_V}, nothing was frozen. Try again in a minute.`;
  const { error } = await svc.from("onebox_engine_copies").upsert(
    { version: ONEBOX_ENGINE_V, body, sha256: createHash("sha256").update(body).digest("hex") },
    { onConflict: "version", ignoreDuplicates: true },
  );
  return error ? error.message : null;
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { slug?: unknown; action?: unknown } | null;
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  const action = body?.action;
  if (!slug || (action !== "freeze" && action !== "unfreeze" && action !== "decline" && action !== "undecline")) {
    return NextResponse.json({ error: "slug and action (freeze|unfreeze|decline|undecline) required" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: client } = await svc.from("onebox_clients")
    .select("slug, client_name, extras, frozen_engine, frozen_at").eq("slug", slug).maybeSingle();
  if (!client) return NextResponse.json({ error: "Unknown funnel" }, { status: 404 });
  const { data: prior } = await svc.from("funnel_freeze").select("*").eq("slug", slug).maybeSingle();
  const history = ((prior as FreezeRow | null)?.history ?? []) as HistoryEntry[];
  const at = new Date().toISOString();
  const by = auth.email;

  if (action === "decline" || action === "undecline") {
    const declined = action === "decline";
    const { error } = await svc.from("funnel_freeze").upsert({
      slug,
      declined_at: declined ? at : null,
      declined_by: declined ? by : null,
      declined_note: null,
      history: [...history, { action, at, by }],
      updated_at: at,
    }, { onConflict: "slug" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, declined: declined ? { at, note: null } : null });
  }

  if (action === "unfreeze") {
    if (client.frozen_engine == null) return NextResponse.json({ ok: true, frozen: null });
    const { error } = await svc.from("onebox_clients").update({ frozen_engine: null, frozen_at: null }).eq("slug", slug);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await svc.from("funnel_freeze").upsert({ slug, history: [...history, { action, at, by, engine: client.frozen_engine }], updated_at: at }, { onConflict: "slug" });
    warmFunnel(slug);
    return NextResponse.json({ ok: true, frozen: null });
  }

  // Freeze.
  if (client.frozen_engine != null) {
    return NextResponse.json({ ok: true, frozen: { engine: client.frozen_engine, at: client.frozen_at, by: (prior as FreezeRow | null)?.frozen_by ?? null, l: (prior as FreezeRow | null)?.frozen_leads ?? null, d: (prior as FreezeRow | null)?.frozen_deposits ?? null } });
  }
  if ((client.extras as { template?: string } | null)?.template === "b2b" || INTERNAL.has(slug)) {
    return NextResponse.json({ error: "Only client funnels can be frozen." }, { status: 400 });
  }
  /* (V1) has no calendar or deposit, and a frozen funnel always keeps the full
     page, so freezing one would silently change it. */
  const program = findClientProgram(await fetchProgramRows(svc), String(client.client_name ?? ""));
  if (program?.version === "(V1)") {
    return NextResponse.json({ error: "This client is on (V1), with no calendar or deposit page. Switch the label first." }, { status: 409 });
  }
  const { data: running } = await svc.from("onebox_experiments").select("id, name").eq("slug", slug).eq("status", "running").limit(1);
  if (running?.length) {
    return NextResponse.json({ error: `A split test is running on this funnel (${running[0].name}). End it first.` }, { status: 409 });
  }
  const copyError = await ensureEngineCopy(svc, req.nextUrl.origin);
  if (copyError) return NextResponse.json({ error: copyError }, { status: 502 });

  /* The rate on the day, for "when frozen" vs "now". A stats failure never
     blocks the click: the screen shows a dash instead. */
  let leads: number | null = null;
  let deposits: number | null = null;
  try {
    const row = (await loadStats(svc)).find((s) => s.slug === slug);
    if (row) { leads = row.leads30; deposits = row.deposits30; }
  } catch { /* see above */ }

  const { error } = await svc.from("onebox_clients").update({ frozen_engine: ONEBOX_ENGINE_V, frozen_at: at }).eq("slug", slug);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await svc.from("funnel_freeze").upsert({
    slug,
    frozen_by: by,
    frozen_leads: leads,
    frozen_deposits: deposits,
    history: [...history, { action, at, by, engine: ONEBOX_ENGINE_V, leads, deposits }],
    updated_at: at,
  }, { onConflict: "slug" });
  warmFunnel(slug);
  return NextResponse.json({ ok: true, frozen: { engine: ONEBOX_ENGINE_V, at, by, l: leads, d: deposits } });
}
