import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import {
  confirmLookup, dailyQuota, getSettings, IGE_PREFIX, nextRunText, queueRun, saveSettings, syncClients, usernameFromLink, warmupWeek,
  type EngageStatus,
} from "@/lib/ig-engage";

export const maxDuration = 60;

// Instagram tab: who we engage with, comments waiting for approval, what the
// Mac Mini did. Admin only.

async function admin() {
  const auth = await getAuth();
  if (!auth || auth.role !== "admin") return null;
  return auth;
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const svc = createServiceClient();
  await syncClients(svc).catch(() => null);
  const [settings, { data: clients }, { data: drafts }, { data: recent }, { data: runs }, { data: lookups }] = await Promise.all([
    getSettings(svc),
    svc.from("ig_engage_clients").select("*").order("client_name", { ascending: true }),
    svc.from("ig_engage_actions").select("*").in("status", ["draft", "approved"]).order("created_at", { ascending: false }).limit(100),
    svc.from("ig_engage_actions").select("*").in("status", ["done", "failed"]).order("done_at", { ascending: false }).limit(80),
    svc.from("agent_proposals").select("id, status, result, created_at, executed_at, screenshots").like("conversation_id", `${IGE_PREFIX}%`).order("created_at", { ascending: false }).limit(10),
    svc.from("ig_engage_lookups").select("owner_name, business, city, candidate, candidate_note, status, ltv, left_at"),
  ]);
  const lk = (lookups ?? []) as Array<{ status: string }>;
  return NextResponse.json({
    settings, week: warmupWeek(settings.startedAt), quota: dailyQuota(settings.startedAt), nextRun: nextRunText(settings),
    clients: clients ?? [], drafts: drafts ?? [], recent: recent ?? [], runs: runs ?? [],
    found: lk.filter((l) => l.status === "found"),
    lookupCounts: { todo: lk.filter((l) => l.status === "todo").length, notFound: lk.filter((l) => l.status === "not_found").length },
  });
}

const STATUSES: EngageStatus[] = ["engage", "paused", "blocked"];

export async function POST(req: NextRequest) {
  const auth = await admin();
  if (!auth) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const by = auth.email ?? "admin";
  const svc = createServiceClient();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const t = new Date().toISOString();
  try {
    switch (b.action) {
      case "settings": {
        const patch: Record<string, unknown> = {};
        if (typeof b.enabled === "boolean") { patch.enabled = b.enabled; if (b.enabled) patch.pausedReason = null; }
        if (typeof b.approveComments === "boolean") patch.approveComments = b.approveComments;
        return NextResponse.json({ settings: await saveSettings(svc, patch, by) });
      }
      case "client": {
        const username = usernameFromLink(b.username);
        if (!username) return NextResponse.json({ error: "Unknown Instagram handle" }, { status: 400 });
        const patch: Record<string, unknown> = { updated_at: t, updated_by: by };
        if (typeof b.status === "string") {
          if (!STATUSES.includes(b.status as EngageStatus)) return NextResponse.json({ error: "Bad status" }, { status: 400 });
          patch.status = b.status;
        }
        if (typeof b.note === "string") patch.note = b.note.trim().slice(0, 300) || null;
        const { error } = await svc.from("ig_engage_clients").update(patch).eq("username", username);
        if (error) throw new Error(error.message);
        // A client set to pause / do-not-engage never gets a waiting comment posted.
        if (patch.status === "paused" || patch.status === "blocked") {
          await svc.from("ig_engage_actions").update({ status: "skipped", note: `client set to ${patch.status}`, decided_at: t, decided_by: by }).eq("username", username).in("status", ["draft", "approved"]);
        }
        return NextResponse.json({ ok: true });
      }
      case "add": {
        const username = usernameFromLink(b.username);
        if (!username) return NextResponse.json({ error: "Type an Instagram handle or profile link" }, { status: 400 });
        const { error } = await svc.from("ig_engage_clients").upsert({
          username, client_name: String(b.name ?? "").trim().slice(0, 120) || null, status: "engage", updated_by: by,
        }, { onConflict: "username", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
        return NextResponse.json({ ok: true, username });
      }
      case "decide": {
        const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(String).filter(Boolean).slice(0, 100);
        const approve = b.decision === "approve";
        if (!ids.length) return NextResponse.json({ error: "Nothing to decide" }, { status: 400 });
        const patch: Record<string, unknown> = { status: approve ? "approved" : "rejected", decided_at: t, decided_by: by };
        if (approve && typeof b.text === "string" && ids.length === 1) {
          const text = b.text.trim();
          if (!text) return NextResponse.json({ error: "The comment is empty" }, { status: 400 });
          patch.text = text.slice(0, 500);
        }
        const { error } = await svc.from("ig_engage_actions").update(patch).in("id", ids).in("status", ["draft", "approved"]);
        if (error) throw new Error(error.message);
        return NextResponse.json({ ok: true });
      }
      case "lookup": {
        const r = await confirmLookup(svc, String(b.owner ?? ""), b.decision === "accept", typeof b.handle === "string" ? b.handle : null, by);
        return r.error ? NextResponse.json({ error: r.error }, { status: 400 }) : NextResponse.json({ ok: true, username: r.username });
      }
      case "runNow": {
        const r = await queueRun(svc, by);
        return r.queued ? NextResponse.json(r) : NextResponse.json({ error: r.why ?? "Could not start a run" }, { status: 409 });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
