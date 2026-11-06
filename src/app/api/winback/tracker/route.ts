import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { buildTracker, FOLLOWUP_LEGEND } from "@/lib/winback-tracker";

export const maxDuration = 60;

// 🔁 Win-back tracker (admin only, read-only): every former client and every
// demo that didn't close, with where each one stands and what goes out next.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  try {
    return NextResponse.json({ ...(await buildTracker()), followupTexts: FOLLOWUP_LEGEND });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
