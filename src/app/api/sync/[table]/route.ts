import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { writeRowToSheet, getSheetEntryForTable } from "@/lib/sheets";
import { syncAssignedToGhl, type AssignSyncResult } from "@/lib/ghl-assign";

export async function GET(
  _req: NextRequest,
  { params }: { params: { table: string } }
) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from(params.table)
    .select("id, data")
    .order("id", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type DbRow = { id: string; data: Record<string, unknown> };
  return NextResponse.json({
    data: (data ?? []).map((r: DbRow) => ({
      ...r.data,
      _supabase_id: r.id,
      _row_number: r.data?.row_number,
    })),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { table: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { rowNumber, rowData, columns } = body as {
    rowNumber: number;
    rowData: Record<string, unknown>;
    columns?: string[];
  };

  if (!rowNumber || !rowData) {
    return NextResponse.json({ error: "rowNumber and rowData required" }, { status: 400 });
  }

  const serviceClient = createServiceClient();

  // The Onboarding card keeps its own copy of the client's form, so a rename on
  // the Clients tab has to be carried over by hand (owner 10/26: Elena renamed
  // on Clients, the card still showed the old business name).
  let previousNames: { business: string; owner: string } | null = null;

  // Strip internal meta fields, but keep row_number inside the data blob
  const { _supabase_id: _s, _row_number: _r, ...rest } = rowData;
  void _s; void _r;
  const cleanData: Record<string, unknown> = { ...rest, row_number: rowNumber };

  // Field-scoped edits (status dropdown, version, a step, an action) only touch
  // the named columns — so one edit can never clobber another column's value.
  const scoped = Array.isArray(columns) && columns.length > 0;

  // 1. Update Supabase by stable sheet_row key
  let updateErr;
  let contactIdForAssign: unknown = cleanData["Contact ID"];
  if (scoped) {
    const { data: existing } = await serviceClient
      .from(params.table)
      .select("data")
      .eq("sheet_row", rowNumber)
      .maybeSingle();
    if (existing?.data) {
      const before = existing.data as Record<string, unknown>;
      previousNames = { business: String(before["Business Name"] ?? ""), owner: String(before["Owner Full Name"] ?? "") };
      const merged: Record<string, unknown> = { ...before, row_number: rowNumber };
      for (const c of columns!) merged[c] = cleanData[c];
      contactIdForAssign = merged["Contact ID"];
      ({ error: updateErr } = await serviceClient
        .from(params.table)
        .update({ data: merged, synced_at: new Date().toISOString() })
        .eq("sheet_row", rowNumber));
    } else {
      ({ error: updateErr } = await serviceClient
        .from(params.table)
        .update({ data: cleanData, synced_at: new Date().toISOString() })
        .eq("sheet_row", rowNumber));
    }
  } else {
    ({ error: updateErr } = await serviceClient
      .from(params.table)
      .update({ data: cleanData, synced_at: new Date().toISOString() })
      .eq("sheet_row", rowNumber));
  }

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // 2. Write back to Google Sheets
  const sheetEntry = getSheetEntryForTable(params.table);
  let sheetsUpdated = false;
  let sheetsError: string | null = null;

  if (sheetEntry) {
    try {
      await writeRowToSheet(
        sheetEntry.spreadsheetId,
        sheetEntry.sheetName,
        rowNumber,
        cleanData,
        sheetEntry.fallbackIndex,
        scoped ? columns : undefined
      );
      sheetsUpdated = true;
    } catch (e) {
      sheetsError = String(e);
      console.error(`[PATCH] Sheets write-back failed for ${params.table} row ${rowNumber}:`, e);
    }
  }

  // 3. Client owner change → same owner on the client's GHL contact.
  let ghlAssign: AssignSyncResult | null = null;
  const assignChanged = params.table === "clients_master" && (scoped ? columns!.includes("Assigned") : false);
  if (assignChanged) {
    try { ghlAssign = await syncAssignedToGhl(contactIdForAssign, cleanData["Assigned"]); }
    catch (e) { ghlAssign = { ok: false, error: String(e) }; }
  }

  // 4. Client renamed → same name on its open Onboarding card(s).
  let onboardingsRenamed = 0;
  const nameChanged = params.table === "clients_master" && scoped && previousNames
    && (columns!.includes("Business Name") || columns!.includes("Owner Full Name"));
  if (nameChanged) {
    try { onboardingsRenamed = await renameOnboardingCards(serviceClient, previousNames!, cleanData); }
    catch (e) { console.error(`[PATCH] onboarding rename failed for row ${rowNumber}:`, e); }
  }

  return NextResponse.json({ success: true, sheetsUpdated, sheetsError, ghlAssign, onboardingsRenamed });
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Carry a Clients-tab rename onto every unfinished Onboarding card that was
// pre-filled from this row (matched by the OLD business name, or by the old
// owner name when the business name is blank — same rule as setup-start).
// Finished cards and the GHL claim (the real location name) are left alone.
async function renameOnboardingCards(
  svc: ReturnType<typeof createServiceClient>,
  before: { business: string; owner: string },
  row: Record<string, unknown>,
): Promise<number> {
  const business = String(row["Business Name"] ?? "").trim();
  const owner = String(row["Owner Full Name"] ?? "").trim();
  if (!norm(before.business) && !norm(before.owner)) return 0;

  const { data } = await svc.from("onboardings").select("id, status, form").neq("status", "done");
  type Card = { id: string; status: string; form: Record<string, string> | null };
  let n = 0;
  for (const card of (data ?? []) as Card[]) {
    const f = card.form ?? {};
    const hit = norm(before.business)
      ? norm(f.business_name) === norm(before.business)
      : norm(f.owner_name) === norm(before.owner);
    if (!hit) continue;
    const form = { ...f };
    if (business) form.business_name = business;
    if (owner) form.owner_name = owner;
    if (form.business_name === f.business_name && form.owner_name === f.owner_name) continue;
    const { error } = await svc.from("onboardings").update({ form }).eq("id", card.id);
    if (!error) n++;
  }
  return n;
}
