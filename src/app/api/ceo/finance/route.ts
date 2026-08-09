import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getAgencyFinance } from "@/lib/ceo-finance";

// Agency finance for the CEO tab. Admins only — this is the P&L.
export const maxDuration = 60;

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const data = await getAgencyFinance();
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
