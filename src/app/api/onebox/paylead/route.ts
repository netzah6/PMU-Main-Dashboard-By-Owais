import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getSurveyFieldMap } from "@/lib/onebox";
import { getAppLocationToken } from "@/lib/ghl-app";

// Payment-link lookup: the AI's follow-up message sends the lead
//   {{custom_values.cc__deposit_funnel_url}}?t={{contact.id}}
// (/​<slug>/confirm). The engine calls this with the slug + that contact id
// and gets back the lead's identity and reserved slot, so the page can land
// straight on the deposit step with everything filled in. The contact id is
// the bearer credential — GHL ids are long random strings the lead received
// in their own text message; nothing here is served without one.
export const dynamic = "force-dynamic";
export const preferredRegion = "hnd1";
export const fetchCache = "force-no-store";

/* "Friday, September 20, 2026 5:00 PM" (the exact shape fmtReservedTime
   writes, and what the team/AI types into the reserved-time field) back to
   a wall-clock ISO the engine's calendar understands. Returns "" when the
   text doesn't parse — the lead just sees the calendar instead. */
const MONTHS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
function parseReservedTime(text: string): string {
  const m = String(text).match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return "";
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return "";
  let hour = Number(m[4]) % 12;
  if (/pm/i.test(m[6])) hour += 12;
  const p2 = (n: number) => (n < 10 ? "0" : "") + n;
  return `${m[3]}-${p2(month)}-${p2(Number(m[2]))}T${p2(hour)}:${m[5]}:00`;
}

export async function GET(req: NextRequest) {
  const slug = String(req.nextUrl.searchParams.get("slug") ?? "").trim().toLowerCase();
  const t = String(req.nextUrl.searchParams.get("t") ?? "").trim();
  if (!slug || !/^[A-Za-z0-9]{8,40}$/.test(t)) {
    return NextResponse.json({ ok: false }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const svc = createServiceClient();
  const [{ data: client }, { data: lead }] = await Promise.all([
    svc.from("onebox_clients").select("location_id").eq("slug", slug).maybeSingle(),
    svc.from("onebox_leads")
      .select("full_name, phone, answers, slot_iso, ghl_status")
      .eq("slug", slug).eq("ghl_contact_id", t)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!client || !lead) {
    return NextResponse.json({ ok: false }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  let slotIso = String(lead.slot_iso ?? "");
  if (!slotIso) {
    /* No slot picked on the funnel — the AI may have agreed a time in chat
       and written it into the contact's reserved-time field. Best-effort:
       a miss just means the lead picks on the calendar. */
    try {
      const tok = await getAppLocationToken(client.location_id as string);
      if (tok.token) {
        const fieldMap = await getSurveyFieldMap(client.location_id as string, tok.token);
        if (fieldMap.reserved_time) {
          const r = await fetch(`https://services.leadconnectorhq.com/contacts/${t}`, {
            headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" },
          });
          if (r.ok) {
            const j = (await r.json()) as { contact?: { customFields?: { id?: string; value?: unknown }[] } };
            const f = (j.contact?.customFields ?? []).find((x) => x.id === fieldMap.reserved_time);
            if (f?.value) slotIso = parseReservedTime(String(f.value));
          }
        }
      }
    } catch { /* calendar fallback */ }
  }
  const email = String((lead.answers as { email?: string } | null)?.email ?? "");
  return NextResponse.json(
    { ok: true, name: String(lead.full_name ?? ""), phone: String(lead.phone ?? ""), email, slotIso },
    { headers: { "Cache-Control": "no-store" } }
  );
}
