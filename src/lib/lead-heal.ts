import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestRow, phoneKey } from "@/lib/direct-ingest";

/* Lead-row safety net (2026-10-19).

   The Performance / Leads / Clients tabs count leads from leads_master. A lead
   gets there in one of two ways: the one-box funnel writes its own row, or
   the client's GoHighLevel survey workflow posts it (via Make) to
   /api/webhooks. On 2026-10-08 the Make webhook was removed from every
   one-box survey workflow (it double-counted one-box leads) — which also cut
   the ONLY row path for accounts whose ads still send people to the OLD GHL
   survey page (About Face: 16 leads in GHL, none on the dashboard; Bare
   Lacquer the same once its ads restarted).

   GoHighLevel itself has every one of those leads (ghl_contacts, synced
   every 3 h, source "CC - PMU Survey …" / "One-Box Funnel"). So: for each
   recent lead-source contact of a Live/Paused client, make sure a leads_master
   row exists — same person (phone or email) within a week — and file one when
   it doesn't, under the client's Clients Master business name (the name the
   Performance view joins on). ingestRow's own twin check and the stable
   external id ("ghl:<contact id>") keep this idempotent. */

type Svc = SupabaseClient;
const DAY = 86400_000;
const LEAD_SOURCE = /survey|one-?box/i;
const norm = (s: unknown) => String(s ?? "").toLowerCase().trim();
const titleCase = (s: string) => s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1));

export type HealResult = { contacts: number; existing: number; filed: number; skipped: number; errors: string[]; byBusiness: Record<string, number>; partial: boolean };

async function loadAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/* owner key (lower-cased "Owner Full Name") → the Business Name the dashboard
   knows the client by. Live first, then Paused, so a returning client's old
   row never wins. */
async function businessByOwner(svc: Svc): Promise<Map<string, string>> {
  const rows = await loadAll<{ data: Record<string, unknown> }>((a, b) => svc.from("clients_master").select("data").range(a, b));
  const m = new Map<string, string>();
  for (const status of ["paused", "live"]) {
    for (const r of rows) {
      const d = r.data ?? {};
      if (norm(d["col_1"]) !== status) continue;
      const owner = norm(d["Owner Full Name"]);
      const biz = String(d["Business Name"] ?? "").trim();
      if (owner && biz) m.set(owner, biz);
    }
  }
  return m;
}

export async function healLeadRows(svc: Svc, opts: { days?: number; dryRun?: boolean; timeBudgetMs?: number } = {}): Promise<HealResult> {
  const started = Date.now();
  const days = opts.days ?? 30;
  const since = new Date(Date.now() - days * DAY).toISOString();
  const res: HealResult = { contacts: 0, existing: 0, filed: 0, skipped: 0, errors: [], byBusiness: {}, partial: false };

  const bizOf = await businessByOwner(svc);
  const contacts = await loadAll<{ id: string; owner_key: string | null; contact_name: string | null; email: string | null; phone: string | null; source: string | null; date_added: string }>(
    (a, b) => svc.from("ghl_contacts").select("id, owner_key, contact_name, email, phone, source, date_added").gt("date_added", since).order("date_added").range(a, b),
  );
  const leads = contacts.filter((c) => LEAD_SOURCE.test(String(c.source ?? "")) && c.owner_key && bizOf.has(c.owner_key));
  res.contacts = leads.length;
  if (!leads.length) return res;

  // Every lead row of the window (plus a week each side, for the date check).
  const rowSince = new Date(Date.now() - (days + 7) * DAY).toISOString();
  const rows = await loadAll<{ data: Record<string, unknown> }>((a, b) => svc.from("leads_master").select("data").gt("synced_at", rowSince).range(a, b));
  const seen = new Map<string, number[]>(); // "p|<10 digits>" / "e|<email>" → row dates (ms)
  const add = (k: string, t: number) => { const l = seen.get(k) ?? []; l.push(t); seen.set(k, l); };
  for (const r of rows) {
    const d = r.data ?? {};
    const m = String(d["col_6"] ?? d["Date"] ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    const t = m ? new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`).getTime() : NaN;
    const p = phoneKey(d["Phone Number"]);
    const e = norm(d["Email"]);
    if (p) add(`p|${p}`, t);
    if (e) add(`e|${e}`, t);
  }
  const near = (k: string, t: number) => (seen.get(k) ?? []).some((x) => !Number.isFinite(x) || Math.abs(x - t) <= 7 * DAY);

  for (const c of leads) {
    // Each row is a few DB round trips (~1 s). Stop before the function's
    // limit kills the run; the next run picks up where this one left off.
    if (opts.timeBudgetMs && Date.now() - started > opts.timeBudgetMs) { res.partial = true; break; }
    const t = Date.parse(c.date_added);
    const p = phoneKey(c.phone);
    const e = norm(c.email);
    if (!p && !e) { res.skipped++; continue; }
    if ((p && near(`p|${p}`, t)) || (e && near(`e|${e}`, t))) { res.existing++; continue; }
    const biz = bizOf.get(c.owner_key!)!;
    if (opts.dryRun) { res.filed++; res.byBusiness[biz] = (res.byBusiness[biz] ?? 0) + 1; continue; }
    const r = await ingestRow("leads_master", {
      full_name: titleCase(String(c.contact_name ?? "").trim()) || (e || p),
      phone: c.phone ?? "",
      email: c.email ?? "",
      business_name: biz,
      date: c.date_added,
      external_id: `ghl:${c.id}`,
    }).catch((err) => ({ ok: false as const, status: 500, error: err instanceof Error ? err.message : "ingest failed" }));
    if (!r.ok) { res.errors.push(`${biz}: ${"error" in r ? r.error : "failed"}`); continue; }
    res.filed++;
    res.byBusiness[biz] = (res.byBusiness[biz] ?? 0) + 1;
    // Don't file the same person twice in one run (two contacts, one lead).
    if (p) add(`p|${p}`, t);
    if (e) add(`e|${e}`, t);
  }
  return res;
}
