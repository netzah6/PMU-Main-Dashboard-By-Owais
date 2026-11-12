import { NextRequest, NextResponse } from "next/server";
import { saveSupportMessage } from "@/lib/client-app-support";

export const maxDuration = 30;

/* Client app · Support tab: she pressed Send (a text, a voice note, or both).
   DEMO stage: the message is saved and shown back to her only — nothing is
   texted, nothing reaches GoHighLevel or the coach (see client-app-support). */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Not available" }, { status: 400 });
  const file = form.get("file");
  const audio = file instanceof Blob && file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : null;
  const seconds = Number(form.get("seconds"));
  const r = await saveSupportMessage(String(form.get("token") ?? ""), {
    text: String(form.get("text") ?? ""), audio, seconds: Number.isFinite(seconds) ? seconds : null,
  });
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
}
