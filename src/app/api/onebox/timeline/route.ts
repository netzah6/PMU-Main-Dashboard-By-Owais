import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { createServiceClient } from "@/lib/supabase/server";
import { fetchProgramRows, findClientProgram } from "@/lib/client-program";
import { INTERNAL_FUNNELS, freezeBlockedReason } from "@/lib/funnel-freeze-server";
import { ONEBOX_ENGINE_V } from "@/lib/onebox-engine";
import { frozenDrift, type FrozenPage, type OneboxRow } from "@/lib/onebox-page";
import { signLogoUrl } from "@/lib/logo-sign";
import { warmFunnel } from "@/lib/onebox-warm";
import { dailySince, findGoBackSuggestions, loadDaily, runFunnelTimeline, samePage, type ChangeItem, type DailyRow, type Fingerprint } from "@/lib/funnel-timeline";
import { addDays, changeWindows, flagFall, pacificDay, sumDays, type DayCounts, type GoBackSuggestion, type TimelineBoard, type TimelineDetail, type TimelineRow, type TimelineVersion } from "@/lib/funnel-timeline-view";
import type { HistoryEntry } from "@/lib/funnel-freeze";

// The Timeline screen (/funnels/timeline), admins only.
//   GET                                  every funnel: last 14 days vs the 14 before, last change
//   GET ?slug=x                          one funnel: every saved version with its rates, and notes
//   POST {action:"goback", slug, versionId}  lock the funnel on that saved page
//   POST {action:"note", slug?, note}    add a note (no slug = all funnels)
//   POST {action:"save"}                 save now instead of waiting for the cron
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300; // warmFunnel's pings run 150 s after the response

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const today = pacificDay(new Date());
  const slug = req.nextUrl.searchParams.get("slug")?.trim();
  if (slug && !/^[a-z0-9-]+$/.test(slug)) return NextResponse.json({ error: "Unknown funnel" }, { status: 404 });

  if (slug) {
    const [{ data: versions, error: vErr }, { data: notes, error: nErr }, { data: copies }] = await Promise.all([
      svc.from("funnel_versions").select("id, saved_at, engine, frozen, fingerprint, changes").eq("slug", slug).order("saved_at", { ascending: false }).order("id", { ascending: false }).limit(300),
      svc.from("funnel_notes").select("id, at, note, by, slug").or(`slug.eq.${slug},slug.is.null`).order("at", { ascending: false }).limit(300),
      svc.from("onebox_engine_copies").select("version"),
    ]);
    const firstError = vErr ?? nErr;
    if (firstError) return NextResponse.json({ error: firstError.message }, { status: 500 });
    const rows = (versions ?? []) as { id: number; saved_at: string; engine: number; frozen: boolean; fingerprint: Fingerprint; changes: ChangeItem[] }[];
    const saved = new Set(((copies ?? []) as { version: number }[]).map((c) => c.version));
    /* The history still opens if the counting fails: it just shows no rates. */
    const oldest = rows.length ? pacificDay(new Date(rows[rows.length - 1].saved_at)) : today;
    let days: Record<string, DayCounts> | null = null;
    try {
      days = (await loadDaily(svc, addDays(oldest, -28))).find((d) => d.slug === slug)?.days ?? {};
    } catch { /* see above */ }
    const current = rows[0]?.fingerprint;
    const out: TimelineVersion[] = rows.map((v, i) => ({
      id: v.id,
      savedAt: v.saved_at,
      engine: v.engine,
      frozen: v.frozen,
      changes: v.changes ?? [],
      isNow: i === 0,
      samePageAsNow: !!current && samePage(v.fingerprint, current),
      engineSaved: saved.has(v.engine),
      previewSig: signLogoUrl(`fzv:${v.id}`),
      windows: days ? changeWindows(days, pacificDay(new Date(v.saved_at)), today) : null,
    }));
    const detail: TimelineDetail = {
      versions: out,
      notes: ((notes ?? []) as { id: number; at: string; note: string; by: string | null; slug: string | null }[]).map((n) => ({ id: n.id, at: n.at, note: n.note, allFunnels: n.slug == null })),
    };
    return NextResponse.json(detail);
  }

  const [dailyRows, { data: latest, error: lErr }, programs] = await Promise.all([
    loadDaily(svc, dailySince(today)).catch((e: unknown) => (e instanceof Error ? e : new Error("Couldn't count"))),
    svc.rpc("funnel_latest_versions"),
    fetchProgramRows(svc),
  ]);
  if (dailyRows instanceof Error) return NextResponse.json({ error: dailyRows.message }, { status: 500 });
  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 });
  const latestBySlug = new Map(((latest ?? []) as { slug: string; saved_at: string; changes: ChangeItem[] }[]).map((v) => [v.slug, v]));
  /* Suggestions are extra: the screen still opens, and says so, if they can't be worked out. */
  let suggestionsFailed = false;
  const suggestions = await findGoBackSuggestions(svc, dailyRows, programs, new Date()).catch(() => {
    suggestionsFailed = true;
    return new Map<string, GoBackSuggestion>();
  });
  const rows: TimelineRow[] = (dailyRows as DailyRow[])
    .filter((d) => d.template !== "b2b" && !INTERNAL_FUNNELS.has(d.slug) && (d.status === "live" || d.frozen_engine != null))
    .map((d) => {
      const last14 = sumDays(d.days, addDays(today, -13), today);
      const prev14 = sumDays(d.days, addDays(today, -27), addDays(today, -14));
      const last28 = sumDays(d.days, addDays(today, -27), today);
      const prev28 = sumDays(d.days, addDays(today, -55), addDays(today, -28));
      const version = findClientProgram(programs, d.client_name)?.version ?? "";
      const v = latestBySlug.get(d.slug);
      return {
        slug: d.slug,
        business: d.business ?? d.client_name,
        owner: d.owner_name ?? "",
        version,
        clientStatus: d.client_status ?? "",
        freeBooking: d.free_booking,
        last14,
        prev14,
        fall: flagFall(last14, prev14, last28, prev28, version === "(V1)"),
        goBack: suggestions.get(d.slug) ?? null,
        lastChange: v ? { at: v.saved_at, changes: v.changes ?? [] } : null,
        lockedAt: d.frozen_engine != null ? d.frozen_at : null,
      };
    });
  const board: TimelineBoard = { engine: ONEBOX_ENGINE_V, rows, suggestionsFailed };
  return NextResponse.json(board);
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { action?: unknown; slug?: unknown; versionId?: unknown; note?: unknown } | null;
  const svc = createServiceClient();
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";

  if (body?.action === "save") {
    try {
      return NextResponse.json({ ok: true, ...(await runFunnelTimeline(svc, { origin: req.nextUrl.origin })) });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't save" }, { status: 500 });
    }
  }

  if (body?.action === "note") {
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
    if (!note) return NextResponse.json({ error: "Write a note first." }, { status: 400 });
    const { data, error } = await svc.from("funnel_notes").insert({ slug: slug || null, note, by: auth.email }).select("id, at").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, note: { id: data.id, at: data.at, note, allFunnels: !slug } });
  }

  if (body?.action !== "goback" || !slug || typeof body.versionId !== "number") {
    return NextResponse.json({ error: "action required" }, { status: 400 });
  }

  const [{ data: client }, { data: version }, { data: priorRow, error: priorError }] = await Promise.all([
    svc.from("onebox_clients").select("*").eq("slug", slug).maybeSingle(),
    svc.from("funnel_versions").select("id, saved_at, engine, page").eq("id", body.versionId).eq("slug", slug).maybeSingle(),
    svc.from("funnel_freeze").select("*").eq("slug", slug).maybeSingle(),
  ]);
  if (!client) return NextResponse.json({ error: "Unknown funnel" }, { status: 404 });
  if (!version) return NextResponse.json({ error: "That saved page wasn't found." }, { status: 404 });
  if (priorError) return NextResponse.json({ error: "Couldn't read this funnel's record. Try again." }, { status: 503 });
  const blocked = await freezeBlockedReason(svc, client);
  if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status });
  const { data: copy, error: copyError } = await svc.from("onebox_engine_copies").select("version").eq("version", version.engine).maybeSingle();
  if (copyError) return NextResponse.json({ error: "Couldn't check that page version. Try again." }, { status: 503 });
  if (!copy) return NextResponse.json({ error: `Page version ${version.engine} wasn't saved, so this page can't come back.` }, { status: 409 });

  const prior = priorRow as { history: HistoryEntry[] | null } | null;
  const origin = req.nextUrl.origin;
  /* The page being replaced gets its own row first, so it can come back too. */
  await runFunnelTimeline(svc, { origin, slug }).catch(() => {});
  const at = new Date().toISOString();
  const by = auth.email;
  const { error } = await svc.from("onebox_clients").update({ frozen_engine: version.engine, frozen_at: at, frozen_page: version.page }).eq("slug", slug);
  if (error) return NextResponse.json({ error: "The page didn't change. Try again." }, { status: 500 });
  const { error: recordError } = await svc.from("funnel_freeze").upsert({
    slug,
    frozen_by: by,
    frozen_leads: null,
    frozen_deposits: null,
    history: [...(prior?.history ?? []), { action: "goback", at, by, engine: version.engine }],
    updated_at: at,
  }, { onConflict: "slug" });
  const savedOn = new Date(version.saved_at).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "America/Los_Angeles" });
  await svc.from("funnel_notes").insert({ slug, note: `Went back to the page saved ${savedOn}`, by });
  warmFunnel(slug);
  await runFunnelTimeline(svc, { origin, slug }).catch(() => {});
  return NextResponse.json({
    ok: true,
    lockedAt: at,
    engine: version.engine,
    warning: recordError ? "The page changed, but its history entry wasn't saved, so this suggestion may come back." : undefined,
    /* The AI reads the live values, so the page and the AI can now disagree. */
    drift: frozenDrift({ ...(client as OneboxRow), frozen_page: version.page as FrozenPage }).map((d) => d.label),
  });
}
