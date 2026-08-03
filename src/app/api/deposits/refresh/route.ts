import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SHEET_MAP } from "@/lib/sheets";
import { syncOneSheet } from "@/lib/sync";

export const maxDuration = 60;

// Pull the deposits sheet right now, for a signed-in user.
//
// The cron does this every minute, but "every minute" still means a deposit can
// sit invisible for up to 60s — and the person watching the tab is usually
// watching *because* they're expecting one. Opening or refocusing the Deposits
// tab calls this so the list is current the moment it's looked at. Realtime
// then pushes the new row into every other open tab.
export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const entry = SHEET_MAP.find((s) => s.table === "deposits");
  if (!entry) return NextResponse.json({ error: "deposits sheet not mapped" }, { status: 500 });

  try {
    const result = await syncOneSheet(entry.spreadsheetId, entry.sheetName, entry.table);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "sync failed" }, { status: 502 });
  }
}
