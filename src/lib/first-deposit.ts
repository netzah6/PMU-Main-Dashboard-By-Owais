import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeOwnerKey } from "@/lib/normalizers";
import { parseSheetDate } from "@/lib/sales-board";
import { AGENCY_TZ } from "@/lib/ceo-capacity";

/* 🎉 First deposit after go-live → a 🔔 Notifications row for the client's
   Client Success Coach (owner request 2026-10-08), naming the person who
   paid and when.

   "Went live" = a client_live_seen row that is NOT baseline (it turned Live
   after that tracker started); baseline clients were live long before and
   their first deposit is history. "First" = the earliest deposit for that
   business on/after the go-live day, and only when the business has NO
   deposit dated before go-live — a recycled sub-account or a renamed owner
   (Desert Diva: new owner key, years of deposits) is not a new client.

   Runs from the every-minute deposits sync. It only reads the full deposits
   table when a recently synced row belongs to a client still waiting for its
   first-deposit note, so the usual minute costs three small reads. */

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** Notes are for fresh news — never announce a deposit older than this. */
const MAX_AGE_DAYS = 3;
const DAY = 86_400_000;

type Dep = { data: Record<string, unknown>; synced_at: string | null };

const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: AGENCY_TZ });

export async function notifyFirstDeposits(
  svc: SupabaseClient,
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<{ candidates: number; notified: string[] }> {
  const now = opts.now ?? new Date();
  const [{ data: cm }, { data: seen }, { data: done }] = await Promise.all([
    svc.from("clients_master").select("data"),
    svc.from("client_live_seen").select("owner_key, baseline, first_seen_live_at").eq("baseline", false),
    svc.from("notifications").select("meta").eq("type", "first_deposit"),
  ]);
  const notifiedKeys = new Set((done ?? []).map((r) => String((r.meta as Record<string, unknown>)?.biz_key ?? "")));
  const liveAt = new Map((seen ?? []).map((s) => [String(s.owner_key), String(s.first_seen_live_at)]));

  // Live clients that went live after the tracker started and have no note yet.
  const waiting = new Map<string, { business: string; owner: string; coach: string | null; liveDay: string }>();
  for (const r of (cm ?? []) as Array<{ data: Record<string, unknown> }>) {
    if (String(r.data?.["col_1"] ?? "").trim().toLowerCase() !== "live") continue;
    const owner = String(r.data?.["Owner Full Name"] ?? "").trim();
    const business = String(r.data?.["Business Name"] ?? "").trim();
    const at = liveAt.get(normalizeOwnerKey(owner));
    const bk = norm(business);
    if (!at || !bk || notifiedKeys.has(bk)) continue;
    waiting.set(bk, { business, owner, coach: String(r.data?.["Assigned"] ?? "").trim() || null, liveDay: dayKey(new Date(at)) });
  }
  if (!waiting.size) return { candidates: 0, notified: [] };

  // Cheap gate: anything new for those clients in the last few days?
  const { data: recent } = await svc
    .from("deposits").select("data, synced_at")
    .gte("synced_at", new Date(now.getTime() - MAX_AGE_DAYS * DAY).toISOString())
    .lte("synced_at", now.toISOString());
  const hitKeys = new Set(((recent ?? []) as Dep[]).map((d) => norm(d.data?.["Business Name"])).filter((k) => waiting.has(k)));
  if (!hitKeys.size) return { candidates: waiting.size, notified: [] };

  // Full history (paged — Supabase caps a read at 1,000 rows) to prove "first".
  const all: Dep[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await svc.from("deposits").select("data, synced_at").range(from, from + 999);
    all.push(...((data ?? []) as Dep[]));
    if (!data || data.length < 1000) break;
  }

  const notified: string[] = [];
  for (const bk of hitKeys) {
    const c = waiting.get(bk)!;
    const deps = all
      .filter((d) => norm(d.data?.["Business Name"]) === bk)
      .map((d) => ({ d, date: parseSheetDate(d.data?.["Date"]) }))
      // A date in the future is a typo in the sheet, not a payment.
      .filter((x): x is { d: Dep; date: Date } => !!x.date && x.date.getTime() <= now.getTime() + DAY);
    if (deps.some((x) => dayKey(x.date) < c.liveDay)) continue; // paid before go-live → not a new client
    deps.sort((a, b) => a.date.getTime() - b.date.getTime() || String(a.d.synced_at).localeCompare(String(b.d.synced_at)));
    const first = deps[0];
    if (!first || now.getTime() - first.date.getTime() > MAX_AGE_DAYS * DAY) continue;

    const who = String(first.d.data?.["Full Name"] ?? "").trim() || "A client";
    // The sheet's Date has no time; the row lands here within about a minute
    // of the payment, so its sync time is the payment time. A bulk re-sync
    // rewrites synced_at, so only trust it on the same day as the Date.
    const synced = first.d.synced_at ? new Date(first.d.synced_at) : null;
    const when = synced && dayKey(synced) === dayKey(first.date)
      ? `${synced.toLocaleString("en-US", { timeZone: AGENCY_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} PT`
      : first.date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const amount = String(first.d.data?.["Amount"] ?? "").trim();

    if (!opts.dryRun) {
      const { error } = await svc.from("notifications").insert({
        type: "first_deposit",
        title: `🎉 First deposit for ${c.business}!`,
        body: `${who}${amount ? ` paid ${amount}` : " paid their deposit"} — ${when}`,
        coach: c.coach,
        meta: { biz_key: bk, business: c.business, owner: c.owner, contact_name: who, deposit_date: dayKey(first.date), synced_at: first.d.synced_at },
      });
      if (error) { console.error("[first-deposit]", c.business, error.message); continue; }
    }
    notified.push(`${c.business}: ${who} — ${when}`);
  }
  return { candidates: waiting.size, notified };
}
