import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveClientLocation, describeStep, type PlanStep } from "@/lib/agent-exec";
import { confirmToOwner, textOwner as textOwnerFn } from "@/lib/agent-notify";
import { onSetupProposalClosed, parseSetupConvId } from "@/lib/setup-run";
import { onSnapshotProposalClosed, parseSnapshotConvId } from "@/lib/pool-snapshot";

// ── AI agent, browser worker (owner, 2026-10-10) ─────────────────────────────
// Every approved account change is done in a real Chrome on the Mac Mini, on
// the same GoHighLevel screens a teammate uses, with screenshots as proof —
// the API path wrote Mindy To's hours to a legacy field GHL then mangled.
// Approve → status queued_browser. The Mac Mini claims a card (running),
// does it, and finishes it (done / failed / needs_teammate) with screenshots.
// The worker authenticates with AGENT_WORKER_SECRET; it never sees anything
// but the one task it claimed.

type Svc = SupabaseClient;
const BUCKET = "agent-proofs";
const STALE_MS = 25 * 60_000; // a claim older than this is a worker that died
const MAX_ATTEMPTS = 2;
export const WORKER_KEY = "agent_worker";

export function workerAuthorized(header: string | null): boolean {
  const secret = process.env.AGENT_WORKER_SECRET;
  return !!secret && header === `Bearer ${secret}`;
}

export type WorkerTask = {
  id: string;
  contact_name: string;
  business_name: string | null;
  location_id: string;
  summary: string;
  client_message: string;
  steps: string[];      // plain-English steps, in order
  notes: string | null; // the AI's "what to change" note
};

/* Release dead claims, then claim the oldest queued card. One worker today,
   so a conditional update (status still queued_browser) is enough. */
/* "I'm alive" — written on every claim and every mid-task ping. */
export async function touchWorker(svc: Svc, host: string, task?: string): Promise<void> {
  await svc.from("app_settings").upsert({
    key: WORKER_KEY, value: { at: new Date().toISOString(), host, ...(task ? { task } : {}) }, updated_by: "worker", updated_at: new Date().toISOString(),
  });
}

export async function claimNext(svc: Svc, host: string): Promise<WorkerTask | null> {
  await touchWorker(svc, host);

  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  const { data: stale } = await svc.from("agent_proposals").select("id, browser_attempts, result, conversation_id")
    .eq("status", "running").lt("browser_claimed_at", staleBefore);
  for (const r of (stale ?? []) as Array<{ id: string; browser_attempts: number; result: string | null; conversation_id: string }>) {
    const retry = r.browser_attempts < MAX_ATTEMPTS;
    const result = `${r.result ?? ""}\n✗ The AI Agent stopped responding twice — check the account and finish by hand`.trim();
    await svc.from("agent_proposals").update(retry
      ? { status: "queued_browser", browser_claimed_at: null }
      : { status: "failed", result },
    ).eq("id", r.id).eq("status", "running");
    // A New Client Setup step that died twice stops the run (red on the card).
    if (!retry && parseSetupConvId(r.conversation_id)) {
      try { await onSetupProposalClosed(svc, { id: r.id, conversation_id: r.conversation_id, status: "failed", result, screenshots: [] }); } catch { /* the card still shows the failed card */ }
    }
    // A pool snapshot load that died twice: the account stays "waiting for
    // snapshot" with the reason, and the Cleanup tab can queue it again.
    if (!retry && parseSnapshotConvId(r.conversation_id)) {
      try { await onSnapshotProposalClosed(svc, { id: r.id, conversation_id: r.conversation_id, status: "failed", result }); } catch { /* the pool row keeps its last note */ }
    }
  }

  const { data: next } = await svc.from("agent_proposals").select("*")
    .eq("status", "queued_browser").order("decided_at", { ascending: true }).limit(1).maybeSingle();
  if (!next) return null;
  const p = next as {
    id: string; contact_id: string | null; contact_name: string; summary: string; client_message: string;
    action_plan: PlanStep[] | null; action_detail: string | null; location_id: string | null; browser_attempts: number; conversation_id: string;
    owner_note?: string | null;
  };

  let locationId = p.location_id;
  let business: string | null = null;
  // Setup-run and pool-snapshot cards carry their location; "Clean New
  // Account N" is not a client and has no Clients Master row to resolve.
  const setupRef = parseSetupConvId(p.conversation_id) ?? parseSnapshotConvId(p.conversation_id);
  const loc = setupRef ? null : await resolveClientLocation(svc, p.contact_id, p.contact_name).catch(() => null);
  if (loc) { locationId = locationId || loc.locationId; business = loc.businessName || null; }
  if (!locationId) {
    await svc.from("agent_proposals").update({
      status: "failed", result: `✗ Could not find ${p.contact_name}'s sub-account (no Clients Master match) — do it by hand`,
    }).eq("id", p.id).eq("status", "queued_browser");
    return claimNext(svc, host);
  }

  const { data: claimed } = await svc.from("agent_proposals").update({
    status: "running", browser_claimed_at: new Date().toISOString(), browser_attempts: (p.browser_attempts ?? 0) + 1, location_id: locationId,
    result: "🤖 The AI Agent is doing this now…",
  }).eq("id", p.id).eq("status", "queued_browser").select("id").maybeSingle();
  if (!claimed) return null; // someone else took it

  const steps = (p.action_plan ?? []).filter((s) => s.type !== "payment_links").map((s) => (s.type === "manual" ? s.what : describeStep(s)));
  return {
    id: p.id, contact_name: p.contact_name, business_name: business, location_id: locationId,
    summary: p.summary, client_message: p.client_message,
    steps: steps.length ? steps : [p.action_detail || p.summary],
    // The owner's correction (Correct & retry) is the most reliable context the worker has.
    notes: [p.owner_note ? `Owner's note (authoritative): ${p.owner_note}` : "", p.action_detail ?? ""].filter(Boolean).join("\n") || null,
  };
}

export type FinishInput = {
  id: string;
  status: "done" | "failed" | "needs_teammate";
  summary: string;
  steps?: string[];
  screenshots?: Array<{ name: string; url: string }>; // from uploadProof
  files?: Array<{ name: string; url: string; bytes?: number }>; // from uploadFile (Excel, CSV, PDF…)
};

/* A file the task PRODUCED (owner, 2026-10-12: the Excel of a client's
   contacts sat on the AI Agent where nobody could reach it). Stored next to
   the screenshots; the card shows a download button. Office/CSV/PDF/text
   only — never scripts or pages. */
const FILE_TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv", pdf: "application/pdf", txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  json: "application/json",
};
export async function uploadFile(svc: Svc, id: string, name: string, base64: string): Promise<{ url?: string; bytes?: number; error?: string }> {
  const { data: row } = await svc.from("agent_proposals").select("status").eq("id", id).maybeSingle();
  if ((row as { status?: string } | null)?.status !== "running") return { error: "card is not running" };
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const type = FILE_TYPES[ext];
  if (!type) return { error: `file type .${ext} not allowed` };
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > 4_000_000) return { error: "file missing or over 4 MB" };
  const safe = name.replace(/[^A-Za-z0-9._ -]+/g, "_").slice(0, 80);
  const path = `${id}/files/${randomUUID().slice(0, 8)}-${safe}`;
  const { error } = await svc.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: false });
  if (error) return { error: error.message };
  return { url: svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl, bytes: bytes.length };
}

/* One screenshot per call — Vercel caps a request body at 4.5 MB, so the
   worker uploads each proof image first and passes the URLs to finish. */
export async function uploadProof(svc: Svc, id: string, name: string, base64: string): Promise<{ url?: string; error?: string }> {
  const { data: row } = await svc.from("agent_proposals").select("status").eq("id", id).maybeSingle();
  if ((row as { status?: string } | null)?.status !== "running") return { error: "card is not running" };
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > 4_000_000) return { error: "image missing or over 4 MB" };
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const path = `${id}/${randomUUID()}.${png ? "png" : "jpg"}`;
  const { error } = await svc.storage.from(BUCKET).upload(path, bytes, { contentType: png ? "image/png" : "image/jpeg", upsert: false });
  if (error) return { error: error.message };
  return { url: svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl };
}

export async function finishTask(svc: Svc, input: FinishInput): Promise<{ ok: boolean; error?: string }> {
  const { data: row } = await svc.from("agent_proposals").select("id, status, contact_name, summary, conversation_id").eq("id", input.id).maybeSingle();
  if (!row) return { ok: false, error: "not found" };
  const p = row as { id: string; status: string; contact_name: string; summary: string; conversation_id: string };
  if (p.status !== "running") return { ok: false, error: `card is ${p.status}, not running` };

  // Only images this card uploaded to our own bucket.
  const prefix = svc.storage.from(BUCKET).getPublicUrl(`${p.id}/`).data.publicUrl;
  const urls = (input.screenshots ?? []).filter((s) => typeof s?.url === "string" && s.url.startsWith(prefix)).slice(0, 10)
    .map((s) => ({ name: String(s.name ?? "").slice(0, 60), url: s.url }));
  const files = (input.files ?? []).filter((f) => typeof f?.url === "string" && f.url.startsWith(`${prefix}files/`)).slice(0, 10)
    .map((f) => ({ name: String(f.name ?? "").slice(0, 80), url: f.url, bytes: Number(f.bytes) || undefined }));

  const icon = input.status === "done" ? "✓" : input.status === "needs_teammate" ? "👤" : "✗";
  const lines = [`${icon} ${input.summary.slice(0, 400)}`, ...(input.steps ?? []).slice(0, 12).map((l) => `• ${String(l).slice(0, 300)}`)];
  if (!urls.length) lines.push("⚠ no screenshots came back");
  if (files.length) lines.push(`📎 ${files.length === 1 ? "1 file" : `${files.length} files`} attached below — download and send it yourself (the agent never messages clients)`);
  const result = lines.join("\n");
  const { error } = await svc.from("agent_proposals").update({
    status: input.status, result, screenshots: urls, files, executed_at: new Date().toISOString(),
  }).eq("id", p.id).eq("status", "running");
  if (error) return { ok: false, error: error.message };

  /* A New Client Setup step: tick the Onboarding card, keep the screenshots
     there, queue the next browser step. The run sends ONE text at the end
     instead of one per step (owner: "you get one text at the end"). */
  if (parseSetupConvId(p.conversation_id)) {
    try { await onSetupProposalClosed(svc, { id: p.id, conversation_id: p.conversation_id, status: input.status, result, screenshots: urls }); }
    catch { /* the card shows the step as still open; Refresh re-runs the engine */ }
    return { ok: true };
  }

  /* A pool snapshot load: mark the clean account ready (done) or keep it
     "waiting for snapshot" with the reason. The owner still gets the usual
     one text with the proof below — it is an account change like any other. */
  if (parseSnapshotConvId(p.conversation_id)) {
    try { await onSnapshotProposalClosed(svc, { id: p.id, conversation_id: p.conversation_id, status: input.status, result }); }
    catch { /* the next Re-check in the Cleanup tab marks it */ }
  }

  /* Keep-alive check: no "done" text (it would be noise 4× a day); a failure
     means the Mini could not get into GoHighLevel on its own — that IS worth
     a text, once per outage, with what to do. */
  if (p.conversation_id.startsWith("keepalive:")) {
    if (input.status !== "done") {
      const { data: al } = await svc.from("app_settings").select("value").eq("key", "agent_signin_alert").maybeSingle();
      const last = String((al?.value as { at?: string } | null)?.at ?? "");
      if (!last || Date.now() - Date.parse(last) > 6 * 3600_000) {
        try {
          await textOwnerFn(svc, `🤖 Mac Mini could not sign in to GoHighLevel by itself (${input.summary.slice(0, 120)}). On the Mini: Terminal → node ~/.pmu-agent/agent-worker.mjs login → sign in as the AI Agent user. Tasks wait until then.`);
          await svc.from("app_settings").upsert({ key: "agent_signin_alert", value: { at: new Date().toISOString() }, updated_by: "worker", updated_at: new Date().toISOString() });
        } catch { /* best effort */ }
      }
    }
    return { ok: true };
  }

  try {
    await confirmToOwner(svc, { contact_name: p.contact_name, summary: p.summary, status: input.status, result }, urls.slice(-2).map((u) => u.url));
  } catch { /* the card has the proof */ }
  return { ok: true };
}

/* ── GoHighLevel session keep-alive (owner, 10/19/2026) ──────────────────────
   The Mini's Chrome gets signed out of GoHighLevel when it sits unused (it
   happened after the Wi-Fi drop: every coach task then failed on the login
   page). Every 6 h, when the queue is idle, file one small Mini task: open
   GoHighLevel, land on the dashboard (signing in — security code from the
   mailbox — if needed), screenshot. Cards are tagged keepalive:<ts> so the AI
   tab can hide them. Runs from the agent-scan cron. */
export async function queueKeepAlive(svc: Svc): Promise<{ queued: boolean; why?: string }> {
  const since = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { count: recent } = await svc.from("agent_proposals").select("*", { count: "exact", head: true })
    .like("conversation_id", "keepalive:%").gte("created_at", since);
  if ((recent ?? 0) > 0) return { queued: false, why: "ran in the last 6 h" };
  const { count: busy } = await svc.from("agent_proposals").select("*", { count: "exact", head: true }).in("status", ["queued_browser", "running"]);
  if ((busy ?? 0) > 0) return { queued: false, why: "queue busy" };
  const ts = new Date().toISOString();
  const { error } = await svc.from("agent_proposals").insert({
    conversation_id: `keepalive:${ts}`, message_id: `keepalive#${ts.slice(0, 13)}`, contact_id: null, contact_name: "AI Agent check",
    channel: null, client_message: "Keep-alive: make sure the AI Agent is still signed in to GoHighLevel (every 6 h).",
    summary: "Keep-alive: confirm GoHighLevel sign-in", action_type: "account_change", proposed_reply: null,
    action_detail: "Open GoHighLevel and confirm this Chrome is signed in; sign in (security code from the mailbox) if not.",
    action_plan: [
      { type: "manual", what: "Open https://app.gohighlevel.com/ and wait for it to load." },
      { type: "manual", what: "If you land on the agency dashboard or any sub-account dashboard: done. Screenshot it as after-1.png. Do not change anything." },
      { type: "manual", what: "If you land on the login page or a security-code screen: follow SIGN-IN RECOVERY, then screenshot the dashboard as after-1.png." },
    ],
    location_id: AGENCY_LOCATION_ID, status: "queued_browser", decided_by: "dashboard (keep-alive)", decided_at: ts, executed_at: ts,
    result: "🤖 Queued for the AI Agent", browser_attempts: 0,
  });
  return error ? { queued: false, why: error.message } : { queued: true };
}
const AGENCY_LOCATION_ID = "SfpNMJ5YU9lBkxss47lK";

/* ── Offline alert (10/19/2026) ───────────────────────────────────────────────
   The worker was dead 16 h before anyone noticed. Every 10 min (agent-scan
   cron): if the last heartbeat is older than OFFLINE_ALERT_MS, text the owner
   ONCE for that outage (keyed on the heartbeat we alerted on, so the same
   outage never texts twice) and say what to do. When it comes back, one
   "back online" text, then the key clears. Never throws. */
const OFFLINE_ALERT_MS = 20 * 60_000;
const ALERT_KEY = "agent_worker_alert";
export async function checkWorkerOffline(svc: Svc, textOwner: (svc: Svc, msg: string) => Promise<{ sent: boolean; note: string }>): Promise<{ state: "online" | "offline"; texted?: string }> {
  const [{ data: hb }, { data: al }] = await Promise.all([
    svc.from("app_settings").select("value").eq("key", WORKER_KEY).maybeSingle(),
    svc.from("app_settings").select("value").eq("key", ALERT_KEY).maybeSingle(),
  ]);
  const at = String((hb?.value as { at?: string } | null)?.at ?? "");
  const alerted = String((al?.value as { at?: string } | null)?.at ?? "");
  const age = at ? Date.now() - Date.parse(at) : Infinity;
  const offline = age > OFFLINE_ALERT_MS;
  const { count } = await svc.from("agent_proposals").select("*", { count: "exact", head: true }).in("status", ["queued_browser", "running"]);
  const save = (value: Record<string, unknown> | null) => value
    ? svc.from("app_settings").upsert({ key: ALERT_KEY, value, updated_by: "cron", updated_at: new Date().toISOString() })
    : svc.from("app_settings").delete().eq("key", ALERT_KEY);
  if (offline && alerted !== at) {
    const mins = Number.isFinite(age) ? Math.round(age / 60_000) : null;
    const waiting = count ? ` ${count} task${count === 1 ? " is" : "s are"} waiting.` : "";
    const msg = `🖥️ Mac Mini worker is offline${mins ? ` (last seen ${mins} min ago)` : ""}.${waiting} On the Mini: make sure it is awake and online, then in Terminal run: launchctl kickstart -k gui/$(id -u)/com.pmu.agent-worker — if Claude asks to sign in, sign in and it restarts by itself.`;
    const r = await textOwner(svc, msg).catch((e) => ({ sent: false, note: e instanceof Error ? e.message : "failed" }));
    await save({ at, texted_at: new Date().toISOString(), note: r.note });
    return { state: "offline", texted: r.note };
  }
  if (!offline && alerted) {
    const r = await textOwner(svc, "🖥️ Mac Mini worker is back online and taking tasks again.").catch((e) => ({ sent: false, note: e instanceof Error ? e.message : "failed" }));
    await save(null);
    return { state: "online", texted: r.note };
  }
  return { state: offline ? "offline" : "online" };
}

