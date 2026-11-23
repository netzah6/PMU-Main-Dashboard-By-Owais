import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { LEAK_STATUSES, listLeaks, mmdd, saveLeak, type LeakStatus } from "@/lib/leak-tracker";

export const fetchCache = "force-no-store";

/* 🩹 Leaks tab. Admins only.
     GET                         → every leak
     POST { id, status }         → the owner moves a leak (e.g. OK given, done) */
async function admin() {
  const auth = await getAuth();
  return auth && auth.role === "admin" ? auth : null;
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  try {
    return NextResponse.json({ leaks: await listLeaks(createServiceClient()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await admin();
  if (!auth) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { id?: string; status?: string };
  const status = String(body.status ?? "") as LeakStatus;
  if (!body.id || !LEAK_STATUSES.includes(status)) return NextResponse.json({ error: "id and status required" }, { status: 400 });
  const svc = createServiceClient();
  const leak = (await listLeaks(svc)).find((l) => l.id === body.id);
  if (!leak) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await saveLeak(svc, { ...leak, status, updated: mmdd() }, auth.email ?? "admin");
  return NextResponse.json({ ok: true });
}
