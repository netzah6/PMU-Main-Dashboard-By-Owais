import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { runInsightScan } from "@/lib/onebox-insights";

export const maxDuration = 120;

// The optimizer's inbox: proposed insights wait here for an explicit
// approve/deny. GET lists them (open first, then recent decisions);
// POST runs a scan or records a decision.

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const svc = createServiceClient();
  const [{ data: rows }, { data: clients }] = await Promise.all([
    svc.from("onebox_insights")
      .select("id, slug, kind, status, problem, why, solution, metrics, deny_reason, user_suggestion, decided_at, created_at")
      .order("created_at", { ascending: false })
      .limit(80),
    svc.from("onebox_clients").select("slug, client_name"),
  ]);
  const names: Record<string, string> = {};
  for (const c of clients ?? []) names[c.slug as string] = (c.client_name as string) || (c.slug as string);
  const withNames = (rows ?? []).map((r) => ({ ...r, clientName: names[r.slug as string] ?? r.slug }));
  return NextResponse.json({
    open: withNames.filter((r) => r.status === "proposed"),
    decided: withNames.filter((r) => r.status !== "proposed").slice(0, 20),
  });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const svc = createServiceClient();
  const action = String(body.action ?? "");

  if (action === "scan") {
    const result = await runInsightScan(svc, req.nextUrl.origin);
    return NextResponse.json({ ok: true, ...result });
  }

  if (action === "decide") {
    const id = Number(String(body.id ?? "").replace(/\D/g, ""));
    const decision = body.decision === "approve" ? "approved" : body.decision === "deny" ? "denied" : null;
    if (!id || !decision) return NextResponse.json({ error: "id and decision required" }, { status: 400 });
    const reason = String(body.reason ?? "").trim().slice(0, 2000) || null;
    const suggestion = String(body.suggestion ?? "").trim().slice(0, 2000) || null;
    // A deny must teach us something — a reason or a better idea —
    // otherwise the same flag just comes back after the cooldown.
    if (decision === "denied" && !reason && !suggestion) {
      return NextResponse.json({ error: "tell me why, or suggest a different fix" }, { status: 400 });
    }
    const { data: row, error } = await svc
      .from("onebox_insights")
      .update({
        status: decision,
        deny_reason: decision === "denied" ? reason : null,
        user_suggestion: suggestion,
        decided_at: new Date().toISOString(),
        decided_by: auth.email ?? "admin",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "proposed")
      .select("id, status")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "already decided or unknown id" }, { status: 409 });
    return NextResponse.json({ ok: true, status: row.status });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
