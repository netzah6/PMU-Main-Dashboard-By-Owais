import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { sendStageConversions } from "@/lib/stage-conversion";

export const maxDuration = 300;
export const fetchCache = "force-no-store";

const STATUS_KEY = "stage_conv_status";

/* Hourly: the Meta "RealClient" event for leads the artist's team moved to
   Deposit Collected / Session Done / 5-star in GHL (lib/stage-conversion).
   ?dry=1 lists who would be sent, without sending or writing anything. The
   last run's result is kept in app_settings (no Vercel log access). */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const svc = createServiceClient();
  const started = new Date().toISOString();
  try {
    const r = await sendStageConversions(svc, { dry, timeBudgetMs: 240_000 });
    const summary = {
      started_at: started, at: new Date().toISOString(), dry,
      accounts: r.accounts, done: r.done, seeded_accounts: r.seededAccounts, seeded: r.seeded,
      sent: r.sent.length, failed: r.failed.length, skipped_old: r.skippedOld, already: r.already,
      last_sent: r.sent.slice(0, 15), last_failed: r.failed.slice(0, 15), errors: r.errors.slice(0, 15),
    };
    if (!dry) {
      await svc.from("app_settings").upsert({ key: STATUS_KEY, value: summary, updated_by: "cron stage-conversions", updated_at: new Date().toISOString() })
        .then(({ error }) => { if (error) console.error("[stage-conversions] status save:", error.message); });
    }
    return NextResponse.json({ ...summary, ...(dry ? { would_send: r.wouldSend } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    console.error("[stage-conversions]", msg);
    if (!dry) await svc.from("app_settings").upsert({ key: STATUS_KEY, value: { started_at: started, at: new Date().toISOString(), error: msg }, updated_by: "cron stage-conversions", updated_at: new Date().toISOString() });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
