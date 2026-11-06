import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { setPicks } from "@/lib/winback-tracker";

export const maxDuration = 60;

// Tick / untick people for the next blast (admin only). It only marks them —
// no message goes out from here.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { group?: string; keys?: unknown; picked?: boolean };
  const group = body.group === "demo" ? "demo" : body.group === "former" ? "former" : null;
  const keys = Array.isArray(body.keys) ? body.keys.map(String).filter(Boolean) : [];
  if (!group || !keys.length) return NextResponse.json({ error: "group and keys are required" }, { status: 400 });
  try {
    return NextResponse.json(await setPicks({ group, keys, picked: body.picked !== false, by: auth.email }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
