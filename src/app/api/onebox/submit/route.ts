import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { sendCapiEvent, capiToken } from "@/lib/meta-capi";
import { getSurveyFieldMap, fmtReservedTime } from "@/lib/onebox";
import { pushLeadToGhl } from "@/lib/ghl-push";
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
    const slotIso = String(body.slotIso ?? "").slice(0, 40);
    const svcSlot = createServiceClient();
    const [, { data: slotClient }, { data: slotLead }] = await Promise.all([
      svcSlot
        .from("onebox_leads")
        .update({ picked_time_at: new Date().toISOString(), slot_iso: slotIso })
        .eq("slug", slug)
        .eq("phone", phone)
        .then((r) => r),
      svcSlot.from("onebox_clients").select("location_id, status, extras").eq("slug", slug).single(),
      svcSlot
        .from("onebox_leads")
        .select("ghl_contact_id, full_name, answers")
        .eq("slug", slug)
        .eq("phone", phone)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    /* Until now GHL only learned about a slot AFTER the deposit cleared, so
       a lead who picked a time but never paid looked exactly like one who
       only filled the survey — the follow-up AI could not name her slot or
       branch on it (fleet scan 2026-09-12: 0 of 124 engaged-never-asked
       leads paid). Tag the contact and fill "CC - Reserved Appointment
       Time" the moment the time is chosen; the paid path overwrites the
       same field later. B2B has no deposit step, so nothing to mark. */
    const slotExtras = (slotClient?.extras ?? {}) as { template?: string };
    const slotDisqualified = Boolean((slotLead?.answers as { disqualified?: boolean } | null)?.disqualified);
    if (slotClient && slotClient.status !== "draft" && slotExtras.template !== "b2b" && !slotDisqualified && slotIso) {
      try {
        const loc = slotClient.location_id as string;
        const tok = await getAppLocationToken(loc);
        if (!tok.token) throw new Error(tok.error ?? "no location token");
        const H = {
          Authorization: `Bearer ${tok.token}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
          Accept: "application/json",
        };
        let contactId = String(slotLead?.ghl_contact_id ?? "");
        if (!contactId) {
          // The survey upsert is what normally sets it; if that call was
          // still in flight (or failed), the same phone-deduped upsert
          // finds or creates the contact.
          const nm = String(slotLead?.full_name ?? body.full_name ?? "").trim();
          const [fn, ...ln] = nm.split(/\s+/);
          const up = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
            method: "POST", headers: H,
            body: JSON.stringify({ locationId: loc, firstName: fn, lastName: ln.join(" "), name: nm, phone, source: "One-Box Funnel" }),
          });
          const uj = (await up.json()) as { contact?: { id?: string } };
          contactId = String(uj.contact?.id ?? "");
        }
        if (contactId) {
          const fieldMap = await getSurveyFieldMap(loc, tok.token);
          await Promise.all([
            // Additive endpoint — tags in a PUT body replace the whole list.
            fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
              method: "POST", headers: H, body: JSON.stringify({ tags: ["onebox-picked-time"] }),
            }),
            fieldMap.reserved_time
              ? fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
                  method: "PUT", headers: H,
                  body: JSON.stringify({ customFields: [{ id: fieldMap.reserved_time, value: fmtReservedTime(slotIso) }] }),
                })
              : Promise.resolve(),
          ]);
        }
      } catch (e) {
        // Best effort: the lead row already records the pick either way.
        console.error("[onebox/submit] slot tag failed:", e instanceof Error ? e.message : e);
      }
    }
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
        /* Pay-per-appointment variant (2026-09-17); empty on the standard
           application and then skipped by the field/note writers. */
        services: String(body.services ?? "").slice(0, 300),
        browprice: String(body.browprice ?? "").replace(/[^0-9]/g, "").slice(0, 6),
        browflex: String(body.browflex ?? "").slice(0, 80),
        instagram: String(body.instagram ?? "").slice(0, 200),
        reviews: String(body.reviews ?? "").slice(0, 80),
        program: String(body.program ?? "").slice(0, 20),
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
  if (!isB2B) {
    /* Novel custom-survey questions (per-client surveys, engine v77+)
       arrive as extra slug-keyed body fields; keep up to 10 so their
       answers land in the stored lead and the contact note instead of
       vanishing. */
    const RESERVED = new Set(["stage", "slug", "experimentId", "variantKey", "eventId", "fbp", "fbc", "pageUrl", "surveyId", "locationId", "full_name", "phone", "email", "area", "had_pmu", "age", "commutable", "seriousness", "aftercare_kit", "source", "slotIso"]);
    let extra = 0;
    for (const [bk, bv] of Object.entries(body as Record<string, unknown>)) {
      if (extra >= 10) break;
      if (typeof bv !== "string" || !bv.trim() || RESERVED.has(bk) || !/^[a-z0-9_]{1,28}$/.test(bk)) continue;
      answers[bk] = bv.trim().slice(0, 200);
      extra++;
    }
  }
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

  // Create/upsert the contact in GHL so automations fire. Extracted to
  // src/lib/ghl-push.ts so the ghl-retry cron can re-run failed pushes.
  const push = await pushLeadToGhl({
    locationId, fullName, phone, email, answers,
    isB2B, b2bFieldMap: extras.b2b?.fieldMap, surveyTag,
    withTag: true, partial, disqualified,
  });
  const contactId = push.contactId;
  const ghlStatus = contactId ? "created" : "failed";
  if (push.error) console.error("[onebox/submit] GHL upsert failed:", push.error);

  if (leadRow?.id) {
    await svc
      .from("onebox_leads")
      .update({
        ghl_status: ghlStatus, ghl_contact_id: contactId,
        ...(push.error ? { answers: { ...answers, email, ...(disqualified ? { disqualified: true } : {}), ghl_error: push.error } } : {}),
      })
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
