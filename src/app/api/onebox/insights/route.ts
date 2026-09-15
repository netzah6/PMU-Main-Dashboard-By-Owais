import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { runInsightScan, launchPage1Test, applyPage1Decision, buildPage1Override, page1Sides, PAGE1_TEST_NAME } from "@/lib/onebox-insights";

export const maxDuration = 120;

// The optimizer's inbox: proposed insights wait here for an explicit
// approve/deny. GET lists them (open first, then recent decisions);
// POST runs a scan or records a decision.

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const svc = createServiceClient();
  const [{ data: rows }, { data: clients }] = await Promise.all([
    svc.from("onebox_insights")
      .select("id, slug, kind, status, problem, why, solution, metrics, deny_reason, user_suggestion, decided_at, created_at")
      .order("created_at", { ascending: false })
      .limit(80),
    svc.from("onebox_clients").select("slug, client_name"),
  ]);
  const names: Record<string, string> = {};
  for (const c of clients ?? []) names[c.slug as string] = (c.client_name as string) || (c.slug as string);
  const withNames = (rows ?? []).map((r) => ({ ...r, clientName: names[r.slug as string] ?? r.slug }));
  return NextResponse.json({
    open: withNames.filter((r) => r.status === "proposed"),
    decided: withNames.filter((r) => r.status !== "proposed").slice(0, 20),
  });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const svc = createServiceClient();
  const action = String(body.action ?? "");

  if (action === "scan") {
    const result = await runInsightScan(svc, req.nextUrl.origin);
    return NextResponse.json({ ok: true, ...result });
  }

  /* The inline A/B panel on the performance table. "page1Panel" returns
     everything the dropdown needs in one trip: the newest page-1 test for
     the slug with live per-side numbers (when running), plus the proposed
     Version-B copy prefilled from the client's own data. */
  if (action === "page1Panel") {
    const slug = String(body.slug ?? "").trim();
    if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
    const { data: client } = await svc.from("onebox_clients").select("config").eq("slug", slug).single();
    if (!client) return NextResponse.json({ error: "unknown funnel" }, { status: 404 });
    const cfg = (client.config ?? {}) as Record<string, string>;
    const { data: exp } = await svc.from("onebox_experiments")
      .select("id, status, created_at").eq("slug", slug).eq("name", PAGE1_TEST_NAME)
      .order("id", { ascending: false }).limit(1).maybeSingle();
    let test: Record<string, unknown> | null = null;
    if (exp && exp.status === "running") {
      const sides = await page1Sides(svc, exp.id as number, slug, exp.created_at as string);
      const { data: vb } = await svc.from("onebox_variants").select("config_override")
        .eq("experiment_id", exp.id).eq("vkey", "b").maybeSingle();
      test = {
        expId: exp.id, startedAt: exp.created_at, ...sides,
        rateA: sides.visA ? Math.round((sides.leadsA / sides.visA) * 1000) / 10 : null,
        rateB: sides.visB ? Math.round((sides.leadsB / sides.visB) * 1000) / 10 : null,
        override: (vb?.config_override ?? {}) as Record<string, string>,
      };
    }
    return NextResponse.json({
      test,
      proposal: buildPage1Override(cfg),
      current: { headline: cfg.headline ?? "", congrats: cfg.congrats ?? "" },
    });
  }

  /* Start the 50/50 from the panel — with whatever copy the admin edited.
     Any open lead-rate flag for the slug resolves along the way. */
  if (action === "page1Start") {
    const slug = String(body.slug ?? "").trim();
    if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
    try {
      const { expId, override } = await launchPage1Test(svc, slug, {
        headline: String(body.headline ?? ""),
        congrats: String(body.congrats ?? ""),
      });
      await svc.from("onebox_insights").update({
        status: "approved", user_suggestion: `${PAGE1_TEST_NAME} #${expId} launched from the table`,
        decided_at: new Date().toISOString(), decided_by: auth.email ?? "admin", updated_at: new Date().toISOString(),
      }).eq("slug", slug).eq("kind", "low-lead-rate").eq("status", "proposed");
      return NextResponse.json({ ok: true, expId, override });
    } catch (e) {
      return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
    }
  }

  /* End a running test from the panel: keep "b" writes the new copy into
     the client's GHL values; either way the test pauses and the splitter
     goes back to 100%. */
  if (action === "page1End") {
    const expId = Number(String(body.expId ?? "").replace(/\D/g, ""));
    const keep = body.keep === "b" ? "b" : "a";
    if (!expId) return NextResponse.json({ error: "expId required" }, { status: 400 });
    const { data: exp } = await svc.from("onebox_experiments")
      .select("id, slug, name, status").eq("id", expId).maybeSingle();
    if (!exp || exp.name !== PAGE1_TEST_NAME) return NextResponse.json({ error: "not a page-1 test" }, { status: 400 });
    const { data: vb } = await svc.from("onebox_variants").select("config_override")
      .eq("experiment_id", expId).eq("vkey", "b").maybeSingle();
    try {
      const note = await applyPage1Decision(svc, exp.slug as string, {
        expId, winner: keep, override: (vb?.config_override ?? {}) as Record<string, string>,
      });
      /* the pending verdict flag (if the scan already filed one) resolves too */
      await svc.from("onebox_insights").update({
        status: "approved", user_suggestion: `decided from the table: keep ${keep === "b" ? "the new page" : "the current page"}`,
        decided_at: new Date().toISOString(), decided_by: auth.email ?? "admin", updated_at: new Date().toISOString(),
      }).eq("slug", exp.slug).eq("kind", "page1-test-done").eq("status", "proposed");
      return NextResponse.json({ ok: true, note });
    } catch (e) {
      return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
    }
  }

  /* One click on a low-lead-rate flag: create the 50/50 page-1 test for
     that client (Version B = template copy, prefilled from her data) and
     resolve the flag. The daily scan takes it from there. */
  if (action === "launchTest") {
    const id = Number(String(body.id ?? "").replace(/\D/g, ""));
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const { data: row } = await svc.from("onebox_insights")
      .select("id, slug, kind, status").eq("id", id).maybeSingle();
    if (!row || row.status !== "proposed") return NextResponse.json({ error: "flag already decided or unknown" }, { status: 409 });
    if (row.kind !== "low-lead-rate") return NextResponse.json({ error: "only lead-rate flags launch page-1 tests" }, { status: 400 });
    try {
      const { expId, override } = await launchPage1Test(svc, row.slug as string);
      await svc.from("onebox_insights").update({
        status: "approved",
        user_suggestion: `${PAGE1_TEST_NAME} #${expId} launched`,
        decided_at: new Date().toISOString(),
        decided_by: auth.email ?? "admin",
        updated_at: new Date().toISOString(),
      }).eq("id", id);
      return NextResponse.json({ ok: true, expId, override });
    } catch (e) {
      return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
    }
  }

  if (action === "decide") {
    const id = Number(String(body.id ?? "").replace(/\D/g, ""));
    const decision = body.decision === "approve" ? "approved" : body.decision === "deny" ? "denied" : null;
    if (!id || !decision) return NextResponse.json({ error: "id and decision required" }, { status: 400 });
    const reason = String(body.reason ?? "").trim().slice(0, 2000) || null;
    const suggestion = String(body.suggestion ?? "").trim().slice(0, 2000) || null;
    // A deny must teach us something — a reason or a better idea —
    // otherwise the same flag just comes back after the cooldown.
    if (decision === "denied" && !reason && !suggestion) {
      return NextResponse.json({ error: "tell me why, or suggest a different fix" }, { status: 400 });
    }
    /* A page-1 test verdict EXECUTES on approve: winner B's copy is
       written to the funnel and the test ends (deny just records). */
    const { data: pre } = await svc.from("onebox_insights")
      .select("slug, kind, metrics, status").eq("id", id).maybeSingle();
    let applied: string | null = null;
    if (pre?.status === "proposed" && pre.kind === "page1-test-done" && decision === "approved") {
      try {
        applied = await applyPage1Decision(svc, pre.slug as string, (pre.metrics ?? {}) as Record<string, unknown>);
      } catch (e) {
        return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
      }
    }
    const { data: row, error } = await svc
      .from("onebox_insights")
      .update({
        status: decision,
        deny_reason: decision === "denied" ? reason : null,
        user_suggestion: suggestion,
        decided_at: new Date().toISOString(),
        decided_by: auth.email ?? "admin",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "proposed")
      .select("id, status")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "already decided or unknown id" }, { status: 409 });
    return NextResponse.json({ ok: true, status: row.status, applied });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
