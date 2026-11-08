import type { SupabaseClient } from "@supabase/supabase-js";
import { writeRowToSheet, getSheetEntryForTable } from "@/lib/sheets";

/* Auto-merge of duplicate Clients Master rows (owner, 11/08/2026).
   Jennifer Montoya had two rows for one client (the onboarding form was sent
   twice), so the dashboard showed her twice and the "Leads but not Live"
   alert stuck on the blank copy. Owner rule: merge future copies by itself,
   but ONLY when all the details match.

   "Match" here means: same client (same GHL Contact ID, or — when there is no
   Contact ID — same owner name + phone + email) and no field where both rows
   hold a different value. A field that is blank on one side is not a
   conflict: the kept row takes the filled value. Any real difference (a
   different status, business name, email, price…) means a person must decide,
   so the rows are left alone. That also protects returning clients, whose old
   Offboarded row and new Live row always differ on status.

   Same mechanics as the Clients tab Merge button: the kept row gets the
   missing values, the other row is marked VOID in column A (never deleted,
   so it can be undone by hand in Google Sheets). */

const STATUS_COL = "col_1";
// Bookkeeping columns that are not client details.
const IGNORE = new Set(["row_number", "_id2", "lat", "lng"]);

type Row = { sheet_row: number; data: Record<string, unknown> };

const norm = (v: unknown): string => {
  if (v === null || v === undefined || v === false) return ""; // unticked box = blank
  return String(v).replace(/\s+/g, " ").trim().toLowerCase();
};
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

function identity(d: Record<string, unknown>): string | null {
  const cid = String(d["Contact ID"] ?? "").trim();
  if (cid && cid.toUpperCase() !== "NOT FOUND") return `cid:${cid}`;
  const owner = norm(d["Owner Full Name"]), phone = digits(d.Phone), email = norm(d.Email);
  return owner && phone && email ? `ope:${owner}|${phone}|${email}` : null;
}

/* Fields where both rows are filled and different. Empty = the rows match. */
export function conflicts(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (IGNORE.has(k)) continue;
    const x = norm(a[k]), y = norm(b[k]);
    if (!x || !y) continue;
    if (k === "Phone" ? digits(a[k]) !== digits(b[k]) : x !== y) out.push(k);
  }
  return out;
}

export type DupeResult = {
  merged: Array<{ keep: number; voided: number; filled: string[] }>;
  differ: Array<{ rows: number[]; business: string; fields: string[] }>;
  error?: string;
};

export async function autoMergeClientDuplicates(svc: SupabaseClient, opts: { dryRun?: boolean } = {}): Promise<DupeResult> {
  const rows: Row[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await svc.from("clients_master").select("sheet_row, data").order("sheet_row").range(i, i + 999);
    if (error) return { merged: [], differ: [], error: error.message };
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (String(r.data?.[STATUS_COL] ?? "").toUpperCase() === "VOID") continue;
    const id = identity(r.data ?? {});
    if (id) groups.set(id, [...(groups.get(id) ?? []), r]);
  }

  // Rows an onboarding points at must survive (its setup run writes there).
  const { data: obs } = await svc.from("onboardings").select("id, form");
  const referenced = new Map<number, string[]>();
  for (const o of (obs ?? []) as Array<{ id: string; form: Record<string, unknown> | null }>) {
    const n = Number(o.form?.master_row ?? 0);
    if (n) referenced.set(n, [...(referenced.get(n) ?? []), o.id]);
  }

  const entry = getSheetEntryForTable("clients_master");
  if (!entry) return { merged: [], differ: [], error: "Clients Master sheet not configured" };
  const res: DupeResult = { merged: [], differ: [] };

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // Every pair must match, or nobody in the group is touched.
    const bad = new Set<string>();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) conflicts(list[i].data, list[j].data).forEach((f) => bad.add(f));
    if (bad.size) {
      res.differ.push({ rows: list.map((r) => r.sheet_row), business: String(list[0].data["Business Name"] ?? ""), fields: [...bad] });
      continue;
    }
    // Keep: the row an onboarding uses, else the one with a status, else the newest.
    const rank = (r: Row) => (referenced.has(r.sheet_row) ? 4 : 0) + (norm(r.data[STATUS_COL]) ? 2 : 0) + r.sheet_row / 1e6;
    const [keep, ...drops] = [...list].sort((a, b) => rank(b) - rank(a));
    const filled: Record<string, unknown> = {};
    for (const d of drops) for (const [k, v] of Object.entries(d.data)) {
      if (IGNORE.has(k) || !norm(v) || norm(keep.data[k]) || k in filled) continue;
      filled[k] = v;
    }
    res.merged.push({ keep: keep.sheet_row, voided: drops[0].sheet_row, filled: Object.keys(filled) });
    for (const d of drops.slice(1)) res.merged.push({ keep: keep.sheet_row, voided: d.sheet_row, filled: [] });
    if (opts.dryRun) continue;

    if (Object.keys(filled).length) {
      const merged = { ...keep.data, ...filled, row_number: keep.sheet_row };
      await writeRowToSheet(entry.spreadsheetId, entry.sheetName, keep.sheet_row, merged, entry.fallbackIndex, Object.keys(filled));
      await svc.from("clients_master").update({ data: merged }).eq("sheet_row", keep.sheet_row);
    }
    for (const d of drops) {
      await writeRowToSheet(entry.spreadsheetId, entry.sheetName, d.sheet_row, { ...d.data, [STATUS_COL]: "VOID", row_number: d.sheet_row }, entry.fallbackIndex, [STATUS_COL]);
      await svc.from("clients_master").delete().eq("sheet_row", d.sheet_row);
      // An onboarding that pointed at the voided copy now points at the kept row.
      for (const id of referenced.get(d.sheet_row) ?? []) {
        const o = (obs ?? []).find((x) => x.id === id) as { form: Record<string, unknown> } | undefined;
        if (o) await svc.from("onboardings").update({ form: { ...o.form, master_row: String(keep.sheet_row) } }).eq("id", id);
      }
    }
  }
  return res;
}
