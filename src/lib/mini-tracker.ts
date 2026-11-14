import type { SupabaseClient } from "@supabase/supabase-js";
import { queueLane } from "@/lib/agent-worker";
import { parseSetupConvId } from "@/lib/setup-run";
import { runSteps, stepState, type RunbookStep, type SetupState } from "@/lib/setup-runbook";
import { parseSnapshotConvId } from "@/lib/pool-snapshot";
import { parseA2pConvId } from "@/lib/pool-a2p";
import { parseCnamConvId } from "@/lib/pool-cnam";
import { parseIgPostsConvId } from "@/lib/ig-posts-check";
import { isCloseBotCheck } from "@/lib/closebot-coverage";
import { getSettings as getIgSettings, isIgEngageTask, nextRunAt as igNextRunAt } from "@/lib/ig-engage";

/* The Mac Mini tracker (owner, 2026-10-16: "I switch tabs and come back and I
   have no idea what's going on"). A light read polled every ~20 s.

   Owner 11/10/2026: one list of EVERYTHING the Mac Mini does, on both the AI
   tab and the Onboarding tab (before, each tab showed only its own, so a
   client setup running on the Mini looked like "Nothing running" on the AI
   tab). It answers three questions:
   - what it did (finished in the last 24 hours),
   - what it is doing now,
   - what comes next and roughly when: the queue in the order the worker
     really takes it (claimNext: setups first, then approved client changes,
     then background checks; oldest first in each), each with an estimated
     start from how long that kind of task usually takes; plus the recurring
     jobs that will file new tasks later (weekly checks, Instagram run,
     GoHighLevel keep-alive).
   Admin only, same as the agent inbox. */
const FINISHED_WINDOW_MS = 24 * 3600_000;
export const FINISHED_MAX = 100;
const HISTORY_WINDOW_MS = 14 * 86_400_000; // durations for the time estimates
const MIN_REAL_RUN_MS = 60_000;            // shorter = failed at once (signed out, …): not a real duration
const DEFAULT_RUN_MS = 8 * 60_000;
const GAP_MS = 45_000;                     // claim → Chrome up, and Chrome closing after a task
const OFFLINE_MS = 3 * 60_000;             // same threshold as the tracker's online badge
const KEEPALIVE_EVERY_MS = 6 * 3600_000;   // queueKeepAlive in lib/agent-worker

type Row = {
  id: string; conversation_id: string | null; contact_name: string; summary: string; status: string;
  created_at: string; decided_at: string | null; browser_claimed_at: string | null; browser_attempts: number | null; executed_at: string | null;
};

/* What kind of Mini task a card is — for the label and the time estimate. */
function taskKind(conv: string | null): string {
  if (parseSetupConvId(conv)) return "setup";
  if (parseSnapshotConvId(conv)) return "snapshot";
  if (parseA2pConvId(conv)) return "a2p";
  if (parseCnamConvId(conv)) return "cnam";
  if (isCloseBotCheck(conv)) return "closebot";
  if (isIgEngageTask(conv)) return "igengage";
  if (parseIgPostsConvId(conv)) return "igposts";
  if (conv?.startsWith("keepalive:")) return "keepalive";
  return "task";
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/* Next weekday/hour in UTC strictly after `from` (0 = Sunday). */
function nextWeeklyUtc(from: Date, weekday: number, hour: number): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour));
  d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7));
  if (d.getTime() <= from.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString();
}

/* A client setup files its Mac Mini cards ONE AT A TIME (setup-run
   ensureMiniCard, when the previous card finishes), always in lane 0 — so
   they jump ahead of everything else. The queue alone would show a client
   change as "next" while a setup still has an hour of cards to file. Count
   the cards each running setup still has to file, grouped the same way
   (back-to-back "todo" steps of one batch = one card). An estimate: the
   chain stops at a failed step or an "asks you" step not approved up front. */
async function setupCardsToCome(svc: SupabaseClient, onboardingIds: string[]): Promise<Array<{ id: string; name: string; cards: number }>> {
  if (!onboardingIds.length) return [];
  const { data } = await svc.from("onboardings").select("id, form, setup").in("id", onboardingIds);
  const browserSteps = runSteps().filter((s) => s.who === "mini" || s.who === "ask");
  const out: Array<{ id: string; name: string; cards: number }> = [];
  for (const row of (data ?? []) as Array<{ id: string; form: Record<string, string> | null; setup: SetupState | null }>) {
    const setup = row.setup;
    if (!setup || setup.status !== "running") continue;
    if (browserSteps.some((s) => stepState(setup, s.key).status === "failed")) continue;
    const isV3 = /v3/i.test(String(row.form?.version ?? ""));
    let cards = 0;
    let prev: RunbookStep | null = null;
    for (const s of browserSteps) {
      if (stepState(setup, s.key).status !== "todo" || (s.v3Only && !isV3)) { prev = null; continue; }
      if (s.who === "ask" && !(setup.preapproved ?? []).includes(s.key)) break;
      if (!(prev && s.batch && prev.batch === s.batch)) cards++;
      prev = s;
    }
    if (cards) out.push({ id: row.id, name: String(row.form?.business_name ?? "").trim() || "Client setup", cards });
  }
  return out;
}

export type TrackerData = Awaited<ReturnType<typeof trackerData>>;

/* Everything the tracker shows, for one moment `now` (ms). Throws on a read error. */
export async function trackerData(svc: SupabaseClient, now = Date.now()) {
  const cols = "id, conversation_id, contact_name, summary, status, created_at, decided_at, browser_claimed_at, browser_attempts, executed_at";
  const [active, finished, history, worker, lastKeepAlive, ig] = await Promise.all([
    // Same order and cap as claimNext, so "next" here is the worker's next.
    svc.from("agent_proposals").select(cols).in("status", ["queued_browser", "running"])
      .order("decided_at", { ascending: true }).limit(500),
    svc.from("agent_proposals").select(cols).in("status", ["done", "failed", "needs_teammate"])
      .gte("executed_at", new Date(now - FINISHED_WINDOW_MS).toISOString()).not("browser_claimed_at", "is", null)
      .order("executed_at", { ascending: false }).limit(FINISHED_MAX),
    svc.from("agent_proposals").select("conversation_id, browser_claimed_at, executed_at").in("status", ["done", "failed", "needs_teammate"])
      .gte("executed_at", new Date(now - HISTORY_WINDOW_MS).toISOString()).not("browser_claimed_at", "is", null)
      .order("executed_at", { ascending: false }).limit(1000),
    svc.from("app_settings").select("value").eq("key", "agent_worker").maybeSingle(),
    svc.from("agent_proposals").select("created_at").like("conversation_id", "keepalive:%")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    getIgSettings(svc).catch(() => null),
  ]);
  const err = active.error ?? finished.error;
  if (err) throw new Error(err.message);

  // How long each kind of task usually takes on the Mini (median of real runs).
  const byKind = new Map<string, number[]>();
  for (const h of (history.data ?? []) as Array<{ conversation_id: string | null; browser_claimed_at: string; executed_at: string }>) {
    const ms = Date.parse(h.executed_at) - Date.parse(h.browser_claimed_at);
    if (!(ms >= MIN_REAL_RUN_MS)) continue;
    const k = taskKind(h.conversation_id);
    byKind.set(k, [...(byKind.get(k) ?? []), ms]);
  }
  const allRuns = Array.from(byKind.values()).flat();
  const fallback = median(allRuns) ?? DEFAULT_RUN_MS;
  const typical = (conv: string | null) => median(byKind.get(taskKind(conv)) ?? []) ?? fallback;

  const workerVal = ((worker.data as { value?: { at?: string } } | null)?.value ?? null) as { at?: string } | null;
  const online = !!workerVal?.at && now - Date.parse(workerVal.at) < OFFLINE_MS;

  const rows = (active.data ?? []) as Row[];
  const running = rows.filter((r) => r.status === "running");
  const queued = rows.filter((r) => r.status === "queued_browser")
    .map((row, i) => ({ row, i, lane: queueLane(row.conversation_id) }))
    .sort((a, b) => a.lane - b.lane || a.i - b.i)
    .map((x) => x.row);

  // Setup cards not filed yet go right after the lane-0 cards already queued.
  const setupIds = Array.from(new Set([...running, ...queued].map((r) => parseSetupConvId(r.conversation_id)?.onboardingId).filter((x): x is string => !!x)));
  const toCome = await setupCardsToCome(svc, setupIds).catch(() => []);
  const upcoming: Row[] = toCome.map((u) => ({
    id: `setup-rest:${u.id}`, conversation_id: `setup:${u.id}:rest`, contact_name: u.name,
    summary: `Rest of the setup: about ${u.cards} more task${u.cards === 1 ? "" : "s"} (added one at a time)`,
    status: "queued_browser", created_at: new Date(now).toISOString(), decided_at: null, browser_claimed_at: null, browser_attempts: 0, executed_at: null,
  }));
  const cut = queued.findIndex((r) => queueLane(r.conversation_id) > 0);
  const ordered = cut < 0 ? [...queued, ...upcoming] : [...queued.slice(0, cut), ...upcoming, ...queued.slice(cut)];
  const cardsOf = new Map(toCome.map((u) => [`setup-rest:${u.id}`, u.cards]));

  // Estimated starts: what is left of the running task, then each queued one
  // in turn. Offline → no times (they start when the Mini is back).
  let t = now;
  for (const r of running) {
    const elapsed = r.browser_claimed_at ? now - Date.parse(r.browser_claimed_at) : 0;
    t += Math.max(60_000, typical(r.conversation_id) - elapsed) + GAP_MS;
  }
  const queue = ordered.map((r) => {
    const eta = online ? new Date(t).toISOString() : null;
    t += (typical(r.conversation_id) + GAP_MS) * (cardsOf.get(r.id) ?? 1);
    return { ...r, kind: taskKind(r.conversation_id), eta, ...(cardsOf.has(r.id) ? { upcoming: true } : {}) };
  });

  // Recurring jobs that will file new Mini tasks later (vercel.json crons).
  const scheduled: Array<{ label: string; at: string; note?: string }> = [
    { label: "Weekly clean-account checks (A2P + caller name)", at: nextWeeklyUtc(new Date(now), 1, 10) },
    { label: "Weekly CloseBot check", at: nextWeeklyUtc(new Date(now), 1, 11) },
  ];
  const igAt = ig ? igNextRunAt(ig, new Date(now)) : null;
  if (igAt) scheduled.push({ label: "Instagram engagement", at: igAt });
  const lastKa = (lastKeepAlive.data as { created_at?: string } | null)?.created_at;
  // It is filed only when nothing waits, so never before the queue's estimated end.
  const kaAt = new Date(Math.max(now, lastKa ? Date.parse(lastKa) + KEEPALIVE_EVERY_MS : now, queue.length || running.length ? t : now));
  kaAt.setUTCMinutes(Math.ceil(kaAt.getUTCMinutes() / 10) * 10, 0, 0); // agent-scan runs every 10 min
  scheduled.push({ label: "GoHighLevel sign-in check", at: kaAt.toISOString(), note: "only when nothing else is waiting" });
  scheduled.sort((a, b) => a.at.localeCompare(b.at));

  return {
    worker: workerVal,
    running: running.map((r) => ({ ...r, kind: taskKind(r.conversation_id), typicalMin: Math.round(typical(r.conversation_id) / 60_000) })),
    queue,
    finished: (finished.data ?? []) as Row[],
    scheduled,
  };
}
