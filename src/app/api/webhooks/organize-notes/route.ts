import { NextRequest, NextResponse } from "next/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { AGENCY_LOCATION_ID, fetchNotes, isOrganizedNote, organizeNotes, renderNotes, writeOrganized } from "@/lib/contact-notes";

export const maxDuration = 120;

// The agency's note workflows ("AI Phone Call Summarizer -> Notes", "Fathom AI
// -> Contact Tasks & Notes") call this after they add a note. It rebuilds the
// contact's pinned 📋 DISCOVERY / 🎥 DEMO / 🤝 CLIENT CALLS notes (see
// lib/contact-notes). No session: it returns no contact data, only touches
// notes we wrote, and does nothing when no note is newer than ours.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { contact_id?: unknown; contactId?: unknown };
  const contactId = String(body.contact_id ?? body.contactId ?? "").trim();
  if (!/^[A-Za-z0-9]{8,40}$/.test(contactId)) return NextResponse.json({ error: "contact_id missing" }, { status: 400 });
  try {
    const tok = await getAppLocationToken(AGENCY_LOCATION_ID);
    if (!tok.token) return NextResponse.json({ ok: false, error: "no token" }, { status: 502 });
    const cr = await fetch(`https://services.leadconnectorhq.com/contacts/${encodeURIComponent(contactId)}`, { headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" } });
    if (!cr.ok) return NextResponse.json({ ok: false, error: `contact HTTP ${cr.status}` }, { status: 404 });
    const tags = (((await cr.json()) as { contact?: { tags?: string[] } }).contact?.tags ?? []);
    const notes = await fetchNotes(tok.token, contactId);
    const lastOurs = Math.max(0, ...notes.filter((n) => isOrganizedNote(n.body)).map((n) => Date.parse(n.dateUpdated ?? n.dateAdded)));
    if (!notes.some((n) => !isOrganizedNote(n.body) && Date.parse(n.dateAdded) > lastOurs)) return NextResponse.json({ ok: true, done: "nothing new" });
    const o = await organizeNotes(notes, tags);
    if (!o) return NextResponse.json({ ok: true, done: "no notes" });
    return NextResponse.json({ ok: true, stage: o.stage, done: await writeOrganized(tok.token, contactId, notes, renderNotes(o)) });
  } catch (e) {
    console.error("[organize-notes webhook]", e);
    return NextResponse.json({ ok: false, error: "could not organize the notes" }, { status: 502 });
  }
}
