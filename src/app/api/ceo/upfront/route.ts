import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getUpfrontAndCloses } from "@/lib/ceo-finance";

// Upfront collected + the clients who closed. Admins only.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const ym = req.nextUrl.searchParams.get("ym") ?? undefined;
  const data = await getUpfrontAndCloses(ym);
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
