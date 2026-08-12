import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

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
  const partial = String(body.stage ?? "") === "partial";
  if (!slug || !fullName || !phone) {
    return NextResponse.json({ ok: false, error: "missing fields" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: client } = await svc
    .from("onebox_clients")
    .select("slug, location_id, status")
    .eq("slug", slug)
    .single();
  if (!client || client.status === "draft") {
    return NextResponse.json({ ok: false, error: "unknown funnel" }, { status: 404 });
  }
  const locationId = client.location_id as string;

  const answers = {
    area: String(body.area ?? ""),
    had_pmu: String(body.had_pmu ?? ""),
    age: String(body.age ?? ""),
    commutable: String(body.commutable ?? ""),
    seriousness: String(body.seriousness ?? ""),
    aftercare_kit: String(body.aftercare_kit ?? ""),
  };

  const { data: leadRow } = partial
    ? { data: null }
    : await svc
        .from("onebox_leads")
        .insert({ slug, location_id: locationId, full_name: fullName, phone, answers: { ...answers, email } })
        .select("id")
        .single();

  // Create/upsert the contact in GHL so automations fire.
  let ghlStatus = "failed";
  let contactId: string | null = null;
  try {
    const tok = await getAppLocationToken(locationId);
    if (!tok.token) throw new Error(tok.error ?? "no location token");
    const [firstName, ...rest] = fullName.split(/\s+/);
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
        tags: ["onebox-survey"],
      }),
    });
    const j = (await r.json()) as { contact?: { id?: string } };
    if (!r.ok) throw new Error(`contacts/upsert ${r.status}`);
    contactId = j.contact?.id ?? null;
    ghlStatus = "created";

    // Survey answers as a note on the contact (visible in the timeline).
    if (contactId && !partial) {
      const note = [
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

  return NextResponse.json({ ok: true, ghl: ghlStatus });
}
