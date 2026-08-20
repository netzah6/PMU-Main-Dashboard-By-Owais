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

// The GHL user whose email matches a dashboard login, for scoping the Tasks
// tab: non-admins only see (and may only update) tasks assigned to their own
// GHL user. Matching is by email, case-insensitively — the coaches log in to
// the dashboard and to GHL with the same address.
export async function ghlUserIdForEmail(
  acct: { locationId: string; token: string },
  email: string | null | undefined
): Promise<string | null> {
  if (!email) return null;
  const r = await fetch(`${GHL_BASE}/users/?locationId=${acct.locationId}`, {
    headers: { Authorization: `Bearer ${acct.token}`, Version: GHL_VERSION, Accept: "application/json" },
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { users?: Array<{ id?: string; email?: string }> };
  const want = email.trim().toLowerCase();
  const hit = (j.users ?? []).find((u) => String(u.email ?? "").trim().toLowerCase() === want);
  return hit?.id ? String(hit.id) : null;
}
