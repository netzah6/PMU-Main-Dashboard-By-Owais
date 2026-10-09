import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { setOneboxCustomValues, refreshOneboxConfig } from "@/lib/onebox";

export const fetchCache = "force-no-store";

/* Review queue for client info-form submissions (owner, 2026-10-09):
   nothing a client submits reaches the funnel until the team Approves it
   on the Funnels tab. Approve writes the stored custom values through
   the same path Start Setup uses; Reject just archives the submission. */

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("intake_submissions")
    .select("id, created_at, slug, client_name, fields, status")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { id?: number; action?: "approve" | "reject" } | null;
  if (!body?.id || !["approve", "reject"].includes(String(body.action))) {
    return NextResponse.json({ error: "id and action (approve|reject) required" }, { status: 400 });
  }
  const svc = createServiceClient();
  const { data: sub } = await svc.from("intake_submissions").select("*").eq("id", body.id).eq("status", "pending").maybeSingle();
  if (!sub) return NextResponse.json({ error: "submission not found or already decided" }, { status: 404 });

  if (body.action === "approve") {
    const cvs = ((sub.fields as { cvs?: Record<string, string> })?.cvs ?? {});
    const entries = Object.entries(cvs).map(([name, value]) => ({ name, value: String(value).slice(0, 4000) }));
    if (entries.length) {
      const { data: client } = await svc.from("onebox_clients").select("location_id").eq("slug", sub.slug).maybeSingle();
      if (!client) return NextResponse.json({ error: "funnel no longer exists" }, { status: 404 });
      const res = await setOneboxCustomValues(client.location_id as string, entries);
      if (res.error) return NextResponse.json({ error: `GHL write failed (${res.error})` }, { status: 502 });
      const justWritten = Object.fromEntries(entries.filter((e) => res.written.includes(e.name)).map((e) => [e.name, e.value]));
      await refreshOneboxConfig(svc, sub.slug as string, client.location_id as string, justWritten).catch(() => null);
    }
  }

  await svc.from("intake_submissions").update({
    status: body.action === "approve" ? "approved" : "rejected",
    decided_by: auth.email ?? auth.role,
    decided_at: new Date().toISOString(),
  }).eq("id", body.id);
  return NextResponse.json({ ok: true });
}
