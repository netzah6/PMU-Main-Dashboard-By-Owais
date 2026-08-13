import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getAppLocationToken } from "@/lib/ghl-app";

export const fetchCache = "force-no-store";
export const maxDuration = 120;

// Split tests for a one-box funnel (admin only).
//   GET  ?slug=…                          → the test + per-variant results
//   POST {action:"create", slug, name, variants:[…]}
//   POST {action:"status", id, status}    (running | paused)
//   POST {action:"weights", id, weights:{a:50,b:50}}

type VariantIn = { vkey: string; label: string; kind: string; target?: string; weight?: number };

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const slug = req.nextUrl.searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });

  const svc = createServiceClient();
  const { data: exp } = await svc
    .from("onebox_experiments")
    .select("id, name, status, created_at")
    .eq("slug", slug)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!exp) return NextResponse.json({ experiment: null });

  const [{ data: variants }, { data: assigns }, { data: leads }, { data: client }] = await Promise.all([
    svc.from("onebox_variants").select("vkey, label, kind, target, weight").eq("experiment_id", exp.id).order("vkey"),
    svc.from("onebox_assignments").select("vkey").eq("experiment_id", exp.id),
    svc.from("onebox_leads").select("variant_key, ghl_status, ghl_appointment_id, created_at").eq("slug", slug).gte("created_at", exp.created_at),
    svc.from("onebox_clients").select("location_id, config, client_name").eq("slug", slug).single(),
  ]);

  const visitors: Record<string, number> = {};
  for (const a of assigns ?? []) visitors[a.vkey] = (visitors[a.vkey] ?? 0) + 1;

  // Our own funnel's leads/bookings, by variant.
  const ours: Record<string, { leads: number; booked: number }> = {};
  const ourApptIds = new Set<string>();
  for (const l of leads ?? []) {
    const k = l.variant_key ?? "?";
    const c = (ours[k] ??= { leads: 0, booked: 0 });
    c.leads++;
    if (l.ghl_status === "booked") c.booked++;
    if (l.ghl_appointment_id) ourApptIds.add(l.ghl_appointment_id);
  }

  // An "external" variant books straight into GHL, so its bookings are the
  // calendar's appointments since the test began minus the ones we made.
  let externalBooked: number | null = null;
  const externalVariant = (variants ?? []).find((v) => v.kind === "external");
  const calendarId = (client?.config as Record<string, string>)?.calendarId;
  if (externalVariant && calendarId && client?.location_id) {
    try {
      const tok = await getAppLocationToken(client.location_id as string);
      if (tok.token) {
        const startMs = new Date(exp.created_at as string).getTime();
        const endMs = Date.now() + 120 * 86400000;
        const r = await fetch(
          `https://services.leadconnectorhq.com/calendars/events?locationId=${encodeURIComponent(client.location_id as string)}` +
            `&calendarId=${encodeURIComponent(calendarId)}&startTime=${startMs}&endTime=${endMs}`,
          { headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-04-15", Accept: "application/json" }, signal: AbortSignal.timeout(20000) }
        );
        if (r.ok) {
          const j = (await r.json()) as { events?: { id?: string; dateAdded?: string; appointmentStatus?: string }[] };
          const all = (j.events ?? []).filter((e) => {
            if (e.appointmentStatus === "cancelled") return false;
            const added = e.dateAdded ? new Date(e.dateAdded).getTime() : startMs;
            return added >= startMs;
          });
          externalBooked = all.filter((e) => !e.id || !ourApptIds.has(e.id)).length;
        }
      }
    } catch {
      /* leave null — the UI shows it as unavailable rather than wrong */
    }
  }

  // Ad spend for this client, split across variants by their share of
  // visitors: the same ads feed both sides, so spend follows the traffic.
  let spend7: number | null = null;
  if (client?.client_name) {
    const { data: perf } = await svc
      .from("performance_overview")
      .select("owner_name, spent7")
      .ilike("owner_name", client.client_name as string)
      .maybeSingle();
    if (perf?.spent7 != null) spend7 = Number(perf.spent7);
  }

  const totalVisitors = Object.values(visitors).reduce((a, b) => a + b, 0);
  const rows = (variants ?? []).map((v) => {
    const vis = visitors[v.vkey] ?? 0;
    const booked = v.kind === "external" ? externalBooked : (ours[v.vkey]?.booked ?? 0);
    const share = totalVisitors ? vis / totalVisitors : 0;
    const spend = spend7 != null ? spend7 * share : null;
    return {
      vkey: v.vkey,
      label: v.label,
      kind: v.kind,
      target: v.target,
      weight: v.weight,
      visitors: vis,
      leads: v.kind === "external" ? null : (ours[v.vkey]?.leads ?? 0),
      booked,
      bookRate: vis && booked != null ? +((booked / vis) * 100).toFixed(1) : null,
      spend: spend == null ? null : +spend.toFixed(2),
      costPerBooking: spend != null && booked ? +(spend / booked).toFixed(2) : null,
    };
  });

  return NextResponse.json({
    experiment: { id: exp.id, name: exp.name, status: exp.status, startedAt: exp.created_at },
    spendWindow: spend7 == null ? null : "last 7 days",
    variants: rows,
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

  if (action === "create") {
    const slug = String(body.slug ?? "").trim();
    const name = String(body.name ?? "Split test").trim().slice(0, 120);
    const variants = (body.variants as VariantIn[] | undefined) ?? [];
    if (!slug || variants.length < 2) {
      return NextResponse.json({ error: "slug and at least two variants required" }, { status: 400 });
    }
    // One live test per funnel keeps the maths (and the story) simple.
    await svc.from("onebox_experiments").update({ status: "paused" }).eq("slug", slug).eq("status", "running");
    const { data: exp, error } = await svc
      .from("onebox_experiments")
      .insert({ slug, name })
      .select("id")
      .single();
    if (error || !exp) return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
    const rows = variants.map((v) => ({
      experiment_id: exp.id,
      vkey: String(v.vkey).slice(0, 12),
      label: String(v.label).slice(0, 120),
      kind: v.kind === "external" ? "external" : "onebox",
      target: v.target ? String(v.target).slice(0, 500) : null,
      weight: Number.isFinite(Number(v.weight)) ? Number(v.weight) : 50,
    }));
    const { error: vErr } = await svc.from("onebox_variants").insert(rows);
    if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: exp.id });
  }

  const id = Number(String(body.id ?? "").replace(/\D/g, ""));
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  if (action === "status") {
    const status = body.status === "running" ? "running" : "paused";
    await svc.from("onebox_experiments").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    return NextResponse.json({ ok: true, status });
  }

  if (action === "weights") {
    const weights = (body.weights ?? {}) as Record<string, number>;
    for (const [vkey, w] of Object.entries(weights)) {
      await svc
        .from("onebox_variants")
        .update({ weight: Math.max(0, Math.min(100, Number(w) || 0)) })
        .eq("experiment_id", id)
        .eq("vkey", vkey);
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
