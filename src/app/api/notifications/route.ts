import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

// Team notification feed (first use: a client completed their info-request
// form). Admins + coaches; newest first. POST marks one read.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("notifications")
    .select("id, created_at, type, title, body, coach, read_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { id?: number } | null;
  if (!body?.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const svc = createServiceClient();
  const { error } = await svc.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
