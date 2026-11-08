import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

/* The deposit-reminder email's "Finish my booking" button points at
   /<slug>/<contactId>/confirm?via=email. The middleware sends that request
   here first: we note the first open on her pick_email_people row, then send
   her on to the normal confirm link (the same page the AI's texts open), so
   the test card can tell "paid after opening the email" from "paid anyway".
   Public by design — the contact id in the path is the same bearer the link
   already carries, and nothing comes back but a redirect. Mail scanners that
   prefetch links count as an open too; the card says so. */
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const slug = String(req.headers.get("x-ob-slug") ?? req.nextUrl.searchParams.get("slug") ?? "").trim().toLowerCase();
  const contact = String(req.headers.get("x-ob-contact") ?? req.nextUrl.searchParams.get("t") ?? "").trim();
  const host = (req.headers.get("host") ?? "book.pmu-care.com").toLowerCase();
  const origin = `${req.nextUrl.protocol}//${host}`;
  if (!/^[a-z0-9-]{1,80}$/.test(slug) || !/^[A-Za-z0-9]{8,40}$/.test(contact)) {
    return NextResponse.redirect(`${origin}/`, { status: 302, headers: NO_STORE });
  }
  try {
    await createServiceClient().from("pick_email_people")
      .update({ clicked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("contact_id", contact).is("clicked_at", null);
  } catch {
    /* The stamp is bookkeeping — she still reaches her page. */
  }
  return NextResponse.redirect(`${origin}/${slug}/${contact}/confirm`, { status: 302, headers: NO_STORE });
}
