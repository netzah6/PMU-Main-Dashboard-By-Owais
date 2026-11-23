import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { CLIENTS_KEY, isV3, normBiz, type CbClients } from "@/lib/closebot-coverage";
import { queueCloseBotConnect } from "@/lib/closebot-connect";

export const fetchCache = "force-no-store";

/* "Connect to CloseBot" on the client profile (owner, 11/23/2026): sends the
   Mac Mini a task to connect this V3 client to the slay agent. Admin only.
   The account comes from the last daily CloseBot check (its location id),
   never guessed from a name here. */
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Only an admin can do this" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { owner?: string; business?: string; ownerName?: string; businessName?: string; version?: string };
  if (!isV3(String(body.version ?? ""))) return NextResponse.json({ error: "Only V3 clients use CloseBot" }, { status: 400 });
  const owner = String(body.owner ?? "").trim().toLowerCase();
  const business = normBiz(String(body.business ?? ""));
  const svc = createServiceClient();
  const { data } = await svc.from("app_settings").select("value").eq("key", CLIENTS_KEY).maybeSingle();
  const box = (data?.value ?? null) as CbClients | null;
  const hit = box?.clients
    ? (business && box.clients.find((c) => c.b === business && (!owner || !c.o || c.o === owner)))
      || (business && box.clients.find((c) => c.b === business))
      || (owner && box.clients.find((c) => c.o === owner))
      || null
    : null;
  if (!hit) return NextResponse.json({ error: "This client was not in the last CloseBot check" }, { status: 404 });
  if (!hit.loc) return NextResponse.json({ error: "The dashboard can't tell which GoHighLevel account is theirs" }, { status: 409 });
  if (hit.s === "on") return NextResponse.json({ error: "Already connected" }, { status: 409 });
  try {
    const q = await queueCloseBotConnect(svc, {
      locationId: hit.loc,
      business: String(body.businessName ?? "").trim() || String(body.business ?? "").trim(),
      ownerName: String(body.ownerName ?? body.owner ?? "").trim(),
      state: hit.s, source: hit.src, by: auth.email ?? "admin",
    });
    return NextResponse.json({ ok: true, ...q });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not send" }, { status: 500 });
  }
}
