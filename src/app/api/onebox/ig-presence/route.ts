import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

/* Is this client's Instagram widget live on their one-box funnel?
   Read-only truth for the Clients-tab onboarding tracker (owner request
   2026-10-08: the manual On/Not-good-enough dropdown kept drifting from
   reality — the funnel config decides now). "On" = a widget is configured
   AND not hidden by the CPD turn-off switch. */
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = norm(name);
  const svc = createServiceClient();
  const { data } = await svc.from("onebox_clients").select("client_name, config, extras").eq("status", "live");
  const hit =
    (data ?? []).find((c) => norm(String(c.client_name ?? "")) === n) ||
    (data ?? []).find((c) => n && (norm(String(c.client_name ?? "")).includes(n) || n.includes(norm(String(c.client_name ?? "")))));
  if (!hit) return NextResponse.json({ found: false, on: null });
  const cfg = (hit.config ?? {}) as Record<string, string>;
  const ex = (hit.extras ?? {}) as { igWidgetOff?: boolean };
  const on = !!String(cfg.igWidget ?? "").trim() && !ex.igWidgetOff;
  return NextResponse.json({ found: true, on });
}
