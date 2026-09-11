import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { createServiceClient } from "@/lib/supabase/server";
import { checkDemos } from "@/lib/demo-check";

export const maxDuration = 300; // a long paste hits GHL twice per name

export async function POST(req: NextRequest) {
  // Sales is an admin-only tab (hidden from Client Success Coaches and VAs),
  // so the API refuses everyone else too — hiding the tab alone isn't access control.
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { names?: string[]; raw?: string };
  const names = (body.names ?? String(body.raw ?? "").split(/[\n,]/))
    .map((n) => String(n).trim())
    .filter(Boolean)
    .slice(0, 150); // guard against a runaway paste

  if (!names.length) return NextResponse.json({ error: "Paste at least one contact name" }, { status: 400 });

  try {
    const results = await checkDemos(names);
    // Keep the run. The check used to be stateless, and a list pasted days
    // earlier could not be brought back when the owner asked for it.
    const { data: saved } = await createServiceClient().from("demo_checks").insert({
      user_email: auth.email,
      names,
      results,
      showed: results.filter((r) => r.status === "showed").length,
      total: results.length,
    }).select("id, created_at").single();
    return NextResponse.json({ results, checkId: saved?.id ?? null, checkedAt: saved?.created_at ?? null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// Previous runs, newest first — enough to bring any of them back.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const { data } = await createServiceClient()
    .from("demo_checks")
    .select("id, user_email, names, results, showed, total, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  return NextResponse.json({ checks: data ?? [] });
}
