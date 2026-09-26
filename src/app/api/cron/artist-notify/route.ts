import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { notifyArtistOfBooking, artistAlreadyNotified } from "@/lib/artist-notify";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

/* Artist "new appointment" notifications for one-box bookings.

   Most sub-accounts have a workflow that texts the artist when the
   Commas payment tag lands — but it needs the appointment to already
   exist at tag time, and the dashboard books within seconds of payment
   while the Commas webhook takes ~1-2 minutes: a race the workflow loses
   about half the time (2026-09-26 audit: 17 notified vs 34 silent over
   14 days). Sending instantly from the dashboard would double-notify the
   half that works, so instead this cron runs a few minutes behind each
   booking, reads the artist's own notification thread, and sends the
   same "appointment secured" text FROM THE CLIENT'S OWN SUB-ACCOUNT only
   when the account's workflow stayed silent. */

const LOOKBACK_H = 48; // bookings older than this are the backfill script's business
const SETTLE_MIN = 6;  // give the account's own workflow time to win the race

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const started = Date.now();

  const { data: clients } = await svc.from("onebox_clients").select("slug, extras");
  const b2b = new Set((clients ?? []).filter((c) => ((c.extras ?? {}) as { template?: string }).template === "b2b").map((c) => c.slug));

  const { data: leads } = await svc
    .from("onebox_leads")
    .select("id, slug, location_id, full_name, slot_iso, ghl_appointment_id, picked_time_at, created_at, answers")
    .eq("ghl_status", "booked")
    .is("artist_notified_at", null)
    .gte("created_at", new Date(Date.now() - LOOKBACK_H * 3600_000).toISOString())
    .order("created_at", { ascending: true })
    .limit(50);

  const results: string[] = [];
  let sent = 0, skipped = 0;
  for (const l of leads ?? []) {
    if (Date.now() - started > 240_000) break; // leave headroom; next run continues
    if (b2b.has(l.slug) || l.slug === "demo-v3") continue;
    if (!l.ghl_appointment_id || l.ghl_appointment_id === "manual") continue; // manual = the team booked it, the artist knows
    if (/test/i.test(l.full_name ?? "")) continue;
    const bookedAt = Date.parse(String(l.picked_time_at ?? l.created_at));
    if (Number.isFinite(bookedAt) && Date.now() - bookedAt < SETTLE_MIN * 60_000) continue; // race not settled yet
    const slotMs = Date.parse(String(l.slot_iso ?? ""));
    if (!Number.isFinite(slotMs) || slotMs <= Date.now()) {
      await svc.from("onebox_leads").update({ artist_notified_at: new Date().toISOString(), artist_notify_note: "skipped — appointment already passed" }).eq("id", l.id);
      continue;
    }

    const check = await artistAlreadyNotified(l.location_id, String(l.full_name ?? ""));
    if (!check.known) { results.push(`${l.slug}/${l.full_name}: thread unreadable, retrying next run`); continue; }
    if (check.notified) {
      skipped++;
      await svc.from("onebox_leads").update({ artist_notified_at: new Date().toISOString(), artist_notify_note: "account workflow already notified" }).eq("id", l.id);
      continue;
    }
    const n = await notifyArtistOfBooking({
      locationId: l.location_id,
      leadName: String(l.full_name ?? ""),
      area: String(((l.answers ?? {}) as { area?: string }).area ?? ""),
      slotIso: String(l.slot_iso),
    });
    if (n.ok) {
      sent++;
      await svc.from("onebox_leads").update({ artist_notified_at: new Date().toISOString(), artist_notify_note: `sent — ${n.note}` }).eq("id", l.id);
    } else {
      results.push(`${l.slug}/${l.full_name}: ${n.note}`);
    }
  }
  return NextResponse.json({ ok: true, sent, skippedAlreadyNotified: skipped, pending: results.slice(0, 10) });
}
