import type { SupabaseClient } from "@supabase/supabase-js";
import { agencyHeaders, MAIN_LOC } from "@/lib/first-cycle";
import { buildHeaderNames, getSheetsClient } from "@/lib/sheets";

/* New clients and launch calls land in the DASHBOARD first (owner, 11/08/2026:
   "count only on the dashboard data"). Two agency workflows used to write the
   Clients Master Google Sheet straight from GHL:
     "Onboarding survey -> Webhook -> Welcome CEO."   → new row (B..AH)
     "Update Launch Call Data - Master Google Sheet"  → Launch Call (F) + Assigned (J)
   They now call /api/webhooks/clients-master with the contact id. Every value
   is read from GHL here (never from the caller), saved to the clients_master
   table, and copied into the sheet as a backup, so the sheet's own tabs that
   read Clients Master (V3 pricing, Performance Master…) keep working.

   The column mapping is the workflows' own, read from the GHL editor on
   11/08/2026; only the branch columns differ (Version, Ad Spent, Want V2.3?). */

const GHL = "https://services.leadconnectorhq.com";
const TAB = "Clients Master";
const sheetId = () => process.env.SHEET1_ID!;

export type IntakeVersion = "V2.3" | "V1" | "V3";
export const INTAKE_VERSIONS: IntakeVersion[] = ["V2.3", "V1", "V3"];

type Contact = {
  id: string; firstName?: string; lastName?: string; email?: string; phone?: string;
  timezone?: string; assignedTo?: string;
  customFields?: Array<{ id: string; value?: unknown }>;
};

const asText = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v));

export async function readContact(H: Record<string, string>, contactId: string) {
  const r = await fetch(`${GHL}/contacts/${encodeURIComponent(contactId)}`, { headers: H });
  if (!r.ok) throw new Error(`contact read HTTP ${r.status}`);
  const contact = ((await r.json()) as { contact?: Contact }).contact;
  if (!contact?.id) throw new Error("contact not found");
  const list = (await fetch(`${GHL}/locations/${MAIN_LOC}/customFields?model=contact`, { headers: H }).then((x) => x.json())) as { customFields?: Array<{ id: string; name: string }> };
  const byName = new Map((list.customFields ?? []).map((f) => [f.name.trim().toLowerCase(), f.id]));
  const cf = (name: string) => {
    const id = byName.get(name.trim().toLowerCase());
    return asText((contact.customFields ?? []).find((f) => f.id === id)?.value).trim();
  };
  return { contact, cf };
}

/* The B..AH values, in column order, exactly as the workflow's Google Sheets step built them. */
export function intakeRow(contact: Contact, cf: (name: string) => string, version: IntakeVersion): string[] {
  const full = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim();
  const business = cf("Business Name");
  // GHL's {{contact.phone}} printed US numbers as (919) 987-5046; a foreign
  // "+52…" number broke the cell (#ERROR!, row 681), so keep those as text.
  const raw = String(contact.phone ?? "").trim();
  const us = raw.replace(/\D/g, "").match(/^1?(\d{3})(\d{3})(\d{4})$/);
  const phone = us && (raw.startsWith("+1") || !raw.startsWith("+")) ? `(${us[1]}) ${us[2]}-${us[3]}` : raw ? `'${raw}` : "";
  return [
    full,                                                     // B Owner Full Name
    business,                                                 // C Ad account Name
    business,                                                 // D Business Name
    "", "", "", "", "", "",                                   // E Agreement … J Assigned
    "Marie",                                                  // K Media Buyer
    "", "",                                                   // L UNSUBSCRIBE Removed, M Instagram Widget
    version,                                                  // N Version (plain "V1"; the team adds brackets later)
    "", "", "", "",                                           // O Sync Schedule … R AI Agent Access
    cf("Permanent Makeup Services"),                          // S PMU Services
    cf("Campaign Content Source"),                            // T Campaign Type
    cf("Which offer would you like to feature in your campaign?"), // U Offer
    String(contact.email ?? ""),                              // V Email
    phone,                                                    // W Phone
    cf("Generate new local business number?"),                // X
    cf("Your Full Business Adress"),                          // Y Location
    cf("CC - Facebook Page Link"),                            // Z FB Page link
    cf("Campaign Content Source"),                            // AA Content Source
    cf("Languages:"),                                         // AB Languages
    version === "V3" ? cf("Social Media Ad Spent") : cf("Facebook Ad spent1"), // AC Ad Spent
    cf("CC - Instagram Page Link"),                           // AD IG Page link
    cf("Approximately how many followers do you have on Instagram?"), // AE IG Followers
    cf("Notes"),                                              // AF Notes
    version === "V3" ? "$50 ✅ Yes — activate it for me!" : `$50 ${cf("Want to sign up for the V2 deposit beta?")}`, // AG
    contact.id,                                               // AH Contact ID
  ];
}

/* Re-read one sheet row the way the 15-minute sync does and store it in the table. */
async function mirrorRow(svc: SupabaseClient, row: number): Promise<Record<string, unknown>> {
  const s = await getSheetsClient();
  const [head, body] = await Promise.all([
    s.spreadsheets.values.get({ spreadsheetId: sheetId(), range: `'${TAB}'!1:1`, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" }),
    s.spreadsheets.values.get({ spreadsheetId: sheetId(), range: `'${TAB}'!${row}:${row}`, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" }),
  ]);
  const headers = buildHeaderNames((head.data.values ?? [[]])[0]);
  const vals = (body.data.values ?? [[]])[0] ?? [];
  const data: Record<string, unknown> = { row_number: row };
  headers.forEach((h, i) => { const v = vals[i]; data[h] = v === undefined || v === "" ? "" : v; });
  const { error } = await svc.from("clients_master").upsert({ sheet_row: row, data, synced_at: new Date().toISOString() }, { onConflict: "sheet_row" });
  if (error) throw new Error(`dashboard save: ${error.message}`);
  return data;
}

async function rowForContact(svc: SupabaseClient, contactId: string): Promise<number | null> {
  const { data } = await svc.from("clients_master").select("sheet_row").eq("data->>Contact ID", contactId).order("sheet_row", { ascending: false }).limit(1);
  return ((data ?? [])[0] as { sheet_row?: number } | undefined)?.sheet_row ?? null;
}

/* New client from the onboarding survey. One row per Contact ID: a second
   submission no longer adds a duplicate (Jennifer Montoya, Nancy Duarte). */
export async function addNewClient(svc: SupabaseClient, contactId: string, version: IntakeVersion, opts: { dryRun?: boolean } = {}) {
  const a = await agencyHeaders();
  if ("error" in a) throw new Error(a.error);
  const { contact, cf } = await readContact(a.H, contactId);
  const values = intakeRow(contact, cf, version);
  if (!values[0] && !values[2]) return { ok: false as const, skipped: "contact has no name or business name" };
  const existing = await rowForContact(svc, contact.id);
  if (existing) return { ok: true as const, skipped: "already in the dashboard", sheet_row: existing };
  if (opts.dryRun) return { ok: true as const, dryRun: true, values };
  const s = await getSheetsClient();
  const res = await s.spreadsheets.values.append({
    spreadsheetId: sheetId(), range: `'${TAB}'!A:AH`, valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [["", ...values]] },
  });
  const m = String(res.data.updates?.updatedRange ?? "").match(/![A-Z]+(\d+)/);
  if (!m) throw new Error(`sheet append gave no row (${res.data.updates?.updatedRange})`);
  const row = Number(m[1]);
  await mirrorRow(svc, row);
  return { ok: true as const, sheet_row: row };
}

/* The text the workflow wrote, e.g. "Monday, November 9, 2026 11:00": the
   start time in the CLIENT's time zone (GHL's API gives agency/Pacific time
   with no offset). Checked on 5 rows 11/08/2026 (Riya 08:00 PT → 11:00 ET,
   Nancy Duarte 07:00 PT → 09:00 CT). */
function launchText(apiStart: string, fromTz: string, toTz: string): string {
  const [d, t = "00:00:00"] = apiStart.trim().split(/[ T]/);
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  // Wall-clock time in fromTz → real instant (two passes cover DST edges).
  let ms = Date.UTC(y, mo - 1, da, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: fromTz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    ms += Date.UTC(y, mo - 1, da, h, mi) - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  }
  const at = new Date(ms);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: toTz, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(at);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: toTz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return `${day} ${time}`;
}

/* Confirmed launch call: Launch Call (F) = start time, Assigned (J) = the
   contact OWNER's first name (the workflow's "User.First Name" — matches the
   sheet on all rows checked; the call host does not, e.g. Nancy Duarte). */
export async function recordLaunchCall(svc: SupabaseClient, contactId: string, opts: { dryRun?: boolean } = {}) {
  const a = await agencyHeaders();
  if ("error" in a) throw new Error(a.error);
  const H = a.H;
  const { contact } = await readContact(H, contactId);
  const cals = (await fetch(`${GHL}/calendars/?locationId=${MAIN_LOC}`, { headers: { ...H, Version: "2021-04-15" } }).then((x) => x.json())) as { calendars?: Array<{ id: string; name: string }> };
  const launchIds = new Set((cals.calendars ?? []).filter((c) => /launch\s*call/i.test(c.name)).map((c) => c.id));
  const ap = (await fetch(`${GHL}/contacts/${encodeURIComponent(contact.id)}/appointments`, { headers: H }).then((x) => x.json())) as { events?: Array<{ calendarId: string; startTime: string; appointmentStatus?: string; assignedUserId?: string; dateUpdated?: string }> };
  const calls = (ap.events ?? []).filter((e) => launchIds.has(e.calendarId) && /confirmed/i.test(String(e.appointmentStatus)));
  if (!calls.length) return { ok: false as const, skipped: "no confirmed launch call" };
  // The one that just changed — what the workflow's trigger fired on.
  calls.sort((x, y) => String(y.dateUpdated ?? y.startTime).localeCompare(String(x.dateUpdated ?? x.startTime)));
  const call = calls[0];
  let host = "";
  if (contact.assignedTo) {
    const u = (await fetch(`${GHL}/users/${contact.assignedTo}`, { headers: H }).then((x) => x.json()).catch(() => ({}))) as { firstName?: string };
    host = String(u.firstName ?? "").trim();
  }
  const loc = (await fetch(`${GHL}/locations/${MAIN_LOC}`, { headers: H }).then((x) => x.json()).catch(() => ({}))) as { location?: { timezone?: string } };
  const agencyTz = loc.location?.timezone || "America/Los_Angeles";
  const when = launchText(call.startTime, agencyTz, contact.timezone || agencyTz);
  // Same row the workflow found: by Contact ID, else the bottom-most row with the owner's name.
  let row = await rowForContact(svc, contact.id);
  if (!row) {
    const full = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim().toLowerCase();
    const { data } = await svc.from("clients_master").select("sheet_row, data").order("sheet_row", { ascending: false }).limit(2000);
    row = ((data ?? []) as Array<{ sheet_row: number; data: Record<string, unknown> }>)
      .find((r) => String(r.data?.["Owner Full Name"] ?? "").trim().toLowerCase() === full)?.sheet_row ?? null;
  }
  if (!row) return { ok: false as const, skipped: "client not in the dashboard" };
  if (opts.dryRun) return { ok: true as const, dryRun: true, sheet_row: row, when, host, start: call.startTime };
  const s = await getSheetsClient();
  const data: Array<{ range: string; values: string[][] }> = [{ range: `'${TAB}'!F${row}`, values: [[when]] }];
  if (host) data.push({ range: `'${TAB}'!J${row}`, values: [[host]] });
  // RAW keeps it text, exactly as the workflow left it (the sheet's DD/MM locale would misread a parsed date).
  await s.spreadsheets.values.batchUpdate({ spreadsheetId: sheetId(), requestBody: { valueInputOption: "RAW", data } });
  await mirrorRow(svc, row);
  return { ok: true as const, sheet_row: row, host };
}
