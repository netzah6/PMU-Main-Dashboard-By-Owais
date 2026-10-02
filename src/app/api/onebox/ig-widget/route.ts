import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

/* IG-widget controls for the CPD Funnel-setup cards (owner request
   2026-10-02):
     off / on       — hide or restore the live Elfsight feed on the funnel
                      (for widgets showing the wrong business, promos, etc.)
     freeze / unfreeze — serve the self-hosted snapshot of the posts that
                      were live when the funnel converted, so the client's
                      new IG posts stop changing the page.
   Freeze needs extras.igSnapshot (uploaded copies — Instagram CDN links
   expire, so we can't just remember URLs). The 2026-10-01 sweep seeded it
   for every live funnel; a client without one gets a clear error. */

const ACTIONS = ["off", "on", "freeze", "unfreeze"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { slug?: string; action?: string } | null;
  const slug = body?.slug?.trim();
  const action = body?.action as Action | undefined;
  if (!slug || !action || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: "slug and action (off|on|freeze|unfreeze) required" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { data: row, error } = await sb
    .from("onebox_clients")
    .select("slug, extras")
    .eq("slug", slug)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const extras = { ...((row.extras ?? {}) as Record<string, unknown>) };
  if (action === "freeze") {
    const snap = extras.igSnapshot as { imgs?: string[] } | undefined;
    if (!snap?.imgs?.length) {
      return NextResponse.json(
        { error: "No feed snapshot stored for this client yet — rerun the IG snapshot sweep first." },
        { status: 409 },
      );
    }
    extras.igFrozen = true;
  }
  if (action === "unfreeze") extras.igFrozen = false;
  if (action === "off") extras.igWidgetOff = true;
  if (action === "on") extras.igWidgetOff = false;

  const { error: upErr } = await sb.from("onebox_clients").update({ extras }).eq("slug", slug);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    slug,
    igWidgetOff: !!extras.igWidgetOff,
    igFrozen: !!extras.igFrozen,
  });
}
