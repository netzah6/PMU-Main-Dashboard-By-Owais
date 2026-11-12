import { NextRequest, NextResponse } from "next/server";
import { saveProfit, type ProfitAction } from "@/lib/client-app-profit";

/* Client app · Profit: she saved her prices, her own amount for a client, or
   an expense. Her own notes only — nothing here touches billing or the team. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as ({ token?: string } & ProfitAction) | null;
  if (!body) return NextResponse.json({ error: "Not available" }, { status: 400 });
  const r = await saveProfit(String(body.token ?? ""), body);
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
}
