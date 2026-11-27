import { createServiceClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/onebox-insights";

/* LTV → deposits (owner, 11/25/2026): next to each client's lifetime value,
   the lead deposits we took for that client, minus refunds ("$10,000 + $500").

   Matching (same rules as the Client Health view):
     LTV name ── same name (any word order) ──► Clients Master owner → business
     LTV name ── its payment emails ─────────► Clients Master email → business
     business ── normalized name ────────────► deposits / refunded deposits
   Deposits are de-duplicated like client_health_base (same business + same
   person + same day = one), VOID rows skipped. One business's deposits go to
   ONE LTV row only (the highest LTV), so a client listed twice in the sheet
   (same person, names in a different order) or two partners don't double them. */

type Row = { data: Record<string, unknown> };
export type LtvDeposit = { deposits: number; refunds: number; count: number; businesses: string[] };

const nk = (t: unknown) => String(t ?? "").replace(/\(.*?\)/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sortedKey = (t: unknown) => nk(t).split(" ").filter(Boolean).sort().join(" ");
const biz = (t: unknown) => String(t ?? "").replace(/\s*-\s*ad\s*account.*$/i, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const money = (v: unknown) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, "")); return isNaN(n) ? 0 : n; };
const s = (v: unknown) => String(v ?? "").trim();
// "dd/mm/yyyy" or "yyyy-mm-dd" → month number (year*12 + month), like health_date_dmy.
const monthNo = (v: unknown): number | null => {
  const t = s(v);
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return +m[3] * 12 + (+m[2] - 1);
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? +m[1] * 12 + (+m[2] - 1) : null;
};
const span = (a: number[]) => (a.length ? Math.max(...a) - Math.min(...a) + 1 : 0);

export async function getLtvDeposits(): Promise<Record<string, LtvDeposit>> {
  return (await getLtvData()).byName;
}

/* "On average, how much is each client worth to me" (owner, 11/27/2026):
   lifetime service fees + lead deposits kept (minus refunds), per client in
   the LTV sheet. Same client count as the LTV tab's "Average LTV". */
/* Per month (owner, 11/27/2026: "how much they're worth to me on monthly
   average"): all the money ÷ all the months clients stayed. A client's months
   = first to last month we got money from them (a fee or a lead deposit),
   both ends counted. A client who paid several months upfront in one payment
   counts as fewer months, so this leans a little high for them. */
export type LtvWorth = { clients: number; fees: number; deposits: number; refunds: number; withDeposits: number; months: number; noDates: number };
export async function getLtvWorth(): Promise<LtvWorth> {
  const { byName, rows } = await getLtvData();
  const paid = rows.filter((r) => r.ltv > 0);
  const v = Object.values(byName);
  return {
    clients: paid.length,
    fees: paid.reduce((t, r) => t + r.ltv, 0),
    deposits: v.reduce((t, x) => t + x.deposits, 0),
    refunds: v.reduce((t, x) => t + x.refunds, 0),
    withDeposits: v.filter((x) => x.deposits > x.refunds).length,
    months: paid.reduce((t, r) => t + Math.max(1, r.months), 0),
    noDates: paid.filter((r) => !r.months).length,
  };
}

async function getLtvData(): Promise<{ byName: Record<string, LtvDeposit>; rows: { name: string; ltv: number; months: number }[] }> {
  const svc = createServiceClient();
  const all = (table: string) => fetchAllRows<Row>((a, b) => svc.from(table).select("data").order("id").range(a, b));
  const [cm, pays, ltv, deps, refunds] = await Promise.all([
    all("clients_master"), all("ltv_sheet1"), all("ltv_sheet2"), all("deposits"),
    fetchAllRows<{ business: string | null; amount: string | null }>((a, b) =>
      svc.from("deposit_refunds").select("business, amount").eq("status", "refunded").order("id").range(a, b)),
  ]);

  // Clients Master: name key / email → businesses (+ a readable name per business)
  const bizByName = new Map<string, Set<string>>(), bizByEmail = new Map<string, Set<string>>(), bizLabel = new Map<string, string>();
  const add = (m: Map<string, Set<string>>, k: string, b: string) => { if (!k || !b) return; (m.get(k) ?? m.set(k, new Set()).get(k)!).add(b); };
  for (const { data: d } of cm) {
    const b = biz(d["Business Name"]);
    if (!b) continue;
    bizLabel.set(b, s(d["Business Name"]));
    add(bizByName, sortedKey(d["Owner Full Name"]), b);
    add(bizByEmail, s(d["Email"]).toLowerCase(), b);
  }
  // Payments ledger: name on payment → emails
  const emailsByName = new Map<string, Set<string>>(), payMonths = new Map<string, number[]>();
  for (const { data: d } of pays) {
    const e = s(d["Email"]).toLowerCase();
    const k = sortedKey(d["Full Name (On Payment)"]) || sortedKey(d["Full Name (When Sign Up)"]);
    if (e) add(emailsByName, k, e);
    const mo = monthNo(d["Date"]);
    if (k && mo != null) (payMonths.get(k) ?? payMonths.set(k, []).get(k)!).push(mo);
  }

  // Deposits per business (de-duplicated), refunds per business
  const depMonths = new Map<string, number[]>();
  const seen = new Set<string>(), depSum = new Map<string, { amt: number; n: number }>(), refSum = new Map<string, number>();
  for (const { data: d } of deps) {
    if (/void/i.test(s(d["Date"])) || /void/i.test(s(d["Business Name"]))) continue;
    const b = biz(d["Business Name"]), date = s(d["Date"]);
    if (!b || !date) continue;
    const who = s(d["Email"]).toLowerCase() || s(d["Full Name"]).toLowerCase();
    const key = `${b}|${who}|${date}`;
    if (who && seen.has(key)) continue;
    seen.add(key);
    const cur = depSum.get(b) ?? { amt: 0, n: 0 };
    depSum.set(b, { amt: cur.amt + (money(d["Amount"]) || 50), n: cur.n + 1 });
    const mo = monthNo(date);
    if (mo != null) (depMonths.get(b) ?? depMonths.set(b, []).get(b)!).push(mo);
  }
  for (const r of refunds) { const b = biz(r.business); if (b) refSum.set(b, (refSum.get(b) ?? 0) + (money(r.amount) || 50)); }

  // LTV rows → businesses; each business goes to its highest-LTV row only
  const rows = ltv
    .map(({ data: d }) => ({ name: s(d["(Name On Payment)"]), ltv: money(d["Lifetime Value"]), months: 0 }))
    .filter((r) => r.name)
    .sort((a, b) => b.ltv - a.ltv);
  const taken = new Set<string>(), out: Record<string, LtvDeposit> = {};
  for (const r of rows) {
    const k = sortedKey(r.name);
    const bs = new Set<string>(bizByName.get(k) ?? []);
    for (const e of emailsByName.get(k) ?? []) for (const b of bizByEmail.get(e) ?? []) bs.add(b);
    const mine = [...bs].filter((b) => !taken.has(b) && (depSum.has(b) || refSum.has(b)));
    r.months = span([...(payMonths.get(k) ?? []), ...mine.flatMap((b) => depMonths.get(b) ?? [])]);
    if (!mine.length) continue;
    mine.forEach((b) => taken.add(b));
    const prev = out[r.name];
    out[r.name] = {
      deposits: (prev?.deposits ?? 0) + mine.reduce((t, b) => t + (depSum.get(b)?.amt ?? 0), 0),
      refunds: (prev?.refunds ?? 0) + mine.reduce((t, b) => t + (refSum.get(b) ?? 0), 0),
      count: (prev?.count ?? 0) + mine.reduce((t, b) => t + (depSum.get(b)?.n ?? 0), 0),
      businesses: [...(prev?.businesses ?? []), ...mine.map((b) => bizLabel.get(b) ?? b)],
    };
  }
  return { byName: out, rows };
}
