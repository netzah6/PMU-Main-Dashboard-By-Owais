import { NextRequest, NextResponse } from "next/server";
import { saveBudget } from "@/lib/client-app-budget";

/* Client app: she picked her daily ad budget. Kept on her row + one alert for
   the team; no budget is changed in Facebook from here. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { token?: string; amount?: unknown };
  const ok = await saveBudget(String(body.token ?? ""), body.amount);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not available" }, { status: 400 });
}
