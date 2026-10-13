import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// Team names for the profile dropdowns (owner, 2026-10-13: the Media Buyer
// dropdown must list ONLY the people who are media buyers — admins or the
// media_buyer role — not a hard-coded list). Names come from
// user_roles.team_name, set on Settings. Any signed-in teammate may read.
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const kind = req.nextUrl.searchParams.get("kind") ?? "media_buyer";
  const roles = kind === "media_buyer" ? ["admin", "media_buyer"] : ["admin", "editor"];
  const svc = createServiceClient();
  const { data } = await svc.from("user_roles").select("team_name, role").in("role", roles).not("team_name", "is", null);
  const names = [...new Set(((data ?? []) as Array<{ team_name: string | null }>).map((r) => String(r.team_name ?? "").trim()).filter(Boolean))].sort();
  return NextResponse.json({ names });
}
