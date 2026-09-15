import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { buildSalesBoard } from "@/lib/sales-board";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Sales tab data: setter + closer KPIs and their to-do lists, from the synced
// sales sheets. Admins only (the tab is admin-only too).
export async function GET() {
  const auth = await getAuth();
  if (!auth || auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  try {
    return NextResponse.json(await buildSalesBoard(createServiceClient()));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
