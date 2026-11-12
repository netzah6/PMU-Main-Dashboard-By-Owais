import { NextRequest, NextResponse } from "next/server";
import { requestReviews } from "@/lib/client-app";

/* Client app: "Ask my team to turn Google Reviews on". Records the request
   once on the client's row; the team turns the section on (reviews_on). The
   only thing a client link can write — it changes nothing she sees except
   "Request sent". */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const ok = await requestReviews(String(body.token ?? ""));
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not available" }, { status: 400 });
}
