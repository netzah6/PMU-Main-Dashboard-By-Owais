import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { appOwner, loadApp, niceName } from "@/lib/client-app";
import { monthOf, type ProfitData, type ProfitExpense } from "@/lib/client-app-profit-math";

/* Client app · Profit (owner, 11/12/2026): "I would like them to be able to
   update… how much each client is worth to them, together with the touch-up.
   They will be able to count their total profits on the monthly revenue.
   Maybe… add expenses, monthly expenses, or one-time expenses."

   The CLIENTS come from us (everyone who came in through PMU Bookings On
   Demand — the same list as her billing). The MONEY is hers: her session
   price, her touch-up price, her own amount for a client, her expenses. We
   only keep what she types; none of it changes her billing or anything the
   team sees. A client link may write these numbers — they are her own notes
   and touch nobody else. */

const MONEY_MAX = 100_000;
const MAX_EXPENSES = 200;
const MAX_AMOUNTS = 3000;
const MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/;
const REF_RE = /^[a-f0-9]{16}$/;

const money = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= MONEY_MAX ? Math.round(n * 100) / 100 : null;
};

export const loadProfit = cache(async (token: string): Promise<ProfitData | null> => {
  const app = await loadApp(token);
  const ownerKey = await appOwner(token);
  if (!app || !ownerKey) return null;
  const svc = createServiceClient();
  const [{ data: s }, { data: am }, { data: ex }] = await Promise.all([
    svc.from("client_app_profit_settings").select("session_price, touchup_price").eq("owner_key", ownerKey).maybeSingle(),
    svc.from("client_app_profit_amounts").select("client_ref, amount").eq("owner_key", ownerKey).limit(MAX_AMOUNTS),
    svc.from("client_app_expenses").select("id, label, amount, kind, month, end_month").eq("owner_key", ownerKey).order("created_at", { ascending: true }).limit(MAX_EXPENSES),
  ]);
  const set = s as { session_price?: number | null; touchup_price?: number | null } | null;
  const amounts: Record<string, number> = {};
  for (const r of (am ?? []) as Array<{ client_ref: string; amount: number }>) amounts[r.client_ref] = Number(r.amount) || 0;
  return {
    session: set?.session_price != null ? Number(set.session_price) : null,
    touchup: set?.touchup_price != null ? Number(set.touchup_price) : null,
    clients: app.view.served
      .map((c) => ({ ref: c.ref, name: niceName(c.name), date: c.date, month: monthOf(c.date) }))
      .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? ""))),
    amounts,
    expenses: ((ex ?? []) as Array<{ id: string; label: string; amount: number; kind: string; month: string; end_month: string | null }>)
      .map((e): ProfitExpense => ({ id: e.id, label: e.label, amount: Number(e.amount) || 0, kind: e.kind === "once" ? "once" : "monthly", month: e.month, endMonth: e.end_month })),
    thisMonth: monthOf(new Date().toISOString()) ?? new Date().toISOString().slice(0, 7),
  };
});

export type ProfitAction =
  | { action: "prices"; session: unknown; touchup: unknown }
  | { action: "amount"; ref: unknown; amount: unknown }           // amount empty = back to the usual worth
  | { action: "expense_add"; label: unknown; amount: unknown; kind: unknown; month: unknown }
  | { action: "expense_stop"; id: unknown; month: unknown };      // one-time: remove; monthly: stop from this month

type Result = { ok: true } | { ok: false; error: string; status: number };
const bad = (error: string, status = 400): Result => ({ ok: false, error, status });

export async function saveProfit(token: string, a: ProfitAction): Promise<Result> {
  const ownerKey = await appOwner(token);
  if (!ownerKey) return bad("Not available");
  const svc = createServiceClient();
  const now = new Date().toISOString();

  if (a.action === "prices") {
    const session = money(a.session);
    const touchup = String(a.touchup ?? "").trim() === "" ? 0 : money(a.touchup);
    if (session == null || touchup == null) return bad("Type the price as a number, like 450");
    const { error } = await svc.from("client_app_profit_settings")
      .upsert({ owner_key: ownerKey, session_price: session, touchup_price: touchup, updated_at: now }, { onConflict: "owner_key" });
    return error ? bad("Couldn't save — please try again", 500) : { ok: true };
  }

  if (a.action === "amount") {
    const ref = String(a.ref ?? "");
    if (!REF_RE.test(ref)) return bad("Not available");
    if (String(a.amount ?? "").trim() === "") {
      const { error } = await svc.from("client_app_profit_amounts").delete().eq("owner_key", ownerKey).eq("client_ref", ref);
      return error ? bad("Couldn't save — please try again", 500) : { ok: true };
    }
    const amount = money(a.amount);
    if (amount == null) return bad("Type the amount as a number, like 450");
    const { count } = await svc.from("client_app_profit_amounts").select("client_ref", { count: "exact", head: true }).eq("owner_key", ownerKey);
    if ((count ?? 0) >= MAX_AMOUNTS) return bad("That's the most we can keep — please tell your coach");
    const { error } = await svc.from("client_app_profit_amounts")
      .upsert({ owner_key: ownerKey, client_ref: ref, amount, updated_at: now }, { onConflict: "owner_key,client_ref" });
    return error ? bad("Couldn't save — please try again", 500) : { ok: true };
  }

  if (a.action === "expense_add") {
    const label = String(a.label ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    const amount = money(a.amount);
    const kind = a.kind === "once" ? "once" : "monthly";
    const month = String(a.month ?? "");
    if (!label) return bad("Give the expense a name, like Rent");
    if (amount == null || amount <= 0) return bad("Type the amount as a number, like 120");
    if (!MONTH_RE.test(month)) return bad("Not available");
    const { count } = await svc.from("client_app_expenses").select("id", { count: "exact", head: true }).eq("owner_key", ownerKey);
    if ((count ?? 0) >= MAX_EXPENSES) return bad("That's a lot of expenses — remove one first");
    const { error } = await svc.from("client_app_expenses").insert({ owner_key: ownerKey, label, amount, kind, month });
    return error ? bad("Couldn't save — please try again", 500) : { ok: true };
  }

  if (a.action === "expense_stop") {
    const id = String(a.id ?? "");
    const month = String(a.month ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id) || !MONTH_RE.test(month)) return bad("Not available");
    const { data: row } = await svc.from("client_app_expenses").select("id, kind, month").eq("owner_key", ownerKey).eq("id", id).maybeSingle();
    const e = row as { id: string; kind: string; month: string } | null;
    if (!e) return { ok: true }; // already gone
    // A monthly expense keeps its past months: it only stops from the month she is looking at.
    const res = e.kind === "monthly" && e.month < month
      ? await svc.from("client_app_expenses").update({ end_month: month }).eq("owner_key", ownerKey).eq("id", id)
      : await svc.from("client_app_expenses").delete().eq("owner_key", ownerKey).eq("id", id);
    return res.error ? bad("Couldn't save — please try again", 500) : { ok: true };
  }
  return bad("Not available");
}
