import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { sendSms } from "@/lib/blast";

export const maxDuration = 120;

// Sends due text blasts, a batch per minute. A blast the admin scheduled is
// picked up when send_at passes; up to BATCH recipients go out per run
// (~paced, so a 300-person blast drains over ~8 minutes without tripping
// GHL rate limits). Failures are recorded per recipient and never retried
// automatically — the Blast tab shows them for a manual decision.
const BATCH = 40;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const now = new Date().toISOString();
  const { data: jobs } = await svc
    .from("blast_jobs")
    .select("*")
    .in("status", ["scheduled", "sending"])
    .lte("send_at", now)
    .order("send_at")
    .limit(3);
  const results: Array<Record<string, unknown>> = [];

  for (const job of jobs ?? []) {
    const tok = await getAppLocationToken(job.location_id);
    if (!tok.token) {
      await svc.from("blast_jobs").update({ status: "error", error: `token: ${tok.error}`, updated_at: now }).eq("id", job.id);
      results.push({ job: job.id, error: tok.error });
      continue;
    }
    if (job.status === "scheduled") {
      await svc.from("blast_jobs").update({ status: "sending", updated_at: now }).eq("id", job.id);
    }
    const { data: queued } = await svc
      .from("blast_recipients")
      .select("id,contact_id,rendered_message")
      .eq("job_id", job.id)
      .eq("status", "queued")
      .limit(BATCH);
    let sent = 0, failed = 0;
    for (const r of queued ?? []) {
      const res = await sendSms(tok.token, r.contact_id, r.rendered_message);
      await svc.from("blast_recipients").update({
        status: res.ok ? "sent" : "failed",
        error: res.ok ? null : res.error,
        sent_at: res.ok ? new Date().toISOString() : null,
      }).eq("id", r.id);
      if (res.ok) sent++; else failed++;
      await new Promise((rr) => setTimeout(rr, 400)); // ~2.5 msg/sec
    }
    // Progress + completion
    const { count: remaining } = await svc
      .from("blast_recipients").select("*", { count: "exact", head: true })
      .eq("job_id", job.id).eq("status", "queued");
    const { count: sentTotal } = await svc
      .from("blast_recipients").select("*", { count: "exact", head: true })
      .eq("job_id", job.id).eq("status", "sent");
    const { count: failedTotal } = await svc
      .from("blast_recipients").select("*", { count: "exact", head: true })
      .eq("job_id", job.id).eq("status", "failed");
    await svc.from("blast_jobs").update({
      sent: sentTotal ?? 0, failed: failedTotal ?? 0,
      status: (remaining ?? 0) === 0 ? "done" : "sending",
      updated_at: new Date().toISOString(),
    }).eq("id", job.id);
    results.push({ job: job.id, batchSent: sent, batchFailed: failed, remaining });
  }
  return NextResponse.json({ timestamp: now, results });
}
