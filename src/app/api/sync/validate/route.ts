import { NextResponse } from "next/server";
import { validateAllSheets } from "@/lib/sync";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 120;

export async function GET() {
  // Verify authenticated
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await validateAllSheets();
  const allInSync = results.every((r) => r.inSync);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    allInSync,
    results,
  });
}
