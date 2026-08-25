// Ground truth: Cristy Guzon's actual Commas/Fanbasis transactions since July 20.
const KEY = "lKI2gJ56jiZtjQA08FKyzW8HmgLCvC5n";
const BASE = "https://www.fanbasis.com/public-api";
for (let page = 1; page <= 40; page++) {
  const r = await fetch(`${BASE}/checkout-sessions/transactions?page=${page}&per_page=100`, {
    headers: { "x-api-key": KEY, Accept: "application/json" },
  });
  if (!r.ok) { console.log("HTTP", r.status, (await r.text()).slice(0, 150)); break; }
  const j = await r.json();
  const container = j.data ?? j;
  const list = container.transactions ?? j.transactions ?? [];
  if (!list.length) break;
  let oldest = null;
  for (const t of list) {
    const fan = t.fan ?? {};
    const email = String(fan.email ?? t.email ?? "").toLowerCase();
    const created = String(t.transaction_date ?? t.created_at ?? t.date ?? "");
    oldest = created;
    if (email === "cristysana94@gmail.com" || /guzon/i.test(String(fan.name ?? ""))) {
      console.log("TXN:", JSON.stringify({ id: t.id ?? t.transaction_id, email, name: fan.name, amount: t.amount ?? t.amount_cents, date: created, status: t.status, order: t.order_id ?? t.order ?? null }));
    }
  }
  if (oldest && Date.parse(oldest) < Date.parse("2026-07-15")) { console.log("(paged back to", oldest, ")"); break; }
}
console.log("done");
