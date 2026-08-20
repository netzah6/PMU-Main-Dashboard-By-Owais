import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getAppLocationToken } from "@/lib/ghl-app";
import { listCheckoutTransactions } from "@/lib/fanbasis";

export const fetchCache = "force-no-store";
export const maxDuration = 120;

// Split tests for a one-box funnel (admin only).
//   GET  ?slug=…                          → the test + per-variant results
//   POST {action:"create", slug, name, variants:[…]}
//   POST {action:"status", id, status}    (running | paused)
//   POST {action:"weights", id, weights:{a:50,b:50}}

type VariantIn = { vkey: string; label: string; kind: string; target?: string; weight?: number; config_override?: Record<string, string> };

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
    svc.from("onebox_variants").select("vkey, label, kind, target, weight, config_override").eq("experiment_id", exp.id).order("vkey"),
    svc.from("onebox_assignments").select("vkey").eq("experiment_id", exp.id),
    svc.from("onebox_leads").select("variant_key, ghl_status, ghl_appointment_id, picked_time_at, answers, created_at").eq("slug", slug).gte("created_at", exp.created_at),
    svc.from("onebox_clients").select("location_id, config, client_name, extras").eq("slug", slug).single(),
  ]);

  const visitors: Record<string, number> = {};
  for (const a of assigns ?? []) visitors[a.vkey] = (visitors[a.vkey] ?? 0) + 1;

  /* Netzah's funnel stages, per variant: leads → picked a date & time →
     paid the deposit. "picked" is cumulative (a paid lead also picked),
     which matches how the original funnel's calendar counts it. */
  const ours: Record<string, { leads: number; picked: number; paid: number }> = {};
  const ourApptIds = new Set<string>();
  for (const l of leads ?? []) {
    const k = l.variant_key ?? "?";
    const c = (ours[k] ??= { leads: 0, picked: 0, paid: 0 });
    c.leads++;
    const depositPaid = l.ghl_status === "booked" || l.ghl_status === "paid" || l.ghl_status === "paid-not-booked";
    if (depositPaid) c.paid++;
    if (depositPaid || l.picked_time_at) c.picked++;
    if (l.ghl_appointment_id) ourApptIds.add(l.ghl_appointment_id);
  }

  // An "external" variant books straight into GHL, so its bookings are the
  // calendar's appointments since the test began minus the ones we made.
  let externalBooked: number | null = null;
  const externalAppts: { email: string; addedMs: number }[] = [];
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
          const j = (await r.json()) as { events?: { id?: string; contactId?: string; dateAdded?: string; appointmentStatus?: string }[] };
          const all = (j.events ?? []).filter((e) => {
            if (e.appointmentStatus === "cancelled") return false;
            const added = e.dateAdded ? new Date(e.dateAdded).getTime() : startMs;
            return added >= startMs;
          });
          const ext = all.filter((e) => !e.id || !ourApptIds.has(e.id));
          externalBooked = ext.length;
          /* Emails of the externally-booked contacts, for the native-deposit
             window check below (payment right after booking = the original
             funnel's own flow; hours later = the AI's SMS recovery). */
          await Promise.all(ext.slice(0, 40).map(async (e) => {
            if (!e.contactId) return;
            try {
              const cr = await fetch(`https://services.leadconnectorhq.com/contacts/${e.contactId}`, {
                headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" },
                signal: AbortSignal.timeout(10000),
              });
              if (!cr.ok) return;
              const cj = (await cr.json()) as { contact?: { email?: string } };
              const em = String(cj.contact?.email ?? "").trim().toLowerCase();
              if (em) externalAppts.push({ email: em, addedMs: e.dateAdded ? new Date(e.dateAdded).getTime() : startMs });
            } catch { /* skip this appointment */ }
          }));
        }
      }
    } catch {
      /* leave null — the UI shows it as unavailable rather than wrong */
    }
  }

  /* Deposits = FUNNEL-NATIVE auto-bookings only, both sides. The AI's
     SMS follow-up collects deposits too, but that is a different channel
     and must not appear in this comparison.
     One-box side: statuses set by our on-page checkout callback (an
     AI-link payment becomes "paid-followup" and is excluded).
     Original side: their funnel holds the chosen slot for 10 minutes on
     the deposit page — so a native payment can only land while that hold
     is alive. A Fanbasis transaction from an externally-booked contact
     within 15 minutes of the appointment's creation (hold + checkout
     grace) is the funnel; anything later is the AI's SMS recovery. */
  let externalDeposits: number | null = null;
  const fanProductId = ((client?.config as Record<string, string>)?.fanbasisProductId ?? "").trim();
  if (fanProductId && externalVariant) {
    try {
      const txns = await listCheckoutTransactions(fanProductId);
      const startMs = new Date(exp.created_at as string).getTime();
      const oneboxEmails = new Set(
        (leads ?? [])
          .map((l) => String(((l.answers ?? {}) as { email?: string }).email ?? "").trim().toLowerCase())
          .filter(Boolean)
      );
      const NATIVE_WINDOW_MS = 15 * 60 * 1000;
      let ext = 0;
      for (const t of txns) {
        const raw = (t.raw ?? {}) as Record<string, unknown>;
        const created = String(raw.transaction_date ?? raw.created_at ?? raw.createdAt ?? raw.date ?? "");
        const ms = created ? Date.parse(created) : NaN;
        if (!Number.isFinite(ms) || ms < startMs) continue;
        const fanName = String(((raw.fan ?? {}) as { name?: string }).name ?? "");
        if (/test/i.test(fanName)) continue;
        if (!t.email || oneboxEmails.has(t.email)) continue; // one-box journeys count via their own statuses
        const nativePay = externalAppts.some((a) => a.email === t.email && ms - a.addedMs >= -10 * 60 * 1000 && ms - a.addedMs <= NATIVE_WINDOW_MS);
        if (nativePay) ext++;
      }
      externalDeposits = ext;
    } catch {
      /* Fanbasis unreachable -> external deposits unavailable */
    }
  }

  /* External LEADS = contacts the ORIGINAL funnel's survey created since
     the test began — counted straight from GHL by creation date + source
     ("CC - PMU Survey ..."). One-box contacts carry source "One-Box
     Funnel" and are excluded by the filter; a null (API hiccup) renders
     as the old "in GHL" note rather than a wrong number. */
  let externalLeads: number | null = null;
  if (externalVariant && client?.location_id) {
    try {
      const tok = await getAppLocationToken(client.location_id as string);
      if (tok.token) {
        const r = await fetch("https://services.leadconnectorhq.com/contacts/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tok.token}`,
            Version: "2021-07-28",
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            locationId: client.location_id,
            page: 1,
            pageLimit: 1,
            filters: [
              { field: "dateAdded", operator: "range", value: { gte: new Date(exp.created_at as string).toISOString() } },
              { field: "source", operator: "contains", value: "PMU Survey" },
            ],
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (r.ok) {
          const j = (await r.json()) as { total?: number };
          if (typeof j.total === "number") externalLeads = j.total;
        }
      }
    } catch { /* leave null — shown as unavailable, never wrong */ }
  }

  // Ad spend for this client, split across variants by their share of
  // visitors: the same ads feed both sides, so spend follows the traffic.
  // The funnel's client name rarely matches the ad account's owner name
  // ("PMU by Ivan" vs "Ivan Androsov"), so the team can pin it in Extras;
  // otherwise try the name, then its distinctive words.
  let spend7: number | null = null;
  let spendOwner: string | null = null;
  const pinned = ((client?.extras ?? {}) as { ownerName?: string }).ownerName?.trim();
  const candidates: string[] = [];
  if (pinned) candidates.push(pinned);
  else if (client?.client_name) {
    const name = String(client.client_name);
    candidates.push(name);
    for (const w of name.split(/\s+/)) {
      if (w.length > 3 && !/^(pmu|by|the|and|llc|inc|studio|beauty)$/i.test(w)) candidates.push(w);
    }
  }
  for (const c of candidates) {
    const { data: perf } = await svc
      .from("performance_overview")
      .select("owner_name, spent7")
      .ilike("owner_name", pinned && c === pinned ? c : `%${c}%`)
      .limit(1)
      .maybeSingle();
    if (perf?.spent7 != null) { spend7 = Number(perf.spent7); spendOwner = perf.owner_name as string; break; }
  }

  const totalVisitors = Object.values(visitors).reduce((a, b) => a + b, 0);
  const rows = (variants ?? []).map((v) => {
    /* Same funnel stage on both sides: "picked a date & time". For the
       original funnel that's its GHL calendar appointments (booking
       happens before the deposit there); for the one-box it's leads with
       a chosen slot. Cost/booking compares this stage apples-to-apples. */
    const vis = visitors[v.vkey] ?? 0;
    const picked = v.kind === "external" ? externalBooked : (ours[v.vkey]?.picked ?? 0);
    const leadsVal = v.kind === "external" ? externalLeads : (ours[v.vkey]?.leads ?? 0);
    const share = totalVisitors ? vis / totalVisitors : 0;
    const spend = spend7 != null ? spend7 * share : null;
    return {
      vkey: v.vkey,
      label: v.label,
      kind: v.kind,
      target: v.target,
      weight: v.weight,
      overrides: Object.keys((v as { config_override?: Record<string, string> }).config_override ?? {}),
      visitors: vis,
      leads: leadsVal,
      picked,
      deposits: v.kind === "external" ? externalDeposits : (ours[v.vkey]?.paid ?? 0),
      leadRate: vis && leadsVal != null ? +((leadsVal / vis) * 100).toFixed(1) : null,
      pickRate: vis && picked != null ? +((picked / vis) * 100).toFixed(1) : null,
      spend: spend == null ? null : +spend.toFixed(2),
      costPerBooking: spend != null && picked ? +(spend / picked).toFixed(2) : null,
    };
  });

  return NextResponse.json({
    experiment: { id: exp.id, name: exp.name, status: exp.status, startedAt: exp.created_at },
    spendWindow: spend7 == null ? null : "last 7 days",
    spendOwner,
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
    /* A comparison against the original funnel is worthless if that URL
       just redirects back to ours — which is exactly what happens after a
       cutover, since the old path now forwards to the one-box. Follow the
       URL and refuse the obvious mistake. */
    for (const v of variants) {
      if (v.kind !== "external" || !v.target) continue;
      try {
        const r = await fetch(v.target, { redirect: "follow", signal: AbortSignal.timeout(12000) });
        if (/book\.pmu-care\.com|\/f\/|\/s\//.test(r.url)) {
          return NextResponse.json(
            {
              error:
                `"${v.target}" redirects to the one-box funnel (${r.url}), so both sides would be identical. ` +
                `Use the original funnel's own URL — rename its page path with the "-ab-ghl" suffix first (the team convention: a path ending in -ab-ghl means a split test is running on that funnel).`,
            },
            { status: 400 }
          );
        }
      } catch {
        /* unreachable target: let it through rather than block on a blip */
      }
    }

    // One live test per funnel keeps the maths (and the story) simple.
    await svc.from("onebox_experiments").update({ status: "paused" }).eq("slug", slug).eq("status", "running");
    const { data: exp, error } = await svc
      .from("onebox_experiments")
      .insert({ slug, name })
      .select("id")
      .single();
    if (error || !exp) return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
    const rows = variants.map((v) => {
      const override: Record<string, string> = {};
      for (const [k, val] of Object.entries(v.config_override ?? {})) {
        if (typeof val === "string" && val.trim() && /^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(k)) {
          override[k] = val.slice(0, 2000);
        }
      }
      return {
        experiment_id: exp.id,
        vkey: String(v.vkey).slice(0, 12),
        label: String(v.label).slice(0, 120),
        kind: v.kind === "external" ? "external" : "onebox",
        target: v.target ? String(v.target).slice(0, 500) : null,
        weight: Number.isFinite(Number(v.weight)) ? Number(v.weight) : 50,
        config_override: override,
      };
    });
    const { error: vErr } = await svc.from("onebox_variants").insert(rows);
    if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: exp.id });
  }

  /* Pre-flight for STARTING an original-vs-onebox test: live-checks the
     three SOP steps so a test can only start on a wiring that actually
     works. 1) the renamed original serves at its -ab-ghl address (and is
     not a redirect back to us), 2) the ad URL redirects to the splitter,
     3) the one-box side is live with calendar + checkout configured. */
  if (action === "verifyStart") {
    const slug = String(body.slug ?? "").trim();
    const target = String(body.target ?? "").trim();
    if (!slug || !target) return NextResponse.json({ error: "slug and target required" }, { status: 400 });
    let tu: URL;
    try { tu = new URL(target); } catch { return NextResponse.json({ error: "the original-funnel URL is not a valid URL" }, { status: 400 }); }
    const namedRight = /-ab-ghl\/?$/.test(tu.pathname);

    let originalReady = false, originalNote = "";
    try {
      const r = await fetch(tu.toString(), { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(12000) });
      if (/book\.pmu-care\.com|\/s\/|\/f\//.test(r.url)) originalNote = "that URL redirects to the one-box — paste the renamed original page itself";
      else if (!r.ok) originalNote = `the page answered ${r.status} — check the renamed path`;
      else originalReady = true;
    } catch { originalNote = "could not reach it — try again"; }

    const au = new URL(tu.toString());
    au.pathname = au.pathname.replace(/(-ab-ghl|-old)\/?$/, "");
    au.search = "";
    const adUrl = au.toString();
    let redirectLive = false, redirectNote = "";
    try {
      const r = await fetch(adUrl, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(12000) });
      const loc = r.headers.get("location") ?? "";
      if (r.status >= 300 && r.status < 400 && loc.includes("/s/")) redirectLive = true;
      else if (r.status >= 300 && r.status < 400) redirectNote = `the ad URL redirects to ${loc.slice(0, 120)} — expected the splitter (…/s/${slug})`;
      else if (r.status === 404) redirectNote = "the ad URL is a dead 404 — ad clicks are being wasted; create the URL Redirect now";
      else redirectNote = "no redirect yet — the ad URL still serves a page directly";
    } catch { redirectNote = "could not reach the ad URL — try again"; }

    const { data: cRow } = await svc.from("onebox_clients").select("status, config").eq("slug", slug).maybeSingle();
    const cCfg = (cRow?.config ?? {}) as Record<string, string>;
    const oneboxReady = !!cRow && cRow.status === "live" && !!cCfg.calendarId && !!(cCfg.fanbasisProductId || cCfg.fanbasisCode);
    const oneboxNote = !cRow ? "unknown funnel"
      : cRow.status !== "live" ? "the one-box funnel is paused — set it live first"
      : !cCfg.calendarId ? "no calendar ID in Values"
      : !(cCfg.fanbasisProductId || cCfg.fanbasisCode) ? "no Fanbasis product ID in Values" : "";

    return NextResponse.json({
      ok: originalReady && redirectLive && oneboxReady,
      adUrl, namedRight,
      checks: { originalReady, originalNote, redirectLive, redirectNote, oneboxReady, oneboxNote },
    });
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

  /* Live check of the two GHL revert steps before pausing a test whose
     traffic should go back to the original funnel. The ad URL is derived
     from the external variant's target by stripping the split-test suffix:
     still redirecting to us = redirect not deleted; a 404 = redirect gone
     but the page wasn't renamed back (ad clicks are dying). */
  if (action === "verifyRevert") {
    const { data: vars } = await svc.from("onebox_variants").select("kind, target").eq("experiment_id", id);
    const ext = (vars ?? []).find((v) => v.kind === "external" && v.target);
    if (!ext?.target) return NextResponse.json({ applicable: false });
    let adUrl: string;
    try {
      const u = new URL(String(ext.target));
      u.pathname = u.pathname.replace(/(-ab-ghl|-old)\/?$/, "");
      u.search = "";
      adUrl = u.toString();
    } catch {
      return NextResponse.json({ error: "external variant URL is invalid" }, { status: 500 });
    }
    try {
      const r = await fetch(adUrl, { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(12000) });
      const toUs = /book\.pmu-care\.com|\/s\/|\/f\//.test(r.url);
      const redirectGone = !toUs;
      const pageBack = redirectGone && r.ok;
      return NextResponse.json({ applicable: true, adUrl, finalUrl: r.url, httpStatus: r.status, redirectGone, pageBack });
    } catch {
      return NextResponse.json({ error: "could not reach the ad URL — try again" }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
