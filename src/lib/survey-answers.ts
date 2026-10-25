import { getAppLocationToken } from "@/lib/ghl-app";

const GHL = "https://services.leadconnectorhq.com";
const MAIN_LOC = process.env.GHL_LOCATION_ID || "SfpNMJ5YU9lBkxss47lK";

/* The onboarding survey (main account) saves Business Hours and Years in
   Business on the client's contact; the Clients Master row has no columns
   for them (AI onward is the monthly tracker), so read them from the
   contact by its Contact ID. Only fills what the card doesn't have yet. */
export async function answersFromMainContact(contactId: string, form: Record<string, string>): Promise<Record<string, string>> {
  const want: Record<string, string> = { business_hours: "contact.cc__business_hours", years_in_business: "contact.cc__years_in_business" };
  const need = Object.keys(want).filter((k) => !String(form[k] ?? "").trim());
  if (!contactId || !need.length) return {};
  try {
    const tok = await getAppLocationToken(MAIN_LOC);
    if (!tok.token) return {};
    const H = { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" };
    const fr = await fetch(`${GHL}/locations/${MAIN_LOC}/customFields`, { headers: H });
    const fields = fr.ok ? (((await fr.json()) as { customFields?: Array<{ id: string; fieldKey?: string }> }).customFields ?? []) : [];
    const cr = await fetch(`${GHL}/contacts/${contactId}`, { headers: H });
    if (!cr.ok) return {};
    const vals = (((await cr.json()) as { contact?: { customFields?: Array<{ id: string; value?: unknown }> } }).contact?.customFields ?? []);
    const out: Record<string, string> = {};
    for (const k of need) {
      const f = fields.find((x) => x.fieldKey === want[k]) ?? fields.find((x) => String(x.fieldKey ?? "").startsWith(want[k]));
      let v = f ? vals.find((x) => x.id === f.id)?.value : undefined;
      // Signup survey answer ("5-10 years") when the CC field is empty.
      if ((v === undefined || !String(v).trim()) && k === "years_in_business") {
        const s = fields.find((x) => x.fieldKey === "contact.how_long_have_you_been_a_pmu_artist");
        v = s ? vals.find((x) => x.id === s.id)?.value : undefined;
      }
      if (v !== undefined && String(v).trim()) out[k] = String(v).trim();
    }
    return out;
  } catch { return {}; }
}
