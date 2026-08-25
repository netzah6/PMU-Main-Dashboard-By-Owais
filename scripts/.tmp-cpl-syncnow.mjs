// One-off local sync of the 4 CPL tables (SHEET4) — same strategy as sync.ts:
// upsert by sheet_row, guarded tail delete. These tabs are small (~150 rows).
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const auth = new google.auth.JWT({ email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth });
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const TABS = [
  ["7 Days CPL", "cpl_7days"], ["14 Days CPL", "cpl_14days"],
  ["30 Days CPL", "cpl_30days"], ["All Time Campaign Budget", "campaign_spent"],
];
const buildHeaders = (row) => {
  const seen = new Map();
  return row.map((h, i) => {
    const base = String(h ?? "").trim() !== "" ? String(h).trim() : `col_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
};
for (const [tab, table] of TABS) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: env.SHEET4_ID, range: `'${tab}'`, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" });
  const rows = r.data.values ?? [];
  // best header row within first 10 (skips the "Last updated" banner)
  let hIdx = 0, maxN = 0;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const n = rows[i].filter((c) => c != null && String(c).trim() !== "").length;
    if (n > maxN) { maxN = n; hIdx = i; }
  }
  const headers = buildHeaders(rows[hIdx]);
  const now = new Date().toISOString();
  const objects = rows.slice(hIdx + 1).map((row, i) => {
    const o = { row_number: hIdx + 2 + i };
    headers.forEach((h, j) => { o[h] = row[j] ?? ""; });
    return o;
  }).filter((o) => headers.some((h) => String(o[h] ?? "").trim() !== ""));
  let maxRow = 0;
  for (let i = 0; i < objects.length; i += 400) {
    const batch = objects.slice(i, i + 400).map((data) => {
      if (data.row_number > maxRow) maxRow = data.row_number;
      return { sheet_row: data.row_number, data, synced_at: now };
    });
    const { error } = await sb.from(table).upsert(batch, { onConflict: "sheet_row" });
    if (error) { console.log(`${table} UPSERT ERROR:`, error.message); break; }
  }
  const { count } = await sb.from(table).select("*", { count: "exact", head: true }).gt("sheet_row", maxRow);
  if ((count ?? 0) > 0 && (count ?? 0) <= 50) await sb.from(table).delete().gt("sheet_row", maxRow);
  console.log(`${table}: synced ${objects.length} rows (max sheet_row ${maxRow}, stale beyond: ${count ?? 0})`);
}
