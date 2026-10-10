import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getReplyAccount } from "@/lib/ghl-conversations";
import { reviewWinback, WINBACK_SHEET_ID } from "@/lib/winback";

export const maxDuration = 300;

// "Review chats": finds each Follow Up person in PMU Bookings On Demand and has
// the AI read their history with us to flag bad endings. Read-only — no tag,
// no message. Resumable: click again until nothing is left.
export async function POST() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "AI is not configured (ANTHROPIC_API_KEY)" }, { status: 503 });
  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 });
  try {
    return NextResponse.json(await reviewWinback(acct));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/caller does not have permission|requested entity was not found/i.test(msg)) {
      return NextResponse.json({
        error: `Can't read the sheet. Share it (Viewer) with ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? "the dashboard's Google service account"} and try again.`,
        sheet: `https://docs.google.com/spreadsheets/d/${WINBACK_SHEET_ID}/edit`,
      }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
