// Audit: which depositors (since June 1) never received an appointment
// confirmation message ("... appointment has been confirmed at ...") in GHL.
//
// Reads deposits from Supabase, matches each depositor to their GHL contact
// by email (preferring the location owned by the deposit's business), then
// scans that contact's full conversation history for the confirmation text.
//
// Run: node scripts/audit-deposit-confirmations.mjs
// Output: scripts/out/deposit-confirmation-audit.json + console summary.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(join(root, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BASE = "https://services.leadconnectorhq.com";
const CONFIRM_RE = /appointment has been confirmed/i;

async function ghlGet(url, token, version) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Version: version, Accept: "application/json" } });
  if (!r.ok) return { __error: `HTTP ${r.status} on ${url.replace(BASE, "").split("?")[0]}` };
  return r.json();
}

// ── location tokens: stored per-location install, else mint from agency row ──
const locCache = new Map();
async function getLocationToken(locationId) {
  if (locCache.has(locationId)) return locCache.get(locationId);
  let out;
  const { data: locRow } = await supabase.from("ghl_oauth_locations").select("*").eq("location_id", locationId).maybeSingle();
  if (locRow?.access_token && new Date(locRow.expires_at).getTime() > Date.now()) {
    out = { token: locRow.access_token };
  } else {
    const { data: agency } = await supabase.from("ghl_oauth").select("*").eq("id", 1).single();
    if (!agency?.access_token || new Date(agency.expires_at).getTime() < Date.now()) {
      out = { error: "agency token missing/expired — run the ingest once to refresh it" };
    } else {
      const r = await fetch(`${BASE}/oauth/locationToken`, {
        method: "POST",
        headers: { Authorization: `Bearer ${agency.access_token}`, Version: "2021-07-28", "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ companyId: agency.company_id ?? "", locationId }).toString(),
      });
      const text = await r.text();
      out = r.ok ? { token: JSON.parse(text).access_token } : { error: `locationToken HTTP ${r.status}` };
    }
  }
  locCache.set(locationId, out);
  return out;
}

// Scan every message in every conversation of one contact for the confirmation.
async function findConfirmation(locationId, contactId) {
  const tok = await getLocationToken(locationId);
  if (tok.error) return { status: "error", detail: tok.error };
  const cs = await ghlGet(`${BASE}/conversations/search?locationId=${locationId}&contactId=${contactId}&limit=20`, tok.token, "2021-04-15");
  if (cs.__error) return { status: "error", detail: cs.__error };
  const convs = cs.conversations ?? [];
  if (!convs.length) return { status: "no_conversations" };
  for (const conv of convs) {
    let url = `${BASE}/conversations/${conv.id}/messages?limit=100`;
    for (let page = 0; page < 5 && url; page++) {
      const mj = await ghlGet(url, tok.token, "2021-04-15");
      if (mj.__error) return { status: "error", detail: mj.__error };
      const msgs = mj.messages?.messages ?? mj.messages ?? [];
      for (const m of msgs) {
        const body = String(m.body ?? "");
        if (CONFIRM_RE.test(body)) {
          return { status: "confirmed", sentAt: m.dateAdded, snippet: body.slice(0, 120) };
        }
      }
      const next = mj.messages?.nextPage ?? null;
      url = next && msgs.length === 100 ? `${BASE}/conversations/${conv.id}/messages?limit=100&lastMessageId=${msgs[msgs.length - 1].id}` : null;
    }
  }
  return { status: "no_confirmation" };
}

async function main() {
  // 1. Deposits since June 1 (deposit date is DD/MM/YYYY text).
  const { data: depRows, error } = await supabase.from("deposits").select("data");
  if (error) throw error;
  const deposits = [];
  for (const { data } of depRows) {
    const d = data.Date?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!d) continue;
    const iso = `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`;
    if (iso < "2026-06-01") continue;
    deposits.push({
      date: iso,
      name: (data["Full Name"] ?? "").trim(),
      email: (data.Email ?? "").trim().toLowerCase(),
      business: (data["Business Name"] ?? "").trim(),
    });
  }
  console.log(`${deposits.length} deposits since 2026-06-01`);

  // 2. Business Name -> owner_key (clients_master), for location preference.
  const { data: cm } = await supabase.from("clients_master").select("data");
  const bizToOwner = new Map();
  for (const { data } of cm ?? []) {
    const biz = (data["Business Name"] ?? "").trim().toLowerCase();
    const owner = (data["Owner Full Name"] ?? "").trim().toLowerCase();
    if (biz && owner) bizToOwner.set(biz, owner);
  }

  // 3. Match depositors to GHL contacts by email.
  const emails = [...new Set(deposits.map((d) => d.email).filter(Boolean))];
  const contactsByEmail = new Map();
  for (let i = 0; i < emails.length; i += 100) {
    const { data: cs } = await supabase.from("ghl_contacts")
      .select("id, location_id, owner_key, email, contact_name")
      .in("email", emails.slice(i, i + 100));
    for (const c of cs ?? []) {
      const k = c.email.toLowerCase();
      if (!contactsByEmail.has(k)) contactsByEmail.set(k, []);
      contactsByEmail.get(k).push(c);
    }
  }

  // 4. Check each deposit (concurrency 5).
  const results = [];
  let next = 0;
  async function lane() {
    while (next < deposits.length) {
      const dep = deposits[next++];
      const cands = contactsByEmail.get(dep.email) ?? [];
      const owner = bizToOwner.get(dep.business.toLowerCase());
      const contact = cands.find((c) => c.owner_key === owner) ?? cands[0];
      if (!dep.email) { results.push({ ...dep, status: "no_email" }); continue; }
      if (!contact) { results.push({ ...dep, status: "no_ghl_contact" }); continue; }
      const r = await findConfirmation(contact.location_id, contact.id);
      results.push({ ...dep, owner: contact.owner_key, ...r });
      if (results.length % 25 === 0) console.log(`  ${results.length}/${deposits.length} checked`);
    }
  }
  await Promise.all(Array.from({ length: 5 }, lane));

  // 5. Report.
  const by = (s) => results.filter((r) => r.status === s);
  console.log(`\nconfirmed: ${by("confirmed").length}`);
  console.log(`NO confirmation message: ${by("no_confirmation").length}`);
  console.log(`no conversations at all: ${by("no_conversations").length}`);
  console.log(`not found in GHL: ${by("no_ghl_contact").length}`);
  console.log(`no email on deposit: ${by("no_email").length}`);
  console.log(`errors: ${by("error").length}`);
  mkdirSync(join(root, "scripts/out"), { recursive: true });
  writeFileSync(join(root, "scripts/out/deposit-confirmation-audit.json"), JSON.stringify(results, null, 2));
  console.log("\nwritten to scripts/out/deposit-confirmation-audit.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
