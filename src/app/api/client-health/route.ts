import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getCoachScope } from "@/lib/coach";
import { getClientHealth } from "@/lib/client-health";

export const fetchCache = "force-no-store";
export const maxDuration = 30;

/* Client Health — every Live client in the coach's book, green / orange /
   red on whether they're getting a return on what they invest with us.
   A coach (editor) sees only their own book; an admin sees everyone, or one
   coach's book with ?coach=. See src/lib/client-health.ts for the scoring. */
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  const svc = createServiceClient();
  const requested = req.nextUrl.searchParams.get("coach") ?? undefined;
  const scope = await getCoachScope(svc, auth, requested);
  try {
    const { clients, financeError } = await getClientHealth(scope.ownerKeys);
    return NextResponse.json({
      coach: scope.coach,
      coaches: auth.role === "admin" ? scope.coaches : [],
      clients,
      // The 2026 payments come from the Financing sheet — say so if it failed
      // rather than quietly showing smaller "invested" numbers.
      financeError: financeError ?? null,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
