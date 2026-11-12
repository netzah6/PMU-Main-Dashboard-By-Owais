import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { appOwner, loadApp, niceName } from "@/lib/client-app";
import { monthOf, type ClientPay, type ExpenseKind, type ProfitData, type ProfitExpense } from "@/lib/client-app-profit-math";

/* Client app · Profit (owner, 11/12/2026). In his words: she first sees her
   own clients "and then update the price for each one of them. After they
   click Submit… open the next step, which is adding the rent or per-client
   rent… monthly equipment… It is important that only after they add the
   value… for all the previous clients… that are like session done."

   So it is three steps, kept on her row: (1) what every client paid her —
   the first treatment and the touch-up, at least one of the two on EVERY
   client — (2) her costs — (3) the profit, month by month.

   The CLIENTS come from us (everyone who came in through PMU Bookings On
   Demand — the same list as her billing). The MONEY is hers. We only keep
   what she types; none of it changes her billing or anything the team sees.
   A client link may write these numbers — they are her own notes. */

const MONEY_MAX = 100_000;
const MAX_EXPENSES = 200;
const MAX_AMOUNTS = 3000;
const MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/;
const REF_RE = /^[a-f0-9]{16}$/;
const KINDS: ExpenseKind[] = ["monthly", "per_client", "once"];

const money = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return String(v ?? "").trim() !== "" && Number.isFinite(n) && n >= 0 && n <= MONEY_MAX ? Math.round(n * 100) / 100 : null;
};

export const loadProfit = cache(async (token: string): Promise<ProfitData | null> => {
  const app = await loadApp(token);
  const ownerKey = await appOwner(token);
  if (!app || !ownerKey) return null;
  const svc = createServiceClient();
  const [{ data: s }, { data: am }, { data: ex }] = await Promise.all([
    svc.from("client_app_profit_settings").select("session_price, touchup_price, clients_done_at, setup_done_at").eq("owner_key", ownerKey).maybeSingle(),
    svc.from("client_app_profit_amounts").select("client_ref, amount, touchup_amount").eq("owner_key", ownerKey).limit(MAX_AMOUNTS),
    svc.from("client_app_expenses").select("id, label, amount, kind, month, end_month").eq("owner_key", ownerKey).order("created_at", { ascending: true }).limit(MAX_EXPENSES),
  ]);
  const set = s as { session_price?: number | null; touchup_price?: number | null; clients_done_at?: string | null; setup_done_at?: string | null } | null;
  const amounts: Record<string, ClientPay> = {};
  for (const r of (am ?? []) as Array<{ client_ref: string; amount: number | null; touchup_amount: number | null }>) {
    amounts[r.client_ref] = { first: r.amount != null ? Number(r.amount) : null, touchup: r.touchup_amount != null ? Number(r.touchup_amount) : null };
  }
  const thisMonth = monthOf(new Date().toISOString()) ?? new Date().toISOString().slice(0, 7);
  const clients = app.view.served
    .map((c) => ({ ref: c.ref, name: niceName(c.name), date: c.date, month: monthOf(c.date) }))
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  const months = clients.map((c) => c.month).filter((m): m is string => !!m).sort();
  return {
    session: set?.session_price != null ? Number(set.session_price) : null,
    touchup: set?.touchup_price != null ? Number(set.touchup_price) : null,
    clients,
    amounts,
    expenses: ((ex ?? []) as Array<{ id: string; label: string; amount: number; kind: string; month: string; end_month: string | null }>)
      .map((e): ProfitExpense => ({ id: e.id, label: e.label, amount: Number(e.amount) || 0, kind: KINDS.find((k) => k === e.kind) ?? "monthly", month: e.month, endMonth: e.end_month })),
    thisMonth,
    firstMonth: months[0] && months[0] < thisMonth ? months[0] : thisMonth,
    step: !set?.clients_done_at ? 1 : !set?.setup_done_at ? 2 : 3,
  };
});

export type ProfitAction =
  // Step 1 · Submit: what every client paid her (+ her usual prices, to fill new ones faster).
  | { action: "clients_submit"; amounts: unknown; session?: unknown; touchup?: unknown }
  // Step 2 · done: open the profit.
  | { action: "setup_done" }
  | { action: "amount"; ref: unknown; first: unknown; touchup: unknown }
  | { action: "expense_add"; label: unknown; amount: unknown; kind: unknown; month: unknown }
  | { action: "expense_stop"; id: unknown; month: unknown };      // one-time: remove; repeating: stop from this month

type Result = { ok: true } | { ok: false; error: string; status: number };
const bad = (error: string, status = 400): Result => ({ ok: false, error, status });
const FAILED = "Couldn't save — please try again";

export async function saveProfit(token: string, a: ProfitAction): Promise<Result> {
  const ownerKey = await appOwner(token);
  if (!ownerKey) return bad("Not available");
  const svc = createServiceClient();
  const now = new Date().toISOString();

  if (a.action === "clients_submit") {
    const data = await loadProfit(token);
    if (!data) return bad("Not available");
    const given = (a.amounts && typeof a.amounts === "object" ? a.amounts : {}) as Record<string, { first?: unknown; touchup?: unknown } | undefined>;
    // Every client needs at least one value — that is the whole point of this step.
    const rows: Array<{ owner_key: string; client_ref: string; amount: number | null; touchup_amount: number | null; updated_at: string }> = [];
    for (const c of data.clients) {
      const first = money(given[c.ref]?.first), touchup = money(given[c.ref]?.touchup);
      if (first == null && touchup == null) return bad(`Add an amount for ${c.name} first`);
      rows.push({ owner_key: ownerKey, client_ref: c.ref, amount: first, touchup_amount: touchup, updated_at: now });
    }
    if (rows.length) {
      const { error } = await svc.from("client_app_profit_amounts").upsert(rows, { onConflict: "owner_key,client_ref" });
      if (error) return bad(FAILED, 500);
    }
    const session = money(a.session), touchup = money(a.touchup);
    const { error } = await svc.from("client_app_profit_settings").upsert({
      owner_key: ownerKey, clients_done_at: now, updated_at: now,
      ...(session != null ? { session_price: session, touchup_price: touchup ?? 0 } : {}),
    }, { onConflict: "owner_key" });
    return error ? bad(FAILED, 500) : { ok: true };
  }

  if (a.action === "setup_done") {
    const { data: cur } = await svc.from("client_app_profit_settings").select("clients_done_at").eq("owner_key", ownerKey).maybeSingle();
    if (!(cur as { clients_done_at?: string | null } | null)?.clients_done_at) return bad("Add what your clients paid first");
    const { error } = await svc.from("client_app_profit_settings").update({ setup_done_at: now, updated_at: now }).eq("owner_key", ownerKey);
    return error ? bad(FAILED, 500) : { ok: true };
  }

  if (a.action === "amount") {
    const ref = String(a.ref ?? "");
    if (!REF_RE.test(ref)) return bad("Not available");
    const first = money(a.first), touchup = money(a.touchup);
    if (first == null && touchup == null) return bad("Type the amount as a number, like 450");
    const { count } = await svc.from("client_app_profit_amounts").select("client_ref", { count: "exact", head: true }).eq("owner_key", ownerKey);
    if ((count ?? 0) >= MAX_AMOUNTS) return bad("That's the most we can keep — please tell your coach");
    const { error } = await svc.from("client_app_profit_amounts")
      .upsert({ owner_key: ownerKey, client_ref: ref, amount: first, touchup_amount: touchup, updated_at: now }, { onConflict: "owner_key,client_ref" });
    return error ? bad(FAILED, 500) : { ok: true };
  }

  if (a.action === "expense_add") {
    const label = String(a.label ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    const amount = money(a.amount);
    const kind = KINDS.find((k) => k === a.kind) ?? "monthly";
    const month = String(a.month ?? "");
    if (!label) return bad("Give the cost a name, like Rent");
    if (amount == null || amount <= 0) return bad("Type the amount as a number, like 120");
    if (!MONTH_RE.test(month)) return bad("Not available");
    const { count } = await svc.from("client_app_expenses").select("id", { count: "exact", head: true }).eq("owner_key", ownerKey);
    if ((count ?? 0) >= MAX_EXPENSES) return bad("That's a lot of costs — remove one first");
    const { error } = await svc.from("client_app_expenses").insert({ owner_key: ownerKey, label, amount, kind, month });
    return error ? bad(FAILED, 500) : { ok: true };
  }

  if (a.action === "expense_stop") {
    const id = String(a.id ?? "");
    const month = String(a.month ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id) || !MONTH_RE.test(month)) return bad("Not available");
    const { data: row } = await svc.from("client_app_expenses").select("id, kind, month").eq("owner_key", ownerKey).eq("id", id).maybeSingle();
    const e = row as { id: string; kind: string; month: string } | null;
    if (!e) return { ok: true }; // already gone
    // A repeating cost keeps its past months: it only stops from the month she is looking at.
    const res = e.kind !== "once" && e.month < month
      ? await svc.from("client_app_expenses").update({ end_month: month }).eq("owner_key", ownerKey).eq("id", id)
      : await svc.from("client_app_expenses").delete().eq("owner_key", ownerKey).eq("id", id);
    return res.error ? bad(FAILED, 500) : { ok: true };
  }
  return bad("Not available");
}
