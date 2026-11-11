import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getV3Roster } from "@/lib/ppa";
import { getCoachScope } from "@/lib/coach";
import { buildClientDrill } from "@/lib/ppa-client-drill";

export const maxDuration = 120;

// Drill-down for one V3 client: every deposit (appointment) with its lead's
// current stage, scheduled appointment date, and a charge status
// (upcoming / past-due / served / no-show / no-appt) + charge state. Admin only.

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Owner 11/06/2026: a Client Success Coach may read the ACTIVITY LOG
  // (charges, credits, balance) of a client in their own book, so they can
  // track their PPS clients. That is the `?ledger=1` slice below — the
  // appointment-level list and amounts stay admin-only.
  const ledgerOnly = req.nextUrl.searchParams.get("ledger") === "1";
  if (auth.role !== "admin" && !(auth.role === "editor" && ledgerOnly)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ownerKey = (req.nextUrl.searchParams.get("owner_key") ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  const roster = await getV3Roster();
  const client = roster.find((c) => c.ownerKey === ownerKey);
  if (!client) return NextResponse.json({ error: "not a V3 client" }, { status: 404 });

  const svc = createServiceClient();
  if (auth.role !== "admin") {
    // A coach sees only their own clients (same scope as /api/ppa/coach).
    const scope = await getCoachScope(svc, auth);
    if (!scope.ownerKeys || !scope.ownerKeys.has(ownerKey)) {
      return NextResponse.json({ error: "Not your client" }, { status: 403 });
    }
  }
  let drill;
  try { drill = await buildClientDrill(svc, client); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "load failed" }, { status: 500 }); }

  if (ledgerOnly) return NextResponse.json({ ledger: drill.ledger, creditLeft: drill.creditLeft });
  return NextResponse.json(drill);
}
