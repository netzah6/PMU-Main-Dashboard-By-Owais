import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getLtvDeposits } from "@/lib/ltv-deposits";

export const fetchCache = "force-no-store";
export const maxDuration = 30;

/* LTV tab: lead deposits (minus refunds) per client, keyed by the LTV sheet's
   "Name On Payment". Admin only, like the tab. See src/lib/ltv-deposits.ts. */
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  try {
    return NextResponse.json({ byName: await getLtvDeposits() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
