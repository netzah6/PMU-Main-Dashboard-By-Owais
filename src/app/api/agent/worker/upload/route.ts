import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { uploadProof, workerAuthorized } from "@/lib/agent-worker";

// The Mac Mini uploads one proof screenshot for the task it is running.
export async function POST(req: NextRequest) {
  if (!workerAuthorized(req.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: string; name?: string; base64?: string } | null;
  if (!body?.id || !body.base64) return NextResponse.json({ error: "id and base64 required" }, { status: 400 });
  const r = await uploadProof(createServiceClient(), body.id, String(body.name ?? ""), body.base64);
  return r.url ? NextResponse.json({ url: r.url }) : NextResponse.json({ error: r.error }, { status: 400 });
}
