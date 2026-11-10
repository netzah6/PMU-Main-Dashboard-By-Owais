import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createServiceClient } from "@/lib/supabase/server";
import { processContact, recordEvent } from "@/lib/contact-notes";

export const maxDuration = 300;

/* Called by the agency's GHL workflows (see lib/contact-notes):
   - "AI Phone Call Summarizer -> Notes": after every call over 60 s, with
     source=call, the call transcript, its GPT summary and the branch.
   - "Fathom AI -> Contact Tasks & Notes": on a new demo recording,
     source=fathom (Fathom writes its own note; we wait for it).
   Header x-notes-key must match app_settings "sales_notes_webhook_key".
   The call is stored first (nothing is lost), the answer goes back at once,
   and the notes are rebuilt in the background; a cron retries failures. */
export async function POST(req: NextRequest) {
  const svc = createServiceClient();
  const { data: k } = await svc.from("app_settings").select("value").eq("key", "sales_notes_webhook_key").maybeSingle();
  const expected = String((k?.value as { key?: string } | null)?.key ?? "");
  if (!expected || req.headers.get("x-notes-key") !== expected) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const custom = (raw.customData && typeof raw.customData === "object" ? raw.customData : {}) as Record<string, unknown>;
  const pick = (key: string) => { const v = custom[key] ?? raw[key]; return typeof v === "string" ? v : v == null ? "" : String(v); };
  const contactId = (pick("contact_id") || pick("contactId")).trim();
  if (!/^[A-Za-z0-9]{8,40}$/.test(contactId)) return NextResponse.json({ error: "contact_id missing" }, { status: 400 });
  const source = pick("source") === "fathom" ? "fathom" : "call";
  // An unfilled GHL merge field arrives as "{{...}}" or empty: treat as nothing.
  const clean = (s: string) => (/^\s*\{\{.*\}\}\s*$/.test(s) ? "" : s);
  const transcript = clean(pick("transcript")), summary = clean(pick("summary"));
  if (source === "call" && !transcript.trim() && !summary.trim()) return NextResponse.json({ ok: true, done: "empty call, nothing stored" });

  try {
    const ev = await recordEvent(svc, { contactId, source, branch: pick("branch") || null, transcript, summary });
    if (!ev.duplicate) waitUntil(processContact(svc, contactId, { waitForFathom: source === "fathom" }).catch((e) => console.error("[organize-notes]", e)));
    return NextResponse.json({ ok: true, stored: ev.id, duplicate: ev.duplicate });
  } catch (e) {
    console.error("[organize-notes webhook]", e);
    return NextResponse.json({ ok: false, error: "could not store the call" }, { status: 500 });
  }
}
