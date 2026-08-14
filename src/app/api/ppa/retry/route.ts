import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { resolveRetry } from "@/lib/ppa-retry";

// Stop the automatic decline-retry loop for one client (e.g. the artist asked
// to be invoiced instead, or a new card is coming).
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { owner_key?: string };
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  await resolveRetry(ownerKey, "cancelled");
  return NextResponse.json({ ok: true });
}
