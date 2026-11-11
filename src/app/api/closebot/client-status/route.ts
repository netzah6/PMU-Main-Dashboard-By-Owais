import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { CLIENTS_KEY, normBiz, type CbClients } from "@/lib/closebot-coverage";

export const fetchCache = "force-no-store";

// The "CloseBot" box on a client's profile (owner, 11/11/2026): is their
// sub-account connected to a CloseBot agent's job flow? Read from the last
// daily check, never live — CloseBot has no working API key.
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const owner = (req.nextUrl.searchParams.get("owner") ?? "").trim().toLowerCase();
  const business = normBiz(req.nextUrl.searchParams.get("business") ?? "");
  const { data } = await createServiceClient().from("app_settings").select("value").eq("key", CLIENTS_KEY).maybeSingle();
  const box = (data?.value ?? null) as CbClients | null;
  if (!box?.clients) return NextResponse.json({ at: null, client: null });
  // Business first: one owner can run two businesses (two sub-accounts).
  const hit = (business && box.clients.find((c) => c.b === business && (!owner || !c.o || c.o === owner)))
    || (business && box.clients.find((c) => c.b === business))
    || (owner && box.clients.find((c) => c.o === owner))
    || null;
  return NextResponse.json({ at: box.at, client: hit ? { state: hit.s, source: hit.src, agents: hit.a, tags: hit.t, located: !!hit.loc } : null });
}
