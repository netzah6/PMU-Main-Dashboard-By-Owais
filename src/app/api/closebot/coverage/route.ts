import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { ingestCloseBotSources, verifyTask } from "@/lib/closebot-coverage";

export const maxDuration = 60;

// The weekly CloseBot check posts its source list here, from inside
// app.closebot.com (see sourcesScript). No session: the signed ?task=&sig=
// link works only for its own open check card. text/plain keeps it a
// "simple" cross-site request; the CORS header lets the page read the answer.
const CORS = { "Access-Control-Allow-Origin": "https://app.closebot.com", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  const task = req.nextUrl.searchParams.get("task") ?? "";
  const sig = req.nextUrl.searchParams.get("sig") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(task) || !verifyTask(task, sig)) {
    return NextResponse.json({ error: "bad link" }, { status: 401, headers: CORS });
  }
  const text = await req.text();
  if (text.length > 2_000_000) return NextResponse.json({ error: "list too large" }, { status: 413, headers: CORS });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "not JSON" }, { status: 400, headers: CORS }); }
  try {
    const r = await ingestCloseBotSources(createServiceClient(), task, body);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 422, headers: CORS });
    return NextResponse.json({ saved: r.saved, total: r.total, problems: r.scan?.findings, filed: r.scan?.filed, resolved: r.scan?.resolved }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500, headers: CORS });
  }
}
