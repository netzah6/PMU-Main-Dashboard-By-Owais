import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { autoconfirmEnabled, buildMonth, listMonthTabs, type MonthPayload } from "@/lib/payment-check";

export const maxDuration = 300;

// Payment Check: one month of the Financing sheet vs. what Square and the
// dashboard actually charged. Admin only. Reads the sheet, never writes it.

async function admin() {
  const auth = await getAuth();
  if (!auth || auth.role !== "admin") return null;
  return auth;
}

// The current month is re-matched when its copy is older than this; past
// months keep their copy until someone presses Refresh.
const FRESH_MS = 15 * 60 * 1000;

export async function GET(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const svc = createServiceClient();
  try {
    const months = await listMonthTabs();
    if (!months.length) return NextResponse.json({ error: "No month tabs found in the Financing sheet" }, { status: 404 });
    const want = req.nextUrl.searchParams.get("month");
    const mt = months.find((m) => m.month === want) ?? months[0];
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";
    const isCurrent = mt.month === months[0].month;

    let payload: MonthPayload | null = null;
    if (!refresh) {
      const { data } = await svc.from("payment_check_cache").select("payload, built_at").eq("month", mt.month).maybeSingle();
      const age = data ? Date.now() - new Date(data.built_at as string).getTime() : Infinity;
      if (data && (!isCurrent || age < FRESH_MS)) payload = data.payload as MonthPayload;
    }
    if (!payload) {
      payload = await buildMonth(svc, mt);
      await svc.from("payment_check_cache").upsert({ month: mt.month, payload, built_at: payload.builtAt });
    }

    const [{ data: decisions }, autoconfirm] = await Promise.all([
      svc.from("payment_checks").select("owner_key, decision, suggested, note, decided_by, decided_at").eq("month", mt.month),
      autoconfirmEnabled(svc),
    ]);
    // How often the owner agreed with the suggestion, across every month —
    // the number to look at before letting clean matches confirm themselves.
    const { data: all } = await svc.from("payment_checks").select("decision, suggested").not("suggested", "is", null);
    const scored = (all ?? []) as Array<{ decision: string; suggested: string }>;
    const agreement = { agreed: scored.filter((d) => d.decision === d.suggested).length, total: scored.length };

    return NextResponse.json({ months, ...payload, decisions: decisions ?? [], autoconfirm, agreement });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

type Body =
  | { action: "decide"; month: string; items: Array<{ ownerKey: string; clientName?: string; decision: "paid" | "not_paid" | null; suggested?: string | null; note?: string | null }> }
  | { action: "autoconfirm"; enabled: boolean };

export async function POST(req: NextRequest) {
  const auth = await admin();
  if (!auth) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const svc = createServiceClient();
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  if (body.action === "autoconfirm") {
    const { error } = await svc.from("app_settings").upsert({
      key: "payment_check_autoconfirm", value: { enabled: !!body.enabled },
      updated_by: auth.email ?? auth.userId, updated_at: new Date().toISOString(),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, autoconfirm: !!body.enabled });
  }

  if (body.action === "decide") {
    if (!/^\d{4}-\d{2}$/.test(body.month) || !Array.isArray(body.items) || !body.items.length)
      return NextResponse.json({ error: "Pick a month and at least one client" }, { status: 400 });
    const clear = body.items.filter((i) => i.decision == null).map((i) => i.ownerKey);
    const set = body.items.filter((i) => i.decision === "paid" || i.decision === "not_paid");
    if (clear.length) {
      const { error } = await svc.from("payment_checks").delete().eq("month", body.month).in("owner_key", clear);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (set.length) {
      const now = new Date().toISOString();
      const { error } = await svc.from("payment_checks").upsert(set.map((i) => ({
        month: body.month, owner_key: i.ownerKey, client_name: i.clientName ?? null, decision: i.decision,
        suggested: i.suggested ?? null, note: i.note ?? null, decided_by: auth.email ?? auth.userId, decided_at: now,
      })));
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
