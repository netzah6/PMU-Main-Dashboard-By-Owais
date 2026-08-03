import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import {
  searchLocations, inspectLocation, cleanLocation, renameToPool, isProtectedLocation, syncPool, setPoolA2p,
  refreshPoolCleanliness,
} from "@/lib/ghl-cleanup";
import { readSheetValues, writeRowToSheet, rowsToObjects } from "@/lib/sheets";

export const maxDuration = 300;

// Sub-account cleanup tab (admin only):
//   GET  ?q=name        → location candidates
//   GET  ?locationId=X  → inspect counts + matched Clients Master row
//   GET  ?history=1     → past cleanups
//   POST {action:"clean", locationId, confirmName}    → wipe via API
//   POST {action:"finalize", locationId}              → rename into pool +
//        flip the client's Clients Master status "Paused" → "Offboarded"

const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

type SheetClient = {
  business: string;
  owner: string;
  status: string;
  rowNumber: number;
};

// Match a location to its Clients Master row by business name (exact
// normalized match) — owner name as fallback.
async function matchClient(locationName: string): Promise<SheetClient | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("clients_master").select("data");
  const rows = (data ?? []) as Array<{ data: Record<string, unknown> }>;
  const target = norm(locationName);
  if (!target) return null;
  const pick = (r: Record<string, unknown>): SheetClient => ({
    business: String(r["Business Name"] ?? ""),
    owner: String(r["Owner Full Name"] ?? ""),
    status: String(r["col_1"] ?? ""),
    rowNumber: Number(r["row_number"] ?? 0),
  });
  const byBiz = rows.find((r) => norm(String(r.data["Business Name"] ?? "")) === target);
  if (byBiz) return pick(byBiz.data);
  const byOwner = rows.find((r) => norm(String(r.data["Owner Full Name"] ?? "")) === target);
  if (byOwner) return pick(byOwner.data);
  return null;
}

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  try {
    if (sp.get("pool")) {
      return NextResponse.json(await syncPool());
    }
    if (sp.get("history")) {
      const svc = createServiceClient();
      const { data } = await svc.from("cleanup_log").select("*").order("cleaned_at", { ascending: false }).limit(50);
      return NextResponse.json({ history: data ?? [] });
    }
    const locationId = sp.get("locationId");
    if (locationId) {
      const inspect = await inspectLocation(locationId);
      const client = await matchClient(inspect.name);
      const svc = createServiceClient();
      const { data: logRow } = await svc.from("cleanup_log").select("*").eq("location_id", locationId).maybeSingle();
      return NextResponse.json({ inspect, client, log: logRow ?? null });
    }
    const q = sp.get("q") ?? "";
    return NextResponse.json({ candidates: await searchLocations(q) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; locationId?: string; locationIds?: string[]; confirmName?: string; a2p?: string };

  // A2P marking — accepts one id or a batch, and never touches GHL itself.
  if (body.action === "a2p") {
    const ids = body.locationIds?.length ? body.locationIds : body.locationId ? [body.locationId] : [];
    if (!ids.length) return NextResponse.json({ error: "locationId(s) required" }, { status: 400 });
    for (const id of ids) await setPoolA2p(id, String(body.a2p ?? "pending"), auth.email);
    return NextResponse.json({ updated: ids.length, a2p: body.a2p });
  }

  // Re-check what's actually left in pool accounts. The tab sends them in
  // small batches and shows progress — one inspect is ~10 GHL calls, so the
  // whole pool in a single request would run past the serverless limit.
  if (body.action === "refreshPool") {
    const ids = body.locationIds ?? [];
    if (!ids.length) return NextResponse.json({ error: "locationIds required" }, { status: 400 });
    if (ids.length > 12) return NextResponse.json({ error: "send at most 12 accounts per batch" }, { status: 400 });
    return NextResponse.json({ rows: await refreshPoolCleanliness(ids) });
  }

  const locationId = String(body.locationId ?? "");
  if (!locationId) return NextResponse.json({ error: "locationId required" }, { status: 400 });
  if (isProtectedLocation(locationId)) return NextResponse.json({ error: "This location is protected and can never be cleaned." }, { status: 400 });

  const svc = createServiceClient();

  try {
    if (body.action === "clean") {
      const inspect = await inspectLocation(locationId);
      // Type-the-name confirmation — the wipe is irreversible.
      if (norm(String(body.confirmName ?? "")) !== norm(inspect.name)) {
        return NextResponse.json({ error: `Confirmation name doesn't match "${inspect.name}"` }, { status: 400 });
      }
      if (inspect.isPool) {
        return NextResponse.json({ error: "This account is already in the clean pool." }, { status: 400 });
      }
      const client = await matchClient(inspect.name);
      if (client && client.status.trim().toLowerCase() === "live") {
        return NextResponse.json({ error: `"${client.business}" is marked LIVE in Clients Master — refusing to clean a live client's account.` }, { status: 400 });
      }
      const steps = await cleanLocation(locationId);
      await svc.from("cleanup_log").upsert({
        location_id: locationId,
        old_name: inspect.name,
        owner_key: client?.owner?.trim().toLowerCase() ?? null,
        client_business: client?.business ?? null,
        steps,
        cleaned_at: new Date().toISOString(),
        cleaned_by: auth.email,
      });
      return NextResponse.json({ steps, workflowsLeft: inspect.counts.workflows });
    }

    if (body.action === "finalize") {
      // Only rename an account that has been cleaned (or is verifiably empty).
      const inspect = await inspectLocation(locationId);
      // -1 = funnels unreadable (missing scope); unknown can't block pooling,
      // it just stays called out as a manual step in the tab.
      const funnelsBlocking = inspect.counts.funnels > 0 ? inspect.counts.funnels : 0;
      // Automations block pooling too. Nothing here can delete them — GHL
      // publishes no write endpoint (workflows.readonly is the entire API) and
      // their screen is a cross-origin iframe that ignores synthetic input — so
      // they're cleared by hand. Blocking here is what keeps "in the pool"
      // meaning genuinely clean rather than mostly clean.
      const dirty = inspect.counts.contacts + inspect.counts.customFields + inspect.counts.customValues + inspect.counts.calendars + inspect.counts.pipelines + inspect.counts.workflows + funnelsBlocking;
      if (dirty > 0) {
        const parts: Array<[number, string]> = [
          [inspect.counts.contacts, "contacts"], [inspect.counts.customFields, "custom fields"],
          [inspect.counts.customValues, "custom values"], [inspect.counts.calendars, "calendars"],
          [inspect.counts.pipelines, "pipelines"], [funnelsBlocking, "funnels"],
          [inspect.counts.workflows, "automations"],
        ];
        const listed = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(", ");
        const hint = inspect.counts.workflows > 0
          ? ` Automations are deleted by hand in GHL: Automation → Workflows → select all folders → Delete → type "Delete", then select all remaining workflows → Delete again.`
          : "";
        return NextResponse.json({ error: `Account still has ${listed} — clean it first.${hint}` }, { status: 400 });
      }
      const client = await matchClient(inspect.name);
      const { oldName, poolName } = await renameToPool(locationId);

      // Sheet status: Paused → Offboarded, written ONLY to the status cell and
      // only when the live sheet still says "Paused" (verified right now, not
      // from the sync cache).
      let sheetChange = "no matching Clients Master row";
      if (client?.rowNumber) {
        const rows = await readSheetValues(process.env.SHEET1_ID!, "Clients Master", 0);
        const objs = rowsToObjects(rows);
        const live = objs.find((o) => Number(o.row_number) === client.rowNumber);
        const current = String(live?.["col_1"] ?? "").trim();
        if (current.toLowerCase() === "paused") {
          await writeRowToSheet(process.env.SHEET1_ID!, "Clients Master", client.rowNumber, { col_1: "Offboarded" }, 0, ["col_1"]);
          sheetChange = `"${client.business}" row ${client.rowNumber}: Paused → Offboarded`;
        } else if (current.toLowerCase() === "offboarded") {
          sheetChange = `already Offboarded`;
        } else {
          sheetChange = `NOT changed — sheet says "${current || "(empty)"}", expected "Paused"`;
        }
      }

      await svc.from("cleanup_log").upsert({
        location_id: locationId,
        old_name: oldName,
        pool_name: poolName,
        owner_key: client?.owner?.trim().toLowerCase() ?? null,
        client_business: client?.business ?? null,
        sheet_status_change: sheetChange,
        cleaned_by: auth.email,
      }, { onConflict: "location_id" }); // steps column not in payload → prior clean results are kept

      await syncPool().catch(() => {}); // record the new pool account right away
      return NextResponse.json({ oldName, poolName, sheetChange });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
