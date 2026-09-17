import type { SupabaseClient } from "@supabase/supabase-js";

// Which program (V3 / V2.3 / V1) is a client on? One matcher, used by the
// Funnels tab, the funnel page itself, and the optimizer — all reading the
// same Clients Master row the dashboard's version switchers edit, so the
// program can never mean different things in different places.

export type ProgramRow = { sheet_row: number; business_name: string | null; version: string | null; owner_name: string | null };
export type ClientProgram = { version: string; sheetRow: number; ownerName: string; matches: number; via: "exact" | "prefix" };

export const normBiz = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/* The program rows change at sheet-sync cadence (~15 min), but the funnel
   render was paying a full-view fetch (~65KB over the wire) per visitor.
   Per-lambda memo, 60s — the same staleness class as the page's own CDN
   window. Display-only data: never copy this pattern to anything that
   gates writes or dedupes. */
let memo: { at: number; rows: ProgramRow[] } | null = null;
export async function fetchProgramRows(svc: SupabaseClient): Promise<ProgramRow[]> {
  if (memo && Date.now() - memo.at < 60_000) return memo.rows;
  const { data } = await svc.from("client_program_rows").select("sheet_row, business_name, version, owner_name");
  const rows = (data ?? []) as ProgramRow[];
  if (data) memo = { at: Date.now(), rows };
  return rows;
}

/* Exact normalized-name match first; a prefix match only when exactly ONE
   sheet row claims it (the "…- ad account" suffix case), never a guess
   between two. Duplicate matches keep the newest sheet row. */
export function findClientProgram(rows: ProgramRow[], clientName: string): ClientProgram | null {
  const key = normBiz(clientName);
  if (key.length < 4) return null;
  const all = rows.map((p) => ({ ...p, norm: normBiz(String(p.business_name ?? "")) }));
  let hits = all.filter((p) => p.norm === key);
  let via: "exact" | "prefix" = "exact";
  if (!hits.length && key.length >= 8) {
    hits = all.filter((p) => p.norm.length >= 8 && (p.norm.startsWith(key) || key.startsWith(p.norm)));
    via = "prefix";
    if (hits.length !== 1) return null;
  }
  if (!hits.length) return null;
  const best = hits.reduce((a, b) => (b.sheet_row > a.sheet_row ? b : a));
  return {
    version: String(best.version ?? ""),
    sheetRow: best.sheet_row,
    ownerName: String(best.owner_name ?? ""),
    matches: hits.length,
    via,
  };
}
