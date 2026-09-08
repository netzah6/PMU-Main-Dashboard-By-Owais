import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getCoachScope } from "@/lib/coach";
import type { CreditRow } from "@/lib/credits";

// The credit list, scoped the same way the PPS tab is: an admin sees every
// request and the approval queue, a Client Success Coach sees only the clients
// in their own book (user request 2026-09-08). The caller's role rides along so
// the panel knows whether to show Approve/Deny.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("client_credits")
    .select("*")
    .order("requested_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let credits = (data ?? []) as CreditRow[];
  if (auth.role !== "admin") {
    const { ownerKeys } = await getCoachScope(svc, auth);
    // A coach also keeps sight of anything they asked for themselves, even for
    // a client who has since moved to another coach.
    credits = credits.filter(
      (c) => ownerKeys?.has(c.owner_key) || c.requested_by === auth.email
    );
  }

  return NextResponse.json({ credits, role: auth.role, email: auth.email });
}
