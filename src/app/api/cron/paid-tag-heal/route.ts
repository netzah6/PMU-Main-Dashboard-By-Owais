import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { healPaidTags, resolvePaidAlerts } from "@/lib/paid-tag-heal";
import { sendMissedPurchases } from "@/lib/purchase-safety-net";
import { bookStepReachable, selfOrigin } from "@/lib/self-origin";
import { fileOrAppendAlert } from "@/lib/alerts";

export const maxDuration = 120;
export const fetchCache = "force-no-store";

const STATUS_KEY = "paid_heal_status";
const REACH_ALERT = "paid-not-booked:booking-step-unreachable";

// Every 10 min: paid deposits whose GHL contact never got the paid tag, and
// paid leads whose picked time never became an appointment.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  /* The booking fallback calls /api/onebox/book over HTTP. Its address must
     be the public one, never this request's own host (lib/self-origin). */
  const origin = selfOrigin(req);
  const reach = await bookStepReachable(origin);
  const result = await healPaidTags(svc, origin);
  const resolved = await resolvePaidAlerts(svc).catch(() => 0);
  /* After the heal (which may book a paid lead): deposits whose Purchase
     never reached Meta from the browser get it from the server. */
  const purchases = await sendMissedPurchases(svc).catch((e) => ({ error: e instanceof Error ? e.message : "failed" }));

  /* Leave a trace that can be read from the database. The cron's HTTP answer
     goes to Vercel's log only; on 11/17/2026 a failed booking sat there
     unseen for 10 hours. Kept here: when it last ran, on which host, whether
     the booking step answered, and the last booking and the last error. */
  const now = new Date().toISOString();
  try {
    const { data: prevRow } = await svc.from("app_settings").select("value").eq("key", STATUS_KEY).maybeSingle();
    const prev = ((prevRow?.value ?? {}) as Record<string, unknown>);
    await svc.from("app_settings").upsert({
      key: STATUS_KEY,
      value: {
        ...prev,
        at: now, cron_host: req.nextUrl.host, book_origin: origin, reach,
        checked: result.checked,
        ...(result.booked.length ? { last_booked: result.booked.slice(0, 10), last_booked_at: now } : {}),
        ...(result.needsPerson.length ? { last_needs_person: result.needsPerson.slice(0, 10), last_needs_person_at: now } : {}),
        ...(result.errors.length ? { last_errors: result.errors.slice(0, 10), last_error_at: now } : {}),
        ...(reach.ok ? {} : { last_unreachable_at: now }),
      },
      updated_by: "cron paid-tag-heal", updated_at: now,
    });
    if (!reach.ok) {
      await fileOrAppendAlert(svc, {
        type: "paid_not_booked", severity: "high",
        title: "The paid-deposit safety net cannot reach the booking step",
        detail: `Every 10 minutes the dashboard checks that it can call its own booking step at ${origin}. It just could not: ${reach.note}. While this lasts, a lead who pays but whose page never sends the booking is NOT booked within minutes; the 30-minute retry still books her straight in GoHighLevel once she is marked paid. This box closes by itself when the check passes again.`,
        source_key: REACH_ALERT, meta: { origin, status: reach.status, note: reach.note },
        resurfaceAfterDays: 0.02, // a new outage half an hour after the last one closed is a new box
      }, `— Still unreachable (${now.slice(0, 16).replace("T", " ")} UTC):\n"${reach.note}"`);
    } else {
      await svc.from("alerts")
        .update({ status: "resolved", resolved_by: "system (booking step reachable again)", resolved_at: now })
        .eq("type", "paid_not_booked").eq("source_key", REACH_ALERT).eq("status", "open");
    }
  } catch (e) {
    console.error("[paid-tag-heal] could not save the run status:", e instanceof Error ? e.message : e);
  }
  if (result.errors.length) console.error("[paid-tag-heal] errors:", JSON.stringify(result.errors.slice(0, 10)));
  return NextResponse.json({ timestamp: now, origin, reach, ...result, resolved, purchases });
}
