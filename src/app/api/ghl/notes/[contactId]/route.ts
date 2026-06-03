import { NextRequest, NextResponse } from "next/server";

const GHL_API_KEY = process.env.GHL_API_KEY!;

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
      `https://services.leadconnectorhq.com/contacts/${contactId}/notes?limit=5`,
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          "Content-Type": "application/json",
          Version: "2021-07-28",
        },
        next: { revalidate: 300 },
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
    const notes = data.notes ?? [];

    return NextResponse.json({ notes: notes.slice(0, 5) });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
