import { createServiceClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/onebox-insights";
import { bizKey as biz, sortedKey } from "@/lib/ltv-keys";

/* LTV → deposits (owner, 11/25/2026): next to each client's lifetime value,
   the lead deposits we took for that client, minus refunds ("$10,000 + $500").

   Matching (same rules as the Client Health view):
     LTV name ── same name (any word order) ──► Clients Master owner → business
     LTV name ── its payment emails ─────────► Clients Master email → business
     business ── normalized name ────────────► deposits / refunded deposits
   Deposits are de-duplicated like client_health_base (same business + same
   person + same day = one), VOID rows skipped. One business's deposits go to
   ONE LTV row only (the highest LTV), so a client listed twice in the sheet
   (same person, names in a different order) or two partners don't double them.

   Worth (owner, 11/27/2026: "how much each client is worth to me per month,
   so I know if she's worth keeping"): service fees also count the charges the
   dashboard itself takes — monthly charges (subscription_charges) and
   pay-per-appointment fees (ppa_charges). Those are NOT in the LTV sheet
   (checked 11/27: 57 of 58 monthly charges before 11/15 and the recent
   per-appointment fees are missing there). A dashboard charge that the sheet
   already has (same client, same amount, ±3 days) is skipped. */

type Row = { data: Record<string, unknown> };
export type LtvDeposit = { deposits: number; refunds: number; count: number; businesses: string[] };

/* One client, all the money we got from them. Months are year*12+month. */
export type ClientMoney = {
  name: string;
  businesses: string[];   // readable business names
  bizKeys: string[];      // normalized, for matching Performance rows
  nameKeys: string[];     // owner name keys (any word order)
  sheetFees: number;      // LTV sheet "Lifetime Value"
  monthly: number;        // dashboard monthly charges not in the sheet
  perAppt: number;        // dashboard pay-per-appointment fees not in the sheet
  deposits: number;
  refunds: number;
  depCount: number;
  first: number | null;   // first month with any money
  last: number | null;    // last month with any money
  feeGap: number;         // longest run of months with no fee between two fees
  gapFrom: number | null; // first month of that run
  /* Last 6 full months (owner, 11/28/2026: "she pays 697 every month" — the
     whole-time average mixed in setup fees, upfront payments and old prices).
     Window = the 6 months before this month; a client who started inside it
     counts only her months. byMonth = money per month, for the hover. */
  recent: { from: number; months: number; fees: number; deposits: number; refunds: number; byMonth: { m: number; fees: number; dep: number }[] } | null;
};

const money = (v: unknown) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, "")); return isNaN(n) ? 0 : n; };
const s = (v: unknown) => String(v ?? "").trim();
// "dd/mm/yyyy" or "yyyy-mm-dd" → day number (UTC days) or null.
const dayNo = (v: unknown): number | null => {
  const t = s(v);
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]) / 864e5;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 : null;
};
const monthOfDay = (d: number) => { const x = new Date(d * 864e5); return x.getUTCFullYear() * 12 + x.getUTCMonth(); };

export async function getLtvDeposits(): Promise<Record<string, LtvDeposit>> {
  return (await getLtvData()).byName;
}

/* Average worth (Performance box): all the money ÷ all the months clients
   stayed. A client's months = first to last month we got money from them
   (a fee or a lead deposit), both ends counted. */
export type LtvWorth = {
  clients: number; fees: number; deposits: number; refunds: number; withDeposits: number; months: number; noDates: number;
  perClient: ClientMoney[];
};
export async function getLtvWorth(): Promise<LtvWorth> {
  const { clients } = await getLtvData();
  const paid = clients.filter((c) => c.sheetFees + c.monthly + c.perAppt > 0);
  return {
    clients: paid.length,
    fees: paid.reduce((t, c) => t + c.sheetFees + c.monthly + c.perAppt, 0),
    deposits: clients.reduce((t, c) => t + c.deposits, 0),
    refunds: clients.reduce((t, c) => t + c.refunds, 0),
    withDeposits: clients.filter((c) => c.deposits > c.refunds).length,
    months: paid.reduce((t, c) => t + (c.first != null && c.last != null ? c.last - c.first + 1 : 1), 0),
    noDates: paid.filter((c) => c.first == null).length,
    perClient: clients,
  };
}

async function getLtvData(): Promise<{ byName: Record<string, LtvDeposit>; clients: ClientMoney[] }> {
  const svc = createServiceClient();
  const all = (table: string) => fetchAllRows<Row>((a, b) => svc.from(table).select("data").order("id").range(a, b));
  const [cm, pays, ltv, deps, refunds, subs, ppa] = await Promise.all([
    all("clients_master"), all("ltv_sheet1"), all("ltv_sheet2"), all("deposits"),
    fetchAllRows<{ business: string | null; amount: string | null; decided_at: string | null; requested_at: string | null }>((a, b) =>
      svc.from("deposit_refunds").select("business, amount, decided_at, requested_at").eq("status", "refunded").order("id").range(a, b)),
    fetchAllRows<{ owner_key: string | null; amount_cents: number | null; charged_at: string | null }>((a, b) =>
      svc.from("subscription_charges").select("owner_key, amount_cents, charged_at").eq("status", "succeeded").order("id").range(a, b)),
    fetchAllRows<{ owner_key: string | null; amount: number | string | null; charged_at: string | null; square_payment_id: string | null }>((a, b) =>
      svc.from("ppa_charges").select("owner_key, amount, charged_at, square_payment_id").eq("charged", true).order("appt_id").range(a, b)),
  ]);

  // Clients Master: name key / email → businesses (+ a readable name per business)
  const bizByName = new Map<string, Set<string>>(), bizByEmail = new Map<string, Set<string>>(), bizLabel = new Map<string, string>(), bizOwner = new Map<string, string>();
  const add = <T,>(m: Map<string, Set<T>>, k: string, v: T) => { if (!k || v == null || v === "") return; (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v); };
  for (const { data: d } of cm) {
    const b = biz(d["Business Name"]);
    if (!b) continue;
    bizLabel.set(b, s(d["Business Name"]));
    if (!bizOwner.has(b)) bizOwner.set(b, sortedKey(d["Owner Full Name"]));
    add(bizByName, sortedKey(d["Owner Full Name"]), b);
    add(bizByEmail, s(d["Email"]).toLowerCase(), b);
  }
  // Payments ledger: name on payment → emails, and each payment (day + amount)
  const emailsByName = new Map<string, Set<string>>(), sheetPays = new Map<string, { day: number; amt: number }[]>();
  for (const { data: d } of pays) {
    const e = s(d["Email"]).toLowerCase();
    const k = sortedKey(d["Full Name (On Payment)"]) || sortedKey(d["Full Name (When Sign Up)"]);
    if (e) add(emailsByName, k, e);
    const day = dayNo(d["Date"]), amt = money(d["Amount"]);
    if (!k || day == null) continue;
    // The same payment typed twice (same name, day, amount) counts once.
    const list = sheetPays.get(k) ?? sheetPays.set(k, []).get(k)!;
    if (!list.some((p) => p.day === day && p.amt === amt)) list.push({ day, amt });
  }

  // Deposits per business (de-duplicated), refunds per business
  const depMonths = new Map<string, number[]>();
  const depList = new Map<string, { m: number; amt: number }[]>(), refList = new Map<string, { m: number; amt: number }[]>();
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
    const day = dayNo(date);
    if (day != null) {
      (depMonths.get(b) ?? depMonths.set(b, []).get(b)!).push(monthOfDay(day));
      (depList.get(b) ?? depList.set(b, []).get(b)!).push({ m: monthOfDay(day), amt: money(d["Amount"]) || 50 });
    }
  }
  for (const r of refunds) {
    const b = biz(r.business);
    if (!b) continue;
    const amt = money(r.amount) || 50;
    refSum.set(b, (refSum.get(b) ?? 0) + amt);
    const day = dayNo(r.decided_at ?? r.requested_at);
    if (day != null) (refList.get(b) ?? refList.set(b, []).get(b)!).push({ m: monthOfDay(day), amt });
  }

  // LTV rows → clients; each business goes to its highest-LTV row only
  type Work = ClientMoney & { feeDays: { day: number; amt: number }[]; depMo: number[]; depBiz: string[] };
  const ltvKeys = new Set(ltv.map(({ data: d }) => sortedKey(d["(Name On Payment)"])).filter(Boolean));
  const rows = ltv
    .map(({ data: d }) => ({ name: s(d["(Name On Payment)"]), ltv: money(d["Lifetime Value"]) }))
    .filter((r) => r.name)
    .sort((a, b) => b.ltv - a.ltv);
  const taken = new Set<string>(), out: Record<string, LtvDeposit> = {};
  const clients: Work[] = [], byNameKey = new Map<string, Work>(), byBiz = new Map<string, Work>();
  const blank = (name: string): Work => ({
    name, businesses: [], bizKeys: [], nameKeys: [], sheetFees: 0, monthly: 0, perAppt: 0, deposits: 0, refunds: 0, depCount: 0,
    first: null, last: null, feeGap: 0, gapFrom: null, recent: null, feeDays: [], depMo: [], depBiz: [],
  });
  for (const r of rows) {
    const k = sortedKey(r.name);
    const bs = new Set<string>(bizByName.get(k) ?? []);
    // A business found only through a payment email belongs to this client
    // only when its owner has no LTV row of her own (11/28: one payment typed
    // with another client's email moved that client's deposits over).
    for (const e of emailsByName.get(k) ?? []) for (const b of bizByEmail.get(e) ?? []) {
      const o = bizOwner.get(b);
      if (!o || o === k || !ltvKeys.has(o)) bs.add(b);
    }
    const mine = [...bs].filter((b) => !taken.has(b) && (depSum.has(b) || refSum.has(b)));
    mine.forEach((b) => taken.add(b));
    // Same person listed twice (names in another order) → one client.
    let c = byNameKey.get(k);
    if (!c) { c = blank(r.name); c.nameKeys.push(k); c.feeDays.push(...(sheetPays.get(k) ?? [])); clients.push(c); byNameKey.set(k, c); }
    c.sheetFees += r.ltv;
    for (const b of bs) { if (!byBiz.has(b)) byBiz.set(b, c); if (!c.bizKeys.includes(b)) c.bizKeys.push(b); }
    for (const b of mine) {
      c.deposits += depSum.get(b)?.amt ?? 0;
      c.refunds += refSum.get(b) ?? 0;
      c.depCount += depSum.get(b)?.n ?? 0;
      c.depMo.push(...(depMonths.get(b) ?? []));
      c.depBiz.push(b);
      c.businesses.push(bizLabel.get(b) ?? b);
    }
    if (mine.length) {
      const prev = out[r.name];
      out[r.name] = {
        deposits: (prev?.deposits ?? 0) + mine.reduce((t, b) => t + (depSum.get(b)?.amt ?? 0), 0),
        refunds: (prev?.refunds ?? 0) + mine.reduce((t, b) => t + (refSum.get(b) ?? 0), 0),
        count: (prev?.count ?? 0) + mine.reduce((t, b) => t + (depSum.get(b)?.n ?? 0), 0),
        businesses: [...(prev?.businesses ?? []), ...mine.map((b) => bizLabel.get(b) ?? b)],
      };
    }
  }

  // Dashboard charges → the client they belong to (name, else their business).
  const ownerOf = (ownerKey: string | null): Work | null => {
    const k = sortedKey(ownerKey);
    if (!k) return null;
    let c = byNameKey.get(k);
    if (!c) for (const b of bizByName.get(k) ?? []) { c = byBiz.get(b); if (c) break; }
    if (!c) {
      // New client who only pays through the dashboard so far.
      const name = String(ownerKey).replace(/\(.*?\)/g, "").trim().replace(/\b\w/g, (x) => x.toUpperCase());
      c = blank(name); c.nameKeys.push(k);
      for (const b of bizByName.get(k) ?? []) {
        if (!taken.has(b) && (depSum.has(b) || refSum.has(b))) {
          taken.add(b);
          c.deposits += depSum.get(b)?.amt ?? 0; c.refunds += refSum.get(b) ?? 0; c.depCount += depSum.get(b)?.n ?? 0;
          c.depMo.push(...(depMonths.get(b) ?? [])); c.depBiz.push(b); c.businesses.push(bizLabel.get(b) ?? b);
        }
        if (!byBiz.has(b)) byBiz.set(b, c);
        c.bizKeys.push(b);
      }
      clients.push(c); byNameKey.set(k, c);
    } else if (!c.nameKeys.includes(k)) c.nameKeys.push(k);
    return c;
  };
  const inSheet = (c: Work, day: number, amt: number) => c.feeDays.some((p) => Math.abs(p.day - day) <= 3 && Math.abs(p.amt - amt) < 1);
  const addCharge = (ownerKey: string | null, amt: number, at: string | null, kind: "monthly" | "perAppt") => {
    const day = dayNo(at);
    if (!amt || day == null) return;
    const c = ownerOf(ownerKey);
    if (!c || inSheet(c, day, amt)) return;
    c[kind] += amt;
    c.feeDays.push({ day, amt });
  };
  for (const x of subs) addCharge(x.owner_key, (x.amount_cents ?? 0) / 100, x.charged_at, "monthly");
  // One card payment often covers several appointments → add them up first.
  const ppaPay = new Map<string, { owner: string | null; amt: number; at: string | null }>();
  for (const x of ppa) {
    const id = x.square_payment_id || `${x.owner_key}|${String(x.charged_at ?? "").slice(0, 10)}`;
    const cur = ppaPay.get(id) ?? { owner: x.owner_key, amt: 0, at: x.charged_at };
    cur.amt += money(x.amount);
    ppaPay.set(id, cur);
  }
  for (const x of ppaPay.values()) addCharge(x.owner, x.amt, x.at, "perAppt");

  // Months: first/last month with any money; longest stretch with no fee.
  for (const c of clients) {
    const feeMo = [...new Set(c.feeDays.filter((p) => p.amt > 0).map((p) => monthOfDay(p.day)))].sort((a, b) => a - b);
    const allMo = [...feeMo, ...c.depMo];
    c.first = allMo.length ? Math.min(...allMo) : null;
    c.last = allMo.length ? Math.max(...allMo) : null;
    for (let i = 1; i < feeMo.length; i++) {
      const gap = feeMo[i] - feeMo[i - 1] - 1;
      if (gap > c.feeGap) { c.feeGap = gap; c.gapFrom = feeMo[i - 1] + 1; }
    }
    // Last 6 full months.
    if (c.first != null) {
      const now = new Date(), cur = now.getUTCFullYear() * 12 + now.getUTCMonth();
      const end = cur - 1, from = Math.max(cur - 6, c.first);
      if (from <= end) {
        const byMonth: { m: number; fees: number; dep: number }[] = [];
        for (let m = from; m <= end; m++) byMonth.push({ m, fees: 0, dep: 0 });
        const at = (m: number) => (m >= from && m <= end ? byMonth[m - from] : null);
        for (const p of c.feeDays) { const x = at(monthOfDay(p.day)); if (x) x.fees += p.amt; }
        let refunds = 0;
        for (const b of c.depBiz) {
          for (const d of depList.get(b) ?? []) { const x = at(d.m); if (x) x.dep += d.amt; }
          for (const r of refList.get(b) ?? []) if (at(r.m)) refunds += r.amt;
        }
        c.recent = {
          from, months: end - from + 1, refunds,
          fees: byMonth.reduce((t, x) => t + x.fees, 0),
          deposits: byMonth.reduce((t, x) => t + x.dep, 0),
          byMonth,
        };
      }
    }
  }
  return {
    byName: out,
    clients: clients.map((w) => {
      const c: Partial<Work> = { ...w, sheetFees: Math.round(w.sheetFees * 100) / 100 };
      delete c.feeDays; delete c.depMo; delete c.depBiz;
      return c as ClientMoney;
    }),
  };
}
