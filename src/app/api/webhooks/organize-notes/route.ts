import { NextRequest, NextResponse } from "next/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { AGENCY_LOCATION_ID, fetchNotes, isOrganizedNote, organizeNotes, renderNotes, writeOrganized } from "@/lib/contact-notes";

export const maxDuration = 120;

// The agency's "AI Phone Call Summarizer -> Notes" workflow calls this after it
// adds a note; "Fathom AI -> Contact Tasks & Notes" calls it on a new recording
// (Fathom writes the demo note itself). It rebuilds the
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
    /* The Fathom workflow fires on the new recording, and Fathom writes its
       note on its own a little later: wait for it (up to ~80 s). */
    let notes = await fetchNotes(tok.token, contactId);
    const fresh = () => {
      const lastOurs = Math.max(0, ...notes.filter((n) => isOrganizedNote(n.body)).map((n) => Date.parse(n.dateUpdated ?? n.dateAdded)));
      return notes.some((n) => !isOrganizedNote(n.body) && Date.parse(n.dateAdded) > lastOurs);
    };
    for (let i = 0; i < 2 && !fresh(); i++) {
      await new Promise((r) => setTimeout(r, 40_000));
      notes = await fetchNotes(tok.token, contactId);
    }
    if (!fresh()) return NextResponse.json({ ok: true, done: "nothing new" });
    const o = await organizeNotes(notes, tags);
    if (!o) return NextResponse.json({ ok: true, done: "no notes" });
    return NextResponse.json({ ok: true, stage: o.stage, done: await writeOrganized(tok.token, contactId, notes, renderNotes(o)) });
  } catch (e) {
    console.error("[organize-notes webhook]", e);
    return NextResponse.json({ ok: false, error: "could not organize the notes" }, { status: 502 });
  }
}
