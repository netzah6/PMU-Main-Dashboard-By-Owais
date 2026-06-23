import { NextRequest, NextResponse } from "next/server";

const GHL_API_KEY = process.env.GHL_API_KEY!;

// Returns the GoHighLevel contact's timezone (used to show the client's local
// time on their profile). Best-effort: returns { timezone: null } if unset.
export async function GET(
  _req: NextRequest,
  { params }: { params: { contactId: string } }
) {
  const { contactId } = params;
  if (!contactId) {
    return NextResponse.json({ error: "contactId required" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          "Content-Type": "application/json",
          Version: "2021-07-28",
        },
        next: { revalidate: 600 },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `GHL API error ${res.status}: ${text}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    const contact = data.contact ?? data;
    return NextResponse.json({ timezone: contact?.timezone ?? null });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
