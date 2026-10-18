import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { applyEdits, autoconfirmEnabled, buildMonth, EDIT_FIELDS, listMonthTabs, type EditField, type MonthPayload, type PaymentEdit } from "@/lib/payment-check";
import { normalizeOwnerKey } from "@/lib/normalizers";

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
      const cached = data?.payload as MonthPayload | undefined;
      // Copies saved before edits existed lack the facts edits need — rebuild those.
      const usable = !!cached && (!cached.rows.length || !!cached.rows[0].facts);
      if (usable && (!isCurrent || age < FRESH_MS)) payload = cached!;
    }
    if (!payload) {
      payload = await buildMonth(svc, mt);
      await svc.from("payment_check_cache").upsert({ month: mt.month, payload, built_at: payload.builtAt });
    }

    // Dashboard edits sit on top of the sheet values (the sheet is never written).
    const { data: editRows } = await svc.from("payment_edits").select("owner_key, client_name, fields, added, hidden").eq("month", mt.month);
    const applied = applyEdits(mt.month, payload.rows, (editRows ?? []) as PaymentEdit[]);
    // Dropdown choices: the statuses the sheet already uses, plus the usual ones.
    const opts = (base: string[], pick: (r: MonthPayload["rows"][number]) => string) =>
      [...new Set([...base, ...[...payload!.rows, ...applied.rows].map(pick).map((v) => v.trim()).filter(Boolean)])];
    const options = {
      sheetStatus: opts(["Paid", "Paid Upfront", "PPS", "Pending", "Grace", "Paused", "Need More Bookings"], (r) => r.sheet?.sheetStatus ?? r.sheetStatus),
      billing: opts(["Card On File", "No Card On File", "Sub Dashboard", "Subscription Active", "Manually Send Link", "Deposit", "Ask for permission"], (r) => r.sheet?.billing ?? r.billing),
    };

    const [{ data: decisions }, autoconfirm] = await Promise.all([
      svc.from("payment_checks").select("owner_key, decision, suggested, note, decided_by, decided_at").eq("month", mt.month),
      autoconfirmEnabled(svc),
    ]);
    // How often the owner agreed with the suggestion, across every month —
    // the number to look at before letting clean matches confirm themselves.
    const { data: all } = await svc.from("payment_checks").select("decision, suggested").not("suggested", "is", null);
    const scored = (all ?? []) as Array<{ decision: string; suggested: string }>;
    const agreement = { agreed: scored.filter((d) => d.decision === d.suggested).length, total: scored.length };

    // Coach share (owner 2026-10-18, admin review only — nothing is paid out):
    // each client's coach comes from the Clients Master "Assigned" column.
    const [{ data: master }, { data: shareRow }] = await Promise.all([
      svc.from("clients_master").select("data"),
      svc.from("app_settings").select("value").eq("key", "coach_share_percents").maybeSingle(),
    ]);
    const coaches: Record<string, string> = {};
    for (const m of (master ?? []) as Array<{ data: Record<string, unknown> }>) {
      const key = normalizeOwnerKey(m.data?.["Owner Full Name"]);
      const coach = String(m.data?.["Assigned"] ?? "").trim();
      if (key && coach && !coaches[key]) coaches[key] = coach;
    }
    const shares = ((shareRow?.value as Record<string, number> | null) ?? {});

    return NextResponse.json({ months, ...payload, rows: applied.rows, removed: applied.removed, options, decisions: decisions ?? [], autoconfirm, agreement, coaches, shares });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

type Body =
  | { action: "decide"; month: string; items: Array<{ ownerKey: string; clientName?: string; decision: "paid" | "not_paid" | null; suggested?: string | null; note?: string | null }> }
  | { action: "autoconfirm"; enabled: boolean }
  | { action: "share"; coach: string; percent: number | null }
  | { action: "edit"; month: string; ownerKey: string; clientName?: string; field: EditField; value: string | number | null }
  | { action: "add"; month: string; name: string }
  | { action: "remove" | "restore"; month: string; ownerKey: string; clientName?: string };

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

  // Only records the percent used for the admin's review — no money moves.
  if (body.action === "share") {
    const coach = String(body.coach ?? "").trim();
    const pct = body.percent == null ? null : Number(body.percent);
    if (!coach || (pct != null && (!isFinite(pct) || pct < 0 || pct > 100)))
      return NextResponse.json({ error: "Enter a percent between 0 and 100" }, { status: 400 });
    const { data: cur } = await svc.from("app_settings").select("value").eq("key", "coach_share_percents").maybeSingle();
    const next = { ...((cur?.value as Record<string, number> | null) ?? {}) };
    if (pct == null) delete next[coach]; else next[coach] = pct;
    const { error } = await svc.from("app_settings").upsert({
      key: "coach_share_percents", value: next, updated_by: auth.email ?? auth.userId, updated_at: new Date().toISOString(),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, shares: next });
  }

  // Edits, added and removed clients — stored on the dashboard only.
  if (body.action === "edit" || body.action === "add" || body.action === "remove" || body.action === "restore") {
    if (!/^\d{4}-\d{2}$/.test(body.month)) return NextResponse.json({ error: "Pick a month" }, { status: 400 });
    const name = body.action === "add" ? String(body.name ?? "").trim() : String(body.clientName ?? "").trim();
    const ownerKey = body.action === "add" ? normalizeOwnerKey(name) : String(body.ownerKey ?? "");
    if (!ownerKey) return NextResponse.json({ error: body.action === "add" ? "Type the client's name" : "Missing client" }, { status: 400 });
    const { data: cur } = await svc.from("payment_edits").select("fields, added, hidden, client_name").eq("month", body.month).eq("owner_key", ownerKey).maybeSingle();
    const row = {
      month: body.month, owner_key: ownerKey, client_name: name || (cur?.client_name as string | null) || null,
      fields: { ...((cur?.fields as Record<string, unknown>) ?? {}) },
      added: !!cur?.added, hidden: !!cur?.hidden,
      updated_by: auth.email ?? auth.userId, updated_at: new Date().toISOString(),
    };
    if (body.action === "edit") {
      if (!(EDIT_FIELDS as readonly string[]).includes(body.field)) return NextResponse.json({ error: "That column can't be edited" }, { status: 400 });
      // null = go back to the sheet's value.
      if (body.value === null) delete row.fields[body.field];
      else if (body.field === "usd") {
        const raw = String(body.value).replace(/[$,\s]/g, "");
        const n = raw === "" ? "" : Number(raw);
        if (n !== "" && (!isFinite(n) || n < 0)) return NextResponse.json({ error: "Enter an amount like 697" }, { status: 400 });
        row.fields.usd = n;
      } else row.fields[body.field] = String(body.value).slice(0, 500);
    }
    if (body.action === "add") { row.added = true; row.hidden = false; }
    if (body.action === "remove") row.hidden = true;
    if (body.action === "restore") row.hidden = false;
    // Nothing left to remember → drop the row so the sheet value shows again.
    if (!row.added && !row.hidden && !Object.keys(row.fields).length) {
      const { error } = await svc.from("payment_edits").delete().eq("month", body.month).eq("owner_key", ownerKey);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      const { error } = await svc.from("payment_edits").upsert(row);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, ownerKey });
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
