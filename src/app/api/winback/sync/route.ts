import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getReplyAccount } from "@/lib/ghl-conversations";
import { syncWinback, WINBACK_SHEET_ID } from "@/lib/winback";

export const maxDuration = 300;

// "Sync from sheet": pulls the Follow Up list, finds each person in PMU
// Bookings On Demand and adds the win-back tag (removes it from rows flipped
// to "Not"). Tags only — no message is sent.
export async function POST() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 });
  try {
    return NextResponse.json(await syncWinback(acct));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The usual first-run failure: the sheet isn't shared with the dashboard's Google account.
    if (/permission|403|not found|404/i.test(msg)) {
      return NextResponse.json({
        error: `Can't read the sheet. Share it (Viewer) with ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? "the dashboard's Google service account"} and sync again.`,
        sheet: `https://docs.google.com/spreadsheets/d/${WINBACK_SHEET_ID}/edit`,
      }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
