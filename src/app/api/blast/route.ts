import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { blastClients, fetchAudience, renderTemplate, DEFAULT_TEMPLATE } from "@/lib/blast";

export const maxDuration = 300;

// Admin text-blast API. Human-only: the AI tab has no route to this.
//   GET                              → client list + default template
//   GET ?locationId=X                → pipeline stages for that location
//   GET ?locationId=X&stages=a,b     → live audience preview (names+phones)
//   GET ?jobs=1                      → recent jobs with progress
//   POST {action:"schedule", ...}    → queue a blast (recipients frozen now)
//   POST {action:"cancel", jobId}    → cancel a scheduled/sending job

// Admins and Client Success Coaches (editors) may run blasts — user request
// 2026-08-27. VAs stay out (their allowlist never reaches /blast anyway).
async function requireAdmin() {
  const auth = await getAuth();
  if (!auth || (auth.role !== "admin" && auth.role !== "editor")) return null;
  return auth;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if (!auth) return NextResponse.json({ error: "Admins and coaches only" }, { status: 403 });
  const svc = createServiceClient();
  const sp = req.nextUrl.searchParams;

  if (sp.get("jobs")) {
    const { data } = await svc.from("blast_jobs").select("*").order("created_at", { ascending: false }).limit(25);
    return NextResponse.json({ jobs: data ?? [] });
  }

  const locationId = sp.get("locationId");
  if (!locationId) {
    return NextResponse.json({ clients: await blastClients(), defaultTemplate: DEFAULT_TEMPLATE });
  }

  const { data: stageRows } = await svc
    .from("ghl_stage_map")
    .select("pipeline_id,stage_id,stage_name,position")
    .eq("location_id", locationId)
    .order("position");
  const stages = stageRows ?? [];
  const stagesParam = sp.get("stages");
  if (!stagesParam) return NextResponse.json({ stages });

  const stageIds = stagesParam.split(",").filter(Boolean);
  const pipelineId = stages.find((s) => stageIds.includes(s.stage_id))?.pipeline_id;
  if (!pipelineId) return NextResponse.json({ error: "unknown stages" }, { status: 400 });
  const excludeDays = Math.max(0, Number(sp.get("excludeDays") ?? 10) || 0);
  const maxContacts = Number(sp.get("maxContacts") ?? 250) || 250;
  const audience = await fetchAudience(locationId, pipelineId, stageIds, excludeDays, maxContacts);
  return NextResponse.json(audience);
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (!auth) return NextResponse.json({ error: "Admins and coaches only" }, { status: 403 });
  const svc = createServiceClient();
  const body = await req.json();

  if (body.action === "cancel") {
    const { data: job } = await svc.from("blast_jobs").select("status").eq("id", body.jobId).single();
    if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
    if (job.status === "done") return NextResponse.json({ error: "already finished" }, { status: 400 });
    await svc.from("blast_jobs").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", body.jobId);
    await svc.from("blast_recipients").update({ status: "skipped" }).eq("job_id", body.jobId).eq("status", "queued");
    return NextResponse.json({ ok: true });
  }

  // Re-queue a failed/errored blast: failed recipients go back to queued
  // (already-sent ones are NOT re-texted) and the job re-enters the cron's
  // pickup immediately.
  if (body.action === "retry") {
    const { data: job } = await svc.from("blast_jobs").select("status").eq("id", body.jobId).single();
    if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
    if (!["failed", "error", "done", "cancelled"].includes(job.status)) return NextResponse.json({ error: "job is still active" }, { status: 400 });
    // The picker's chosen moment — required so a reschedule is always a
    // deliberate, dated decision (no accidental immediate sends).
    const sendAt = body.sendAt ? new Date(body.sendAt) : null;
    if (!sendAt || isNaN(sendAt.getTime())) return NextResponse.json({ error: "sendAt (date+time) required" }, { status: 400 });
    // Re-queue everyone who has NOT received the text (failed + skipped);
    // already-sent recipients are never re-texted.
    await svc.from("blast_recipients").update({ status: "queued", error: null }).eq("job_id", body.jobId).in("status", ["failed", "skipped"]);
    await svc.from("blast_jobs").update({
      status: "scheduled", error: null, send_at: sendAt.toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", body.jobId);
    return NextResponse.json({ ok: true });
  }

  // Remove a finished job from the list entirely (recipients first, then job).
  if (body.action === "remove") {
    const { data: job } = await svc.from("blast_jobs").select("status").eq("id", body.jobId).single();
    if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
    if (["scheduled", "sending"].includes(job.status)) return NextResponse.json({ error: "cancel it first — job is still active" }, { status: 400 });
    await svc.from("blast_recipients").delete().eq("job_id", body.jobId);
    await svc.from("blast_jobs").delete().eq("id", body.jobId);
    return NextResponse.json({ ok: true });
  }

  if (body.action !== "schedule") return NextResponse.json({ error: "unknown action" }, { status: 400 });

  const { locationId, ownerKey, clientLabel, senderName, serviceWord, stageIds, stageNames, template, sendAt, expectedCount, excludeDays, maxContacts } = body as {
    locationId: string; ownerKey: string; clientLabel: string; senderName: string; serviceWord: string;
    stageIds: string[]; stageNames: string[]; template: string; sendAt?: string; expectedCount: number;
    excludeDays?: number; maxContacts?: number;
  };
  if (!locationId || !senderName?.trim() || !template?.trim() || !stageIds?.length) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  // Re-fetch the audience server-side at schedule time — the confirmed count
  // must match what the admin saw, or we refuse (audience changed under them).
  const svc2 = createServiceClient();
  const { data: stageRows } = await svc2.from("ghl_stage_map").select("pipeline_id,stage_id").eq("location_id", locationId);
  const pipelineId = (stageRows ?? []).find((s) => stageIds.includes(s.stage_id))?.pipeline_id;
  if (!pipelineId) return NextResponse.json({ error: "unknown stages" }, { status: 400 });
  const audience = await fetchAudience(locationId, pipelineId, stageIds, Math.max(0, Number(excludeDays ?? 10) || 0), Number(maxContacts ?? 250) || 250);
  if (audience.error) return NextResponse.json({ error: `audience fetch failed: ${audience.error}` }, { status: 502 });
  if (audience.recipients.length !== expectedCount) {
    return NextResponse.json({
      error: `Audience changed: now ${audience.recipients.length} recipients (you confirmed ${expectedCount}). Re-preview and confirm again.`,
      changed: true,
    }, { status: 409 });
  }

  const { data: job, error: jerr } = await svc.from("blast_jobs").insert({
    location_id: locationId, owner_key: ownerKey ?? null, client_label: clientLabel ?? null,
    sender_name: senderName.trim(), service_word: serviceWord ?? "", stage_ids: stageIds, stage_names: stageNames ?? [],
    message_template: template, send_at: sendAt ? new Date(sendAt).toISOString() : new Date().toISOString(),
    status: "scheduled", total: audience.recipients.length, created_by: auth.email ?? auth.userId,
  }).select("id").single();
  if (jerr || !job) return NextResponse.json({ error: jerr?.message ?? "insert failed" }, { status: 500 });

  const rows = audience.recipients.map((r) => ({
    job_id: job.id, contact_id: r.contactId, name: r.name, phone: r.phone,
    rendered_message: renderTemplate(template, { firstName: r.firstName, senderName: senderName.trim(), service: serviceWord ?? "" }),
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await svc.from("blast_recipients").insert(rows.slice(i, i + 500));
    if (error) {
      await svc.from("blast_jobs").update({ status: "error", error: error.message }).eq("id", job.id);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, jobId: job.id, total: rows.length });
}
