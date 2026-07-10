import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAppAgencyToken } from "@/lib/ghl-app";
import { discoverPool, POOL_NAME_RE } from "@/lib/ghl-claim";

export const maxDuration = 300;

// Pool pre-provisioning: create N new "Clean New Account #" sub-accounts,
// loaded from a named snapshot. Creation only — never touches existing
// locations. GET lists available snapshots (to find the exact name).

const GHL = "https://services.leadconnectorhq.com";
const V = "2021-07-28";

function agencyHeaders(): Record<string, string> {
  const token = process.env.GHL_AGENCY_TOKEN;
  if (!token) throw new Error("GHL_AGENCY_TOKEN not set");
  return { Authorization: `Bearer ${token}`, Version: V, Accept: "application/json" };
}

async function authed(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get("authorization");
  if (!!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`) return true;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return !!user;
}

async function listSnapshots(): Promise<Array<{ id: string; name: string }>> {
  const agency = await getAppAgencyToken();
  if (!agency?.companyId) throw new Error("marketplace app not connected (no companyId)");
  const r = await fetch(`${GHL}/snapshots/?companyId=${encodeURIComponent(agency.companyId)}`, { headers: agencyHeaders() });
  const text = await r.text();
  if (!r.ok) throw new Error(`snapshots HTTP ${r.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text) as { snapshots?: Array<{ id?: string; _id?: string; name?: string }> };
  return (j.snapshots ?? []).map((s) => ({ id: String(s.id ?? s._id ?? ""), name: String(s.name ?? "") }));
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ snapshots: await listSnapshots() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { count?: number; snapshotName?: string };
  const count = Math.min(Math.max(Number(body.count ?? 0), 1), 30);
  const snapshotName = String(body.snapshotName ?? "").trim();
  if (!count || !snapshotName) return NextResponse.json({ error: "count and snapshotName are required" }, { status: 400 });

  try {
    const agency = await getAppAgencyToken();
    if (!agency?.companyId) throw new Error("marketplace app not connected (no companyId)");

    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const snapshots = await listSnapshots();
    const snapshot = snapshots.find((s) => norm(s.name) === norm(snapshotName)) ??
      snapshots.find((s) => norm(s.name).includes(norm(snapshotName)));
    if (!snapshot) {
      return NextResponse.json({ error: `snapshot "${snapshotName}" not found`, snapshots: snapshots.map((s) => s.name) }, { status: 404 });
    }

    // Number the new accounts after the highest existing pool number.
    const pool = await discoverPool();
    const maxN = pool.reduce((mx, p) => {
      const m = p.name.match(/(\d+)\s*$/);
      return m ? Math.max(mx, Number(m[1])) : mx;
    }, 3);

    const created: Array<{ name: string; id?: string; ok: boolean; error?: string }> = [];
    for (let i = 1; i <= count; i++) {
      const name = `Clean New Account ${maxN + i}`;
      if (!POOL_NAME_RE.test(name)) { created.push({ name, ok: false, error: "name failed pool pattern" }); continue; }
      try {
        const r = await fetch(`${GHL}/locations/`, {
          method: "POST",
          headers: { ...agencyHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: agency.companyId,
            name,
            snapshotId: snapshot.id,
            // Placeholder location details (overwritten on claim). GHL's
            // create-location endpoint requires the address block + timezone.
            address: "1603 Capitol Ave",
            city: "Cheyenne",
            state: "WY",
            country: "US",
            postalCode: "82001",
            timezone: "America/Denver",
          }),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
        const j = JSON.parse(text) as { id?: string; _id?: string };
        created.push({ name, id: String(j.id ?? j._id ?? ""), ok: true });
      } catch (e) {
        created.push({ name, ok: false, error: e instanceof Error ? e.message : "failed" });
      }
    }
    return NextResponse.json({ snapshot: snapshot.name, created });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
