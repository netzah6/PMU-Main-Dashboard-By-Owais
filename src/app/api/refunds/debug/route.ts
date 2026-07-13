import { NextRequest, NextResponse } from "next/server";
import { debugRefundLookup } from "@/lib/fanbasis";

export const maxDuration = 60;

// Read-only refund diagnostic, gated by CRON_SECRET (NOT an admin route — it
// never moves money). Given a deposit's Fanbasis product id + buyer email, it
// returns the raw transaction shape and route probes so we can pin the correct
// refund endpoint/identifier without live-testing an actual refund.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const product = req.nextUrl.searchParams.get("product") ?? "";
  const email = req.nextUrl.searchParams.get("email") ?? "";
  if (!product || !email) return NextResponse.json({ error: "product and email required" }, { status: 400 });
  try {
    const data = await debugRefundLookup(product, email);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
