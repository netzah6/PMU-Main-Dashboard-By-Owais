import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getRoadTo100k, PROFIT_GOAL, TARGETS } from "@/lib/ceo-growth";

// "Road to $100k/mo profit" tracker for the CEO tab. Admins only (the P&L).
export const maxDuration = 60;

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const r = await getRoadTo100k();
  return NextResponse.json({ ...r, goal: PROFIT_GOAL, targets: TARGETS }, { headers: { "Cache-Control": "no-store" } });
}
