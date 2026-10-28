import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { arrangeFeed, type IgFeed, type IgPicks } from "@/lib/ig-arrange";

export const fetchCache = "force-no-store";

/* Is this client's Instagram widget live on their one-box funnel?
   Read-only truth for the Clients-tab onboarding tracker (owner request
   2026-10-08: the manual On/Not-good-enough dropdown kept drifting from
   reality — the funnel config decides now). */
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = norm(name);
  const svc = createServiceClient();
  const { data } = await svc.from("onebox_clients").select("client_name, extras").eq("status", "live");
  const hit =
    (data ?? []).find((c) => norm(String(c.client_name ?? "")) === n) ||
    (data ?? []).find((c) => n && (norm(String(c.client_name ?? "")).includes(n) || n.includes(norm(String(c.client_name ?? "")))));
  if (!hit) return NextResponse.json({ found: false, on: null });
  /* Elfsight is gone (10/26/2026): "On" = our own Instagram grid has 3+
     pictures to show (or a frozen set) and isn't switched off. */
  const ex = (hit.extras ?? {}) as { igWidgetOff?: boolean; igFeed?: IgFeed; igPicks?: IgPicks; igFrozen?: boolean; igSnapshot?: { imgs?: string[] } };
  const tiles = ex.igFrozen && ex.igSnapshot?.imgs?.length ? ex.igSnapshot.imgs.length : ex.igFeed?.imgs?.length ? arrangeFeed(ex.igFeed, ex.igPicks).imgs.length : 0;
  const on = !ex.igWidgetOff && tiles >= 3;
  return NextResponse.json({ found: true, on });
}
