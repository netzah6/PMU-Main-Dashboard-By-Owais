import { createServiceClient } from "@/lib/supabase/server";
import { getSheetsClient } from "@/lib/sheets";

export interface OfferRefreshResult {
  status: "ok" | "error";
  ok?: number; skipped?: number; failed?: number; error?: string;
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

    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Sheet1" });
    const rows = (res.data.values ?? []) as string[][];
    if (rows.length < 2) return { status: "ok", ok: 0, skipped: 0, failed: 0 };

    const header = rows[0].map((h) => String(h ?? "").toLowerCase());
    const nameIdx = header.findIndex((h) => /^name/.test(h.trim()));
    const locIdx = header.findIndex((h) => /location/.test(h));
    const tokIdx = header.findIndex((h) => /integration|private|key|token/.test(h));

    let ok = 0, skipped = 0, failed = 0;
    for (const row of rows.slice(1)) {
      const name = String(row[nameIdx] ?? "").trim();
      const locationId = String(row[locIdx] ?? "").trim();
      const token = String(row[tokIdx] ?? "").trim();
      if (!name || !locationId || !token) { skipped++; continue; }
      const ownerKey = matchV3(nameTokens(name)); // null = not a V3 client
      if (!ownerKey) { skipped++; continue; }
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
        ok++;
      } catch {
        failed++;
      }
    }
    return { status: "ok", ok, skipped, failed };
  } catch (err) {
    return { status: "error", error: String(err) };
  }
}
