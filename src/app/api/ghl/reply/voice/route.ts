import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getReplyAccount, sendConversationMessage } from "@/lib/ghl-conversations";

export const maxDuration = 30;

/* 🎤 Voice note into a PMU Bookings On Demand chat (owner, 2026-10-07).
   GoHighLevel has no record button for texts, so the dashboard records it:
   the browser sends a small MP3 (see src/lib/voice-note-client.ts), we keep
   it in the public `voice-notes` bucket under an unguessable name, and GHL
   sends it as a text with the audio attached — from the account's own
   number, like any other reply. A human pressed Send; nothing calls this
   automatically. */

const BUCKET = "voice-notes";
// The recorder caps 2 minutes at ~4 KB/s (~480 KB). Carriers drop MMS past
// ~1 MB, so anything near that is refused rather than sent as a broken text.
const MAX_BYTES = 700_000;
const CHANNELS = new Set(["SMS", "WhatsApp"]);

// An MP3 starts with an ID3 tag or an MPEG frame sync — not a renamed file.
const looksLikeMp3 = (b: Uint8Array) =>
  (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const contactId = String(form?.get("contactId") ?? "").trim();
  const channel = String(form?.get("channel") ?? "SMS");
  if (!contactId) return NextResponse.json({ error: "contactId required" }, { status: 400 });
  if (!CHANNELS.has(channel)) return NextResponse.json({ error: "Voice notes go by text (SMS) or WhatsApp" }, { status: 400 });
  if (!(file instanceof Blob) || file.size === 0) return NextResponse.json({ error: "No recording received" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "That voice note is too big for a text — keep it under 2 minutes" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikeMp3(bytes)) return NextResponse.json({ error: "The recording isn't an MP3 — try recording again" }, { status: 400 });

  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 });

  const svc = createServiceClient();
  const path = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}.mp3`;
  const { error: upErr } = await svc.storage.from(BUCKET).upload(path, bytes, { contentType: "audio/mpeg", upsert: false });
  if (upErr) return NextResponse.json({ error: `Couldn't store the recording: ${upErr.message}` }, { status: 500 });
  const url = svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  const r = await sendConversationMessage(acct, { contactId, message: "", channel, attachments: [url] });
  if (!r.ok) {
    // Nothing went out — don't leave the file behind.
    await svc.storage.from(BUCKET).remove([path]).catch(() => undefined);
    return NextResponse.json({ error: r.error ?? "Send failed" }, { status: 502 });
  }
  return NextResponse.json({ success: true, url, ...(r.via ? { via: r.via } : {}) });
}
