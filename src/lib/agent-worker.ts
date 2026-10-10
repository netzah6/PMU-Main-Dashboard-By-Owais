import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveClientLocation, describeStep, type PlanStep } from "@/lib/agent-exec";
import { confirmToOwner } from "@/lib/agent-notify";

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
export async function claimNext(svc: Svc, host: string): Promise<WorkerTask | null> {
  await svc.from("app_settings").upsert({
    key: WORKER_KEY, value: { at: new Date().toISOString(), host }, updated_by: "worker", updated_at: new Date().toISOString(),
  });

  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  const { data: stale } = await svc.from("agent_proposals").select("id, browser_attempts, result")
    .eq("status", "running").lt("browser_claimed_at", staleBefore);
  for (const r of (stale ?? []) as Array<{ id: string; browser_attempts: number; result: string | null }>) {
    const retry = r.browser_attempts < MAX_ATTEMPTS;
    await svc.from("agent_proposals").update(retry
      ? { status: "queued_browser", browser_claimed_at: null }
      : { status: "failed", result: `${r.result ?? ""}\n✗ The Mac Mini stopped responding twice — check the account and finish by hand`.trim() },
    ).eq("id", r.id).eq("status", "running");
  }

  const { data: next } = await svc.from("agent_proposals").select("*")
    .eq("status", "queued_browser").order("decided_at", { ascending: true }).limit(1).maybeSingle();
  if (!next) return null;
  const p = next as {
    id: string; contact_id: string | null; contact_name: string; summary: string; client_message: string;
    action_plan: PlanStep[] | null; action_detail: string | null; location_id: string | null; browser_attempts: number;
  };

  let locationId = p.location_id;
  let business: string | null = null;
  const loc = await resolveClientLocation(svc, p.contact_id, p.contact_name).catch(() => null);
  if (loc) { locationId = locationId || loc.locationId; business = loc.businessName || null; }
  if (!locationId) {
    await svc.from("agent_proposals").update({
      status: "failed", result: `✗ Could not find ${p.contact_name}'s sub-account (no Clients Master match) — do it by hand`,
    }).eq("id", p.id).eq("status", "queued_browser");
    return claimNext(svc, host);
  }

  const { data: claimed } = await svc.from("agent_proposals").update({
    status: "running", browser_claimed_at: new Date().toISOString(), browser_attempts: (p.browser_attempts ?? 0) + 1, location_id: locationId,
    result: "🖥️ The Mac Mini is doing this now…",
  }).eq("id", p.id).eq("status", "queued_browser").select("id").maybeSingle();
  if (!claimed) return null; // someone else took it

  const steps = (p.action_plan ?? []).filter((s) => s.type !== "payment_links").map((s) => (s.type === "manual" ? s.what : describeStep(s)));
  return {
    id: p.id, contact_name: p.contact_name, business_name: business, location_id: locationId,
    summary: p.summary, client_message: p.client_message,
    steps: steps.length ? steps : [p.action_detail || p.summary],
    notes: p.action_detail,
  };
}

export type FinishInput = {
  id: string;
  status: "done" | "failed" | "needs_teammate";
  summary: string;
  steps?: string[];
  screenshots?: Array<{ name: string; url: string }>; // from uploadProof
};

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
  const { data: row } = await svc.from("agent_proposals").select("id, status, contact_name, summary").eq("id", input.id).maybeSingle();
  if (!row) return { ok: false, error: "not found" };
  const p = row as { id: string; status: string; contact_name: string; summary: string };
  if (p.status !== "running") return { ok: false, error: `card is ${p.status}, not running` };

  // Only images this card uploaded to our own bucket.
  const prefix = svc.storage.from(BUCKET).getPublicUrl(`${p.id}/`).data.publicUrl;
  const urls = (input.screenshots ?? []).filter((s) => typeof s?.url === "string" && s.url.startsWith(prefix)).slice(0, 10)
    .map((s) => ({ name: String(s.name ?? "").slice(0, 60), url: s.url }));

  const icon = input.status === "done" ? "✓" : input.status === "needs_teammate" ? "👤" : "✗";
  const lines = [`${icon} ${input.summary.slice(0, 400)}`, ...(input.steps ?? []).slice(0, 12).map((l) => `• ${String(l).slice(0, 300)}`)];
  if (!urls.length) lines.push("⚠ no screenshots came back");
  const result = lines.join("\n");
  const { error } = await svc.from("agent_proposals").update({
    status: input.status, result, screenshots: urls, executed_at: new Date().toISOString(),
  }).eq("id", p.id).eq("status", "running");
  if (error) return { ok: false, error: error.message };

  try {
    await confirmToOwner(svc, { contact_name: p.contact_name, summary: p.summary, status: input.status, result }, urls.slice(-2).map((u) => u.url));
  } catch { /* the card has the proof */ }
  return { ok: true };
}
