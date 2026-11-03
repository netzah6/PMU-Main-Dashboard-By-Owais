import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getSheetsClient, getSheetEntryForTable, resolveTabName } from "@/lib/sheets";

// New coach report from the Reports tab → next empty row of "Add Data -
// Tracking" (the same sheet the team used to type into) + the dashboard copy,
// so it shows at once instead of after the next sheet sync. Booking % (J) and
// Declining % (L) are sheet formulas, so those cells are never written.
const FIELDS = [
  "Name", "Date", "Happy?", "Last Strategy?", "Deposits?", "Sessions Done?", "Call or Chat?",
  "Total Leads", "Total Declining", "Dashboard Organized?", "Call 2X In a Row?", "Call In 24/H?",
  "5-7 PM?", "3X Follow Ups?", "What’s the price?", "Follow Script?", "Action", "Notes",
];
const NUMERIC = new Set(["Sessions Done?", "Total Leads", "Total Declining"]);

const colLetter = (n: number) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { values?: Record<string, unknown> };
  const vals: Record<string, string | number> = {};
  for (const f of FIELDS) {
    const raw = body.values?.[f];
    if (raw == null || String(raw).trim() === "") continue;
    if (NUMERIC.has(f)) {
      const n = Number(String(raw).replace(/[,\s]/g, ""));
      if (!Number.isFinite(n)) return NextResponse.json({ error: `${f} must be a number` }, { status: 400 });
      vals[f] = n;
    } else vals[f] = String(raw).trim();
  }
  if (!vals["Name"] || !vals["Date"]) return NextResponse.json({ error: "Name and Date are required" }, { status: 400 });
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(vals["Date"]))) return NextResponse.json({ error: "Date must be MM/DD/YYYY" }, { status: 400 });

  const entry = getSheetEntryForTable("performance_tracking");
  if (!entry) return NextResponse.json({ error: "Tracking sheet not configured" }, { status: 500 });
  const sheets = await getSheetsClient();
  const tab = await resolveTabName(entry.spreadsheetId, entry.sheetName, entry.fallbackIndex);
  const got = await sheets.spreadsheets.values.get({ spreadsheetId: entry.spreadsheetId, range: `'${tab}'!A1:Z`, valueRenderOption: "FORMATTED_VALUE" });
  const rows = (got.data.values ?? []) as string[][];
  const hIdx = rows.findIndex((r, i) => i < 10 && r.includes("Name") && r.includes("Date"));
  if (hIdx < 0) return NextResponse.json({ error: "Header row not found on the sheet" }, { status: 500 });
  const headers = rows[hIdx].map((h) => String(h ?? "").trim());
  const nameCol = headers.indexOf("Name");
  let last = hIdx;
  rows.forEach((r, i) => { if (i > hIdx && String(r[nameCol] ?? "").trim()) last = i; });
  const rowNumber = last + 2; // 1-based row after the last filled one

  const data = FIELDS.filter((f) => f in vals && headers.indexOf(f) >= 0).map((f) => ({
    range: `'${tab}'!${colLetter(headers.indexOf(f) + 1)}${rowNumber}`,
    values: [[vals[f]]],
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: entry.spreadsheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data },
  });

  const leads = typeof vals["Total Leads"] === "number" ? vals["Total Leads"] : null;
  const row: Record<string, unknown> = { ...vals, row_number: rowNumber };
  if (leads) {
    if (typeof vals["Sessions Done?"] === "number") row["Booking %"] = vals["Sessions Done?"] / leads;
    if (typeof vals["Total Declining"] === "number") row["Declining %"] = vals["Total Declining"] / leads;
  }
  const svc = createServiceClient();
  const { error } = await svc.from("performance_tracking")
    .upsert({ sheet_row: rowNumber, data: row, synced_at: new Date().toISOString() }, { onConflict: "sheet_row" });
  return NextResponse.json({ success: true, rowNumber, dashboardSaved: !error, dashboardError: error?.message ?? null });
}
