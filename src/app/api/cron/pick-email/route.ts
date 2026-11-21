import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { createServiceClient } from "@/lib/supabase/server";
import { runPickEmail, type PickEmailRun } from "@/lib/pick-email";
import { runPickSms, sendPickSmsTest, type PickSmsRun } from "@/lib/pick-sms";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

/* Each pass gets its own share of the 300 s: the email first, then the
   pick-time text with whatever is left (never more than 90 s). */
const EMAIL_BUDGET_MS = 150_000, SMS_BUDGET_MS = 90_000, TOTAL_BUDGET_MS = 275_000, AI_RESTORE_MS = 110_000;

/* Every 10 minutes: the "finish your deposit" email (src/lib/pick-email.ts),
   then the pick-time text to quiet pickers (src/lib/pick-sms.ts — it has no
   cron of its own). Each does nothing while its switch on the Funnels tab is
   off, and an error in one never stops the other. ?dry=1 shows what WOULD go
   out and writes nothing — for the cron secret or an admin; &since=<ISO>
   stands in for the switch-on moment so it can be tried while off.
   ?testContact=<id>&testLocation=<id>[&testSlug=][&testArea=][&dry=1] — cron
   secret only: the text, with a fake pick, to that ONE contact (works while
   off, never touches the test's table); nothing else runs. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const dryRun = sp.get("dry") === "1";
  const authHeader = req.headers.get("authorization");
  // Emails and texts go to real people, so a real send needs the cron secret — set AND matching.
  const cronOk = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;

  const testContact = sp.get("testContact");
  if (testContact !== null) {
    if (!cronOk) return NextResponse.json({ error: process.env.CRON_SECRET ? "Unauthorized" : "CRON_SECRET is not set" }, { status: 401 });
    const testLocation = sp.get("testLocation");
    if (!testLocation) return NextResponse.json({ error: "testLocation is required with testContact" }, { status: 400 });
    try {
      const r = await sendPickSmsTest(createServiceClient(), {
        contactId: testContact.trim(), locationId: testLocation.trim(), slug: sp.get("testSlug"), area: sp.get("testArea"), dryRun,
      });
      return NextResponse.json({ timestamp: new Date().toISOString(), test: true, ...r }, { status: r.ok ? 200 : 400 });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  if (!cronOk) {
    const auth = dryRun ? await getAuth().catch(() => null) : null;
    if (auth?.role !== "admin") {
      return NextResponse.json({ error: process.env.CRON_SECRET ? "Unauthorized" : "CRON_SECRET is not set — the deposit email refuses to send without it" }, { status: 401 });
    }
  }
  const since = sp.get("since");
  if (since && !Number.isFinite(Date.parse(since))) return NextResponse.json({ error: "since must be an ISO date" }, { status: 400 });
  const svc = createServiceClient();
  const t0 = Date.now();

  let email: PickEmailRun | null = null;
  let emailError: string | null = null;
  try {
    email = await runPickEmail(svc, { dryRun, sinceIso: since ?? undefined, budgetMs: EMAIL_BUDGET_MS });
  } catch (e) {
    emailError = e instanceof Error ? e.message : String(e);
  }
  let sms: PickSmsRun | { error: string };
  try {
    const left = TOTAL_BUDGET_MS - (Date.now() - t0);
    // After each text the AI is put back on (watched ~80 s, up to ~2 min, in parallel) — leave room before the 300 s limit.
    sms = await runPickSms(svc, { dryRun, sinceIso: since ?? undefined, budgetMs: Math.min(SMS_BUDGET_MS, Math.max(10_000, left - AI_RESTORE_MS)) });
  } catch (e) {
    sms = { error: e instanceof Error ? e.message : String(e) };
  }

  if (emailError) return NextResponse.json({ error: emailError, sms }, { status: 500 });
  return NextResponse.json({ timestamp: new Date().toISOString(), ...email, sms });
}
