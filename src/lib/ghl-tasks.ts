import { getSheetsClient } from "@/lib/sheets";

// Resolve the "PMU Bookings On Demand" sub-account (locationId + private token)
// from the "Private Integrations - GHL" keys sheet. Tasks are read from this
// account only.
export async function getPmuTasksAccount(): Promise<{ locationId: string; token: string } | null> {
  const sheetId = process.env.GHL_KEYS_SHEET_ID;
  if (!sheetId) return null;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Sheet1" });
  const rows = (res.data.values ?? []) as string[][];
  if (rows.length < 2) return null;
  const header = (rows[0] ?? []).map((h) => String(h ?? "").toLowerCase());
  const nameIdx = header.findIndex((h) => /^name/.test(h.trim()));
  const bizIdx = header.findIndex((h) => /business/.test(h));
  const locIdx = header.findIndex((h) => /location/.test(h));
  const tokIdx = header.findIndex((h) => /integration|private|key|token/.test(h));

  for (const r of rows.slice(1)) {
    const hay = `${r[nameIdx] ?? ""} ${bizIdx >= 0 ? r[bizIdx] ?? "" : ""}`.toLowerCase();
    if (hay.includes("bookings on demand") || hay.includes("pmu bookings")) {
      const locationId = String(r[locIdx] ?? "").trim();
      const token = String(r[tokIdx] ?? "").trim();
      if (locationId && token) return { locationId, token };
    }
  }
  return null;
}

export const GHL_BASE = "https://services.leadconnectorhq.com";
export const GHL_VERSION = "2021-07-28";
