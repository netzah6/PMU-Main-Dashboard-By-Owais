import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getSetterCloserCapacity } from "@/lib/ceo-capacity";

// Setter & closer availability for the next 7 days. Admins only.
export const maxDuration = 60;

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const data = await getSetterCloserCapacity(7);
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
