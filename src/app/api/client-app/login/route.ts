import { NextRequest, NextResponse } from "next/server";
import { requestCode, verifyCode } from "@/lib/client-app-auth";

/* Client app · sign-in. { phone } asks for a code by text; { phone, code }
   checks it and signs her in. Every lock (master switch, beta list, limits)
   lives in client-app-auth. */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { phone?: unknown; code?: unknown } | null;
  if (!body) return NextResponse.json({ error: "Not available" }, { status: 400 });
  try {
    if (body.code != null && String(body.code) !== "") {
      const v = await verifyCode(body.phone, body.code);
      return v.ok ? NextResponse.json({ ok: true, redirect: v.redirect }) : NextResponse.json({ error: v.error }, { status: v.status });
    }
    const r = await requestCode(body.phone);
    return r.ok ? NextResponse.json({ ok: true, state: r.state }) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (e) {
    console.error("[client-app/login]", e);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
