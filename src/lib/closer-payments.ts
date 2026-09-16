import type { SupabaseClient } from "@supabase/supabase-js";
import { getSheetsClient, getTabNames } from "@/lib/sheets";
import { FINANCE_SHEET_ID } from "@/lib/ceo-finance";
import { loadClosedDeals } from "@/lib/sales-board";

/* Closer payment tracker. A closer is paid per installment: a client closed
   on a 3-month plan ($897 × 3) pays month after month, and the closer asks
   for their cut when each one goes through. The Financing workbook is the
   record — one tab per month ("April V2" …), one row per client: plan notes,
   day of payment, USD, PAYMENT STATUS. We line up every won demo with its
   rows across the months and remember which installments the commission
   was requested / paid for (closer_commissions). */

const DAY = 86400_000;
/* How far back a won demo is still followed (a 3-month plan closed in May
   pays through July/August). */
const LOOKBACK_DAYS = 240;

export const nameKey = (s: string) => String(s ?? "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const money = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : 0; };
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export type MonthRow = { ym: string; tab: string; notes: string; day: string; usd: number; status: string; paid: boolean };
export type Commission = { requestedAt: string | null; requestedBy: string | null; paidAt: string | null; paidBy: string | null };
export type Installment = { ym: string; label: string; usd: number; status: string; day: string; commission: Commission | null };
export type Deal = {
  key: string; name: string; closer: string; closedAt: string; upfront: number;
  plan: string;              // "3-month plan", "Paid in full", "Monthly", or the sheet's own words
  months: MonthRow[];        // every financing row for this client, oldest first
  installments: Installment[]; // the months that actually charged (USD > 0 and Paid)
  inSheet: boolean;
  /* Set when the sheet spells the name differently ("Tali McMillan" in the
     demos sheet, "Tali Ta" in the financing sheet) and we matched on the
     first name — shown so a wrong match is easy to spot. */
  matchedAs: string | null;
  /* An installment went through and the commission hasn't been marked paid. */
  openCommission: number;
};

/* "April V2" → 2026-04. The new layout starts in April 2026 (header row 6:
   B name, C notes, D day, E USD, F payment status); the old Jan–Mar layout
   predates every deal this tracker follows. */
function monthTabs(tabs: string[]): { tab: string; ym: string }[] {
  const out: { tab: string; ym: string }[] = [];
  for (const t of tabs) {
    const m = t.match(/^([A-Za-z]+)\s+V2$/);
    if (!m) continue;
    const idx = MONTH_NAMES.indexOf(m[1].toLowerCase());
    if (idx < 0) continue;
    out.push({ tab: t, ym: `2026-${String(idx + 1).padStart(2, "0")}` });
  }
  return out.sort((a, b) => a.ym.localeCompare(b.ym));
}

function planLabel(notes: string, upfront: number): string {
  const n = notes.toLowerCase();
  const m = n.match(/(\d)\s*\+\s*(\d)\s*months?/);
  if (m) return `${m[1]} + ${m[2]} months`;
  const k = n.match(/\b(\d{1,2})\s*months?\b/);
  if (k && +k[1] <= 12) return upfront >= 1500 ? `${k[1]}-month plan · paid in full` : `${k[1]}-month plan`;
  if (/paid upfront|paid in full/.test(n)) return "Paid in full";
  return "Monthly";
}

export async function buildCloserPayments(svc: SupabaseClient, closerName: string | null): Promise<{ deals: Deal[]; months: string[]; generatedAt: string }> {
  const now = Date.now();
  const deals = (await loadClosedDeals(svc)).filter((d) => {
    const t = (d.closeDate ?? d.demoAt ?? d.date)!.getTime();
    return now - t <= LOOKBACK_DAYS * DAY && (!closerName || d.closer.toLowerCase() === closerName.toLowerCase());
  });

  // Financing rows by client key, across every month tab.
  const tabs = monthTabs(await getTabNames(FINANCE_SHEET_ID));
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: FINANCE_SHEET_ID,
    ranges: tabs.map((t) => `'${t.tab}'!B7:F600`),
    valueRenderOption: "FORMATTED_VALUE",
  });
  const byKey = new Map<string, MonthRow[]>();
  (res.data.valueRanges ?? []).forEach((vr, i) => {
    for (const row of (vr.values ?? []) as string[][]) {
      const name = String(row[0] ?? "").trim();
      if (!name || /deposits from clients|^total/i.test(name)) continue;
      const k = nameKey(name);
      if (k.length < 3) continue;
      const usd = money(row[3]);
      const status = String(row[4] ?? "").trim();
      const mr: MonthRow = { ym: tabs[i].ym, tab: tabs[i].tab, notes: String(row[1] ?? "").trim(), day: String(row[2] ?? "").trim(), usd, status, paid: usd > 0 && /paid/i.test(status) };
      byKey.set(k, [...(byKey.get(k) ?? []), mr]);
      // "Oyunchimeg Erdenetsogt (Jessica Lee)" — the demos sheet may use the alias.
      const alias = name.match(/\(([^)]+)\)/)?.[1];
      const ak = alias ? nameKey(alias) : "";
      if (ak.length >= 3 && ak !== k) byKey.set(ak, [...(byKey.get(ak) ?? []), mr]);
    }
  });

  const { data: comms } = await svc.from("closer_commissions").select("*");
  const commOf = new Map<string, Commission>();
  for (const c of comms ?? []) commOf.set(`${c.client_key}|${c.ym}`, { requestedAt: c.requested_at, requestedBy: c.requested_by, paidAt: c.paid_at, paidBy: c.paid_by });

  // Fallback when the exact name misses: the only sheet client with the same
  // first name (and a compatible last initial) who has a row in the month of
  // the close or the month after.
  const sheetNames = [...byKey.keys()];
  const fuzzy = (name: string, closedAt: Date): string | null => {
    const parts = nameKey(name).split(" ").filter(Boolean);
    if (!parts.length) return null;
    const first = parts[0], lastInitial = parts.length > 1 ? parts[parts.length - 1][0] : null;
    const closeYm = closedAt.toISOString().slice(0, 7);
    const nextYm = new Date(closedAt.getFullYear(), closedAt.getMonth() + 1, 15).toISOString().slice(0, 7);
    const hits = sheetNames.filter((k) => {
      const p = k.split(" ");
      if (p[0] !== first) return false;
      if (lastInitial && p.length > 1 && p[p.length - 1][0] !== lastInitial) return false;
      return (byKey.get(k) ?? []).some((m) => m.ym === closeYm || m.ym === nextYm);
    });
    return hits.length === 1 ? hits[0] : null;
  };
  const displayName = new Map<string, string>(); // key → how the sheet spells it
  (res.data.valueRanges ?? []).forEach((vr) => { for (const row of (vr.values ?? []) as string[][]) { const n = String(row[0] ?? "").trim(); if (n) displayName.set(nameKey(n), n); } });

  const out: Deal[] = deals.map((d) => {
    const closedAt = (d.closeDate ?? d.demoAt ?? d.date)!;
    let key = nameKey(d.name);
    let matchedAs: string | null = null;
    if (!byKey.has(key)) { const f = fuzzy(d.name, closedAt); if (f) { key = f; matchedAs = displayName.get(f) ?? f; } }
    const months = (byKey.get(key) ?? []).sort((a, b) => a.ym.localeCompare(b.ym));
    const notes = months[months.length - 1]?.notes ?? "";
    const installments: Installment[] = months.filter((m) => m.paid).map((m, i) => ({
      ym: m.ym, label: `Payment ${i + 1}`, usd: m.usd, status: m.status, day: m.day, commission: commOf.get(`${key}|${m.ym}`) ?? null,
    }));
    return {
      key, name: d.name, closer: d.closer, closedAt: closedAt.toISOString(), upfront: d.upfront,
      plan: planLabel(notes, d.upfront), months, installments, inSheet: months.length > 0, matchedAs,
      openCommission: installments.filter((x) => !x.commission?.paidAt).length,
    };
  });
  return { deals: out, months: tabs.map((t) => t.ym), generatedAt: new Date().toISOString() };
}
