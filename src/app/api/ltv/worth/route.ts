import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getLtvWorth } from "@/lib/ltv-deposits";

export const fetchCache = "force-no-store";
export const maxDuration = 30;

/* Performance tab (admin): average worth per client = service fees +
   lead deposits minus refunds. Admin only. See src/lib/ltv-deposits.ts. */
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  try {
    return NextResponse.json(await getLtvWorth());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
