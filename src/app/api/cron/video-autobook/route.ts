import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export const maxDuration = 120;
export const fetchCache = "force-no-store";

/* Video-consult auto-confirm (owner request 2026-10-06, Brows By Kali):
   her one-box leads pick a VIDEO call time, and she wants the call
   confirmed even when no deposit is paid — but only once the lead has had
   8 minutes to pay. Every 5 minutes this books (as confirmed, via the
   same /api/onebox/book path the paid flow uses, so dedupe, the
   reserved-time field, the lead's confirmation workflow and the artist
   notification all behave identically) every lead on an opted-in client
   who picked a time 8+ minutes ago, hasn't paid, and isn't booked yet.

   Opt-in: extras.videoAutoBook === true AND extras.consultMode === "video"
   on the onebox_clients row — never fleet behavior.

   Idempotency: a booked lead carries ghl_appointment_id (set by the book
   route) and drops out of the query; a lead who pays during the 8-minute
   window is booked by the paid flow first and drops out the same way; a
   lead who pays AFTER this booked them hits the book route's exact-time
   reuse (never a second appointment). A failed booking gets the route's
   onebox-booking-failed tag and a paid-ish status, so it is not retried
   forever — the team sees the tag. */

const PAID = ["booked", "paid", "paid-not-booked", "paid-followup"];

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const { data: clients } = await svc.from("onebox_clients").select("slug, extras").eq("status", "live");
  const slugs = (clients ?? [])
    .filter((c) => {
      const ex = (c.extras ?? {}) as { consultMode?: string; videoAutoBook?: boolean };
      return ex.consultMode === "video" && ex.videoAutoBook === true;
    })
    .map((c) => c.slug as string);
  if (!slugs.length) return NextResponse.json({ ok: true, clients: 0, booked: 0 });

  const now = Date.now();
  const lo = new Date(now - 24 * 3600_000).toISOString();
  const hi = new Date(now - 8 * 60_000).toISOString();
  const { data: leads } = await svc
    .from("onebox_leads")
    .select("slug, full_name, phone, slot_iso, answers, ghl_status, ghl_appointment_id, picked_time_at")
    .in("slug", slugs)
    .is("ghl_appointment_id", null)
    .not("picked_time_at", "is", null)
    .gte("picked_time_at", lo)
    .lte("picked_time_at", hi)
    .order("picked_time_at")
    .range(0, 199);

  const base = req.nextUrl.origin;
  const results: { name: string; ok: boolean; note?: string }[] = [];
  for (const l of leads ?? []) {
    if (PAID.includes(String(l.ghl_status))) continue; // paid flow owns these
    if (!l.slot_iso || !l.full_name || !l.phone) continue;
    if (Date.parse(String(l.slot_iso)) < now) continue; // slot already passed
    const a = (l.answers ?? {}) as { email?: string; tz?: string };
    try {
      const r = await fetch(`${base}/api/onebox/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: l.slug,
          full_name: l.full_name,
          phone: l.phone,
          email: a.email ?? "",
          startTime: l.slot_iso,
          ...(a.tz ? { tz: a.tz } : {}),
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      results.push({ name: String(l.full_name), ok: !!j.ok, note: j.ok ? undefined : String(j.error ?? r.status) });
    } catch (e) {
      results.push({ name: String(l.full_name), ok: false, note: String(e).slice(0, 80) });
    }
  }
  const booked = results.filter((r) => r.ok).length;
  if (results.length) console.log("[video-autobook]", JSON.stringify(results));
  return NextResponse.json({ ok: true, clients: slugs.length, candidates: results.length, booked, results });
}
