import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { pushLeadToGhl } from "@/lib/ghl-push";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

/* Re-push one-box leads whose GHL contact upsert failed at submit time
   (2026-09-20..22: ~290 leads existed only as bare email-only contacts the
   payment webhook created — no phone, no tag, so no AI follow-up fired).

   Tag policy: the onebox-survey tag fires the sub-account's AI outreach, so
   a retry only tags leads YOUNGER than 6 hours (a late tag there is just a
   slightly delayed version of the normal flow) and never leads that already
   paid. Older leads get contact + phone + fields + note only; firing the AI
   for a backlog is the owner's call (?tagAll=1 does it explicitly). */
const TAG_WINDOW_MS = 6 * 3600_000;
const PAID = new Set(["booked", "paid", "paid-not-booked", "paid-followup"]);

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tagAll = req.nextUrl.searchParams.get("tagAll") === "1";

  const svc = createServiceClient();
  const { data: leads } = await svc
    .from("onebox_leads")
    .select("id, slug, location_id, full_name, phone, ghl_status, answers, created_at")
    .is("ghl_contact_id", null)
    .like("ghl_status", "failed%")
    .neq("phone", "")
    .gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(40);
  if (!leads?.length) return NextResponse.json({ retried: 0 });

  const { data: clients } = await svc
    .from("onebox_clients")
    .select("slug, location_id, extras")
    .in("slug", [...new Set(leads.map((l) => l.slug))]);
  const bySlug = new Map((clients ?? []).map((c) => [c.slug as string, c]));

  let ok = 0, failed = 0, tagged = 0;
  const errors: Record<string, number> = {};
  for (const lead of leads) {
    const client = bySlug.get(lead.slug as string);
    if (!client) { failed++; continue; }
    const extras = (client.extras ?? {}) as { template?: string; b2b?: { tag?: string; fieldMap?: Record<string, string> } };
    const isB2B = extras.template === "b2b";
    const a = (lead.answers ?? {}) as Record<string, string>;
    const disqualified = a.disqualified === "true" || (a as Record<string, unknown>).disqualified === true;
    const fresh = Date.now() - new Date(lead.created_at as string).getTime() < TAG_WINDOW_MS;
    const paid = PAID.has(String(lead.ghl_status ?? ""));
    const withTag = !paid && (fresh || tagAll);

    const push = await pushLeadToGhl({
      locationId: client.location_id as string,
      fullName: String(lead.full_name ?? ""),
      phone: String(lead.phone ?? ""),
      email: String(a.email ?? ""),
      answers: a,
      isB2B, b2bFieldMap: extras.b2b?.fieldMap,
      surveyTag: isB2B ? (extras.b2b?.tag || "b2b-onebox-survey") : "onebox-survey",
      withTag, partial: false, disqualified,
    });
    if (push.contactId) {
      ok++;
      if (withTag) tagged++;
      await svc
        .from("onebox_leads")
        .update({ ghl_contact_id: push.contactId, ...(paid ? {} : { ghl_status: "created" }) })
        .eq("id", lead.id);
    } else {
      failed++;
      const key = (push.error ?? "unknown").slice(0, 80);
      errors[key] = (errors[key] ?? 0) + 1;
      await svc
        .from("onebox_leads")
        .update({ answers: { ...a, ghl_error: push.error ?? "unknown" } })
        .eq("id", lead.id);
    }
  }
  return NextResponse.json({ retried: leads.length, ok, failed, tagged, errors });
}
