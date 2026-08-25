// Ground truth every suspected duplicate: count each email's REAL Commas
// transactions since Feb 1. One real txn + two dashboard rows = duplicate.
const KEY = "lKI2gJ56jiZtjQA08FKyzW8HmgLCvC5n";
const BASE = "https://www.fanbasis.com/public-api";
const EMAILS = new Set();
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: direct } = await sb.from("deposits").select("external_id, data").not("external_id", "is", null).is("sheet_row", null);
const em = (r) => String(r.data?.["Email"] ?? "").toLowerCase().trim();
for (const r of direct ?? []) if (em(r)) EMAILS.add(em(r));
console.log("direct-row emails to check:", EMAILS.size);

const txns = new Map(); // email -> [{date, amount}]
outer:
for (let page = 1; page <= 60; page++) {
  const r = await fetch(`${BASE}/checkout-sessions/transactions?page=${page}&per_page=100`, { headers: { "x-api-key": KEY, Accept: "application/json" } });
  if (!r.ok) { console.log("HTTP", r.status); break; }
  const j = await r.json();
  const list = (j.data ?? j).transactions ?? j.transactions ?? [];
  if (!list.length) break;
  for (const t of list) {
    const fan = t.fan ?? {};
    const email = String(fan.email ?? t.email ?? "").toLowerCase().trim();
    const created = String(t.transaction_date ?? t.created_at ?? t.date ?? "");
    if (EMAILS.has(email)) {
      if (!txns.has(email)) txns.set(email, []);
      txns.get(email).push({ date: created.slice(0, 10), amount: t.amount });
    }
    if (created && Date.parse(created) < Date.parse("2026-02-01")) break outer;
  }
  if (list.length < 100) break;
}
for (const r of direct ?? []) {
  const e = em(r);
  if (!e) continue;
  const real = txns.get(e) ?? [];
  console.log(`${r.external_id} | ${r.data?.["Full Name"]} | ${r.data?.["Business Name"]} | webhookDate=${r.data?.["Date"]} | realTxns=${real.length} ${JSON.stringify(real)}`);
}
