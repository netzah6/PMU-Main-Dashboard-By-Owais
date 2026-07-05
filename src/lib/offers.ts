import { createServiceClient } from "@/lib/supabase/server";
import { getSheetsClient } from "@/lib/sheets";

export interface OfferRefreshResult {
  status: "ok" | "error";
  ok?: number; skipped?: number; failed?: number; appended?: number; error?: string;
}

// Tokenize a name into significant lowercase word tokens (drops punctuation,
// parentheticals collapse to their inner words, single-char tokens dropped).
function nameTokens(s: string): Set<string> {
  return new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .split(" ")
      .filter((t) => t.length >= 2)
  );
}

// True when a keys-sheet name and a V3 owner name refer to the same person,
// tolerant of aliases ("Dez Crowe" vs "Desirie Crowe (Dez)"): a match needs
// 2 shared tokens, or 1 when either side is a single-token name.
function sameClient(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared >= 2 || (shared >= 1 && (a.size === 1 || b.size === 1));
}

// Reads the "Private Integrations - GHL" sheet (Name / Location ID / key) at
// run time, pulls each client's "CC - Offer" custom value from their GHL
// sub-account, and stores just the offer text in client_offers.
// Scope: V3 clients only — non-V3/V2.3 sub-accounts don't carry the
// "CC - Offer" custom value, and the Cost/Deposit tab only shows V3.
// Keys are read transiently server-side and never persisted in Supabase.
export async function refreshOffers(): Promise<OfferRefreshResult> {
  const sheetId = process.env.GHL_KEYS_SHEET_ID;
  if (!sheetId) return { status: "error", error: "GHL_KEYS_SHEET_ID not set" };

  try {
    const supabase = createServiceClient();

    // V3 client roster — only these sub-accounts get refreshed. We key offers by
    // the V3 canonical OWNER/BUSINESS name so the deposit_overview join (which
    // matches on clients_master Owner Full Name / Business Name) lines up even
    // when the keys-sheet name is an alias ("Dez Crowe" vs "Desirie Crowe (Dez)").
    const { data: v3Rows } = await supabase.from("v3_pricing").select("data");
    const v3List = (v3Rows ?? [])
      .map((r) => String((r.data as Record<string, unknown>)?.["OWNER/BUSINESS"] ?? "").trim())
      .filter(Boolean)
      .map((name) => ({ key: name.toLowerCase(), tokens: nameTokens(name) }));
    const matchV3 = (tokens: Set<string>) => v3List.find((v) => sameClient(tokens, v.tokens))?.key ?? null;

    // Clients Master roster (live/paused V2.3+): clients missing from the V3
    // pricing tab still get refreshed, and their pricing row is auto-added to
    // the sheet from their GHL custom values.
    const { data: cmRows } = await supabase.from("clients_master").select("data");
    const roster = (cmRows ?? [])
      .map((r) => r.data as Record<string, unknown>)
      .filter((d) => {
        const ver = String(d?.["Version"] ?? "").toLowerCase();
        const st = String(d?.["col_1"] ?? "").toLowerCase();
        return (ver.includes("v3") || ver.includes("v2.3")) && (st === "live" || st === "paused");
      })
      .map((d) => ({ owner: String(d["Owner Full Name"] ?? "").trim(), tokens: nameTokens(String(d["Owner Full Name"] ?? "")) }))
      .filter((c) => c.owner);
    const matchRoster = (tokens: Set<string>) => roster.find((c) => sameClient(tokens, c.tokens)) ?? null;

    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Sheet1" });
    const rows = (res.data.values ?? []) as string[][];
    if (rows.length < 2) return { status: "ok", ok: 0, skipped: 0, failed: 0 };

    const header = rows[0].map((h) => String(h ?? "").toLowerCase());
    const nameIdx = header.findIndex((h) => /^name/.test(h.trim()));
    const locIdx = header.findIndex((h) => /location/.test(h));
    const tokIdx = header.findIndex((h) => /integration|private|key|token/.test(h));

    let ok = 0, skipped = 0, failed = 0;
    // Pricing rows to auto-add to the V3 tab (client had custom values but no
    // OWNER/BUSINESS row in the sheet).
    const toAppend: string[][] = [];
    for (const row of rows.slice(1)) {
      const name = String(row[nameIdx] ?? "").trim();
      const locationId = String(row[locIdx] ?? "").trim();
      const token = String(row[tokIdx] ?? "").trim();
      if (!name || !locationId || !token) { skipped++; continue; }
      const tokens = nameTokens(name);
      let ownerKey = matchV3(tokens);
      let appendAs: string | null = null; // proper-case name for the new sheet row
      if (!ownerKey) {
        const rc = matchRoster(tokens);
        if (!rc) { skipped++; continue; } // not a V2.3+/V3 client at all
        ownerKey = rc.owner.toLowerCase();
        appendAs = rc.owner;
      }
      try {
        const r = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}/customValues`, {
          headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
        });
        if (!r.ok) { failed++; continue; }
        const j = await r.json();
        const cvs: { name?: string; value?: string }[] = j.customValues ?? [];
        // Find a custom value by normalized-name substring (strips "CC - ", spaces, emoji).
        const cv = (needle: string) => {
          const hit = cvs.find((v) => String(v.name ?? "").toLowerCase().replace(/[^a-z]/g, "").includes(needle));
          return hit ? String(hit.value ?? "") : "";
        };
        const offer = cv("ccoffer");
        const depositAmount = cv("ccdepositamount");
        const originalPrice = cv("ccoriginalprice");
        const discountedPrice = cv("ccdiscountedprice");
        await supabase.from("client_offers").upsert(
          {
            owner_key: ownerKey,
            offer,
            deposit_amount: depositAmount,
            original_price: originalPrice || null,
            discounted_price: discountedPrice || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "owner_key" }
        );
        // Missing from the V3 pricing tab but has pricing custom values →
        // queue a sheet row: OWNER/BUSINESS · DEPOSIT · IG FOLLOWERS ·
        // IG WIDGET · OFFER · PRICE DIFFERENCE · ORIGINAL PRICE · DISCOUNTED PRICE
        if (appendAs && (offer || originalPrice || discountedPrice)) {
          toAppend.push([appendAs, "", "", "", offer, "", originalPrice, discountedPrice]);
        }
        ok++;
      } catch {
        failed++;
      }
    }

    if (toAppend.length) {
      // Guard against duplicates: the v3_pricing TABLE can be stale (it's
      // cron-skipped), so re-check against the LIVE sheet right before
      // appending — a name already in the tab must never be added again.
      const live = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET1_ID!,
        range: "'V3'!A1:A500",
      });
      const existing = new Set(
        ((live.data.values ?? []) as string[][])
          .map((r) => String(r?.[0] ?? "").trim().toLowerCase())
          .filter(Boolean)
      );
      const fresh = toAppend.filter((r) => !existing.has(r[0].trim().toLowerCase()));
      toAppend.length = 0;
      toAppend.push(...fresh);
    }

    if (toAppend.length) {
      // Header lives on row 4 of the V3 tab; append adds after the table.
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET1_ID!,
        range: "'V3'!A4:H",
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: toAppend },
      });
      // v3_pricing is cron-skipped, so re-pull the tab now to keep the table
      // (and deposit_overview's price columns) in step with the sheet.
      const { syncOneSheet } = await import("@/lib/sync");
      await syncOneSheet(process.env.SHEET1_ID!, "V3", "v3_pricing");
    }

    return { status: "ok", ok, skipped, failed, appended: toAppend.length };
  } catch (err) {
    return { status: "error", error: String(err) };
  }
}
