import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { sendCapiEvent, capiToken } from "@/lib/meta-capi";
import { getSurveyFieldMap } from "@/lib/onebox";
import { ingestRow } from "@/lib/direct-ingest";

// Never serve cached fetches: Supabase rows and GHL availability must be live.
export const fetchCache = "force-no-store";

// Public endpoint: a one-box funnel's completed survey lands here. We
// upsert the contact into the client's GHL sub-account via the
// marketplace app (dedupe by phone) and tag it "onebox-survey" so
// workflows can trigger on it. The lead is also stored in onebox_leads
// so nothing is lost if GHL is briefly unreachable.
export async function POST(req: NextRequest) {
  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const slug = String(body.slug ?? "").slice(0, 100);
  const fullName = String(body.full_name ?? "").trim().slice(0, 200);
  const phone = String(body.phone ?? "").trim().slice(0, 40);
  const email = String(body.email ?? "").trim().slice(0, 200);
  // "partial" = fired the moment a valid phone exists, so a lead who quits
  // before the email step is still captured in GHL. The later "complete"
  // call upserts the same contact (deduped by phone) with full answers.
  const stage = String(body.stage ?? "");
  const partial = stage === "partial";
  // 'slot': the lead chose a time on the calendar. Recorded so the team
  // can see who reached the deposit step but never paid.
  if (stage === "slot") {
    if (!slug || !phone) return NextResponse.json({ ok: false, error: "missing fields" }, { status: 400 });
    const svcSlot = createServiceClient();
    await svcSlot
      .from("onebox_leads")
      .update({ picked_time_at: new Date().toISOString(), slot_iso: String(body.slotIso ?? "").slice(0, 40) })
      .eq("slug", slug)
      .eq("phone", phone)
      .then(() => {});
    return NextResponse.json({ ok: true });
  }
  // Split-test attribution, passed through by the funnel page.
  const expIdRaw = String(body.experimentId ?? "").replace(/\D/g, "");
  const expId = expIdRaw ? Number(expIdRaw) : null;
  const variantKey = String(body.variantKey ?? "").slice(0, 12) || null;
  const visitorId = String(body.visitorId ?? "").slice(0, 64) || null;
  if (!slug || !fullName || !phone) {
    return NextResponse.json({ ok: false, error: "missing fields" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: client } = await svc
    .from("onebox_clients")
    .select("slug, location_id, status, config, extras")
    .eq("slug", slug)
    .single();
  if (!client || client.status === "draft") {
    return NextResponse.json({ ok: false, error: "unknown funnel" }, { status: 404 });
  }
  const locationId = client.location_id as string;
  /* B2B (agency artist-acquisition) funnel: different questions, its own
     tag, contact fields addressed by id from extras.b2b.fieldMap, and no
     disqualify rules — the agency's own workflows do the routing. */
  const extras = (client.extras ?? {}) as { template?: string; b2b?: { tag?: string; fieldMap?: Record<string, string> } };
  const isB2B = extras.template === "b2b";

  const answers: Record<string, string> = isB2B
    ? {
        area: String(body.area ?? ""),
        spots: String(body.spots ?? ""),
        weekly: String(body.weekly ?? ""),
        start: String(body.start ?? ""),
        exp: String(body.exp ?? ""),
        rev: String(body.rev ?? ""),
        want: String(body.want ?? ""),
        edge: String(body.edge ?? "").slice(0, 1500),
        utm_ad: String(body.utm_ad ?? "").slice(0, 200),
        utm_adset: String(body.utm_adset ?? "").slice(0, 200),
      }
    : {
        area: String(body.area ?? ""),
        had_pmu: String(body.had_pmu ?? ""),
        age: String(body.age ?? ""),
        commutable: String(body.commutable ?? ""),
        seriousness: String(body.seriousness ?? ""),
        aftercare_kit: String(body.aftercare_kit ?? ""),
      };
  /* The template survey's two "Disqualify after submit" rules (decoded
     from the original GHL survey's logic): not commutable, or seriousness
     0-2. Disqualified leads still land in GHL with fields + note, but
     never get the onebox-survey tag - the survey workflows must not fire
     for them (the GHL-side triggers filter on "Disqualified is false"). */
  const disqualified = !isB2B && (answers.commutable === "No" || answers.seriousness === "0-2");
  const surveyTag = isB2B ? (extras.b2b?.tag || "b2b-onebox-survey") : "onebox-survey";

  const { data: leadRow } = partial
    ? { data: null }
    : await svc
        .from("onebox_leads")
        .insert({
          slug, location_id: locationId, full_name: fullName, phone,
          answers: { ...answers, email, ...(disqualified ? { disqualified: true } : {}) },
          experiment_id: expId, variant_key: variantKey, visitor_id: visitorId,
        })
        .select("id")
        .single();

  // Create/upsert the contact in GHL so automations fire.
  let ghlStatus = "failed";
  let contactId: string | null = null;
  try {
    const tok = await getAppLocationToken(locationId);
    if (!tok.token) throw new Error(tok.error ?? "no location token");
    const [firstName, ...rest] = fullName.split(/\s+/);
    /* Survey answers also land in the contact's CUSTOM FIELDS — the
       sub-account's workflows (internal notifications, AI scripts) read
       those, not the note. Field ids matched by name per location. */
    const fieldMap = partial ? {} : isB2B ? (extras.b2b?.fieldMap ?? {}) : await getSurveyFieldMap(locationId, tok.token);
    const customFields = Object.entries(answers)
      .filter(([k, v]) => v && fieldMap[k])
      .map(([k, v]) => ({ id: fieldMap[k], value: v }));
    const r = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok.token}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        locationId,
        firstName,
        lastName: rest.join(" "),
        name: fullName,
        phone,
        ...(email ? { email } : {}),
        source: "One-Box Funnel",
        ...(customFields.length ? { customFields } : {}),
      }),
    });
    const j = (await r.json()) as { contact?: { id?: string } };
    if (!r.ok) throw new Error(`contacts/upsert ${r.status}`);
    contactId = j.contact?.id ?? null;
    ghlStatus = "created";

    /* Tag through the ADD endpoint, never through the upsert body: upsert
       REPLACES the whole tag array, which silently stripped tags other
       workflows had added (Browology's "(v3)"/"ai off", Aug 19 audit log).
       This endpoint only ever adds. */
    if (contactId && !disqualified) {
      await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok.token}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tags: [surveyTag] }),
      }).catch(() => {});
    }

    // Survey answers as a note on the contact (visible in the timeline).
    if (contactId && !partial) {
      const note = isB2B
        ? [
            "One-Box application:",
            `Area: ${answers.area}`,
            `Spots needed: ${answers.spots}`,
            `Weekly capacity: ${answers.weekly}`,
            `Ready to start: ${answers.start}`,
            `Experience: ${answers.exp}`,
            `Current revenue: ${answers.rev}`,
            `Desired revenue: ${answers.want}`,
            `What sets them apart: ${answers.edge}`,
          ].join("\n")
        : [
        "One-Box survey:",
        `Area: ${answers.area}`,
        `Had PMU before: ${answers.had_pmu}`,
        `Age group: ${answers.age}`,
        `Commutable: ${answers.commutable}`,
        `Seriousness: ${answers.seriousness}`,
        `Aftercare kit: ${answers.aftercare_kit}`,
      ].join("\n");
      await fetch(
        `https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tok.token}`,
            Version: "2021-07-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body: note }),
        }
      ).catch(() => {});
    }
  } catch (e) {
    console.error("[onebox/submit] GHL upsert failed:", e);
  }

  if (leadRow?.id) {
    await svc
      .from("onebox_leads")
      .update({ ghl_status: ghlStatus, ghl_contact_id: contactId })
      .eq("id", leadRow.id);
  }

  // Feed the LEADS pipeline the sheet path never sees. The original GHL
  // funnels write every lead to the leads sheet via the workflow's Make
  // webhook; one-box submissions bypass that entirely, so from a cutover on
  // the client silently vanished from the Leads tab (Modern Artistry,
  // Aug 19–27: 35 leads in GHL, zero on the dashboard). ingestRow shapes the
  // row exactly like a sheet row (dedupe fingerprints included) and the
  // stable external id makes retried submissions idempotent. B2B goes
  // through the agency's own pipeline; partials are half-leads — skip both.
  if (!partial && !isB2B) {
    const cfg = (client.config ?? {}) as Record<string, string>;
    const biz = String(cfg.biz ?? "").trim();
    if (biz) {
      const r = await ingestRow("leads_master", {
        full_name: fullName,
        phone,
        email,
        business_name: biz,
        date: new Date().toISOString(),
        external_id: leadRow?.id ? `onebox:${leadRow.id}` : undefined,
      }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : "ingest failed" }));
      if (!r.ok) console.error("[onebox/submit] leads ingest failed:", "error" in r ? r.error : r);
    }
  }

  // Server-side Lead: the browser pixel already fired this with the same
  // event_id, so Meta keeps one and gains the events blockers ate.
  // B2B: the agency's own GHL workflow sends the Lead CAPI (same as the
  // original funnel's survey trigger) — sending here would double count.
  if (!partial && !isB2B) {
    const cfg = (client.config ?? {}) as Record<string, string>;
    const ex = (client.extras ?? {}) as { metaPixelId?: string; capiToken?: string };
    const pixelId = (cfg.metaPixelId || ex.metaPixelId || "").replace(/\D/g, "");
    const token = capiToken(ex);
    const eventId = String(body.eventId ?? "");
    if (pixelId && token && eventId) {
      await sendCapiEvent({
        pixelId, token, eventName: "Lead", eventId,
        eventSourceUrl: String(body.pageUrl ?? "") || undefined,
        user: {
          email, phone, fullName,
          fbp: String(body.fbp ?? ""), fbc: String(body.fbc ?? ""),
          clientIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
          userAgent: req.headers.get("user-agent"),
        },
      });
    }
  }

  return NextResponse.json({ ok: true, ghl: ghlStatus });
}
