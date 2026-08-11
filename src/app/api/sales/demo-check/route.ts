import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkDemos } from "@/lib/demo-check";

export const maxDuration = 300; // a long paste hits GHL twice per name

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { names?: string[]; raw?: string };
  const names = (body.names ?? String(body.raw ?? "").split(/[\n,]/))
    .map((n) => String(n).trim())
    .filter(Boolean)
    .slice(0, 150); // guard against a runaway paste

  if (!names.length) return NextResponse.json({ error: "Paste at least one contact name" }, { status: 400 });

  try {
    const results = await checkDemos(names);
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
