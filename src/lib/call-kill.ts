import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

/* Kill Rate: per sub-account, how often the AI dies after an artist's
   outgoing call. Root cause (2026-09-22, Venita Lewis / Tangilaya Thomas):
   the "CC - Outgoing Call -> Google Sheet Webhook" workflow's step
   "Remove - CC- Funnel Survey -> Phone Number Only" un-enrolls the lead
   from the AI flow, so CloseBot never speaks again — even when the lead
   texts back. Measured fleet-wide: 34% of called leads died; a control
   group (INKredible, Angone, Permanent Perfection) sits at 0%.

   Kill %% (owner's definition): dead / QUALIFIED — the share of ALL
   qualified leads the account received in the window that lost the AI to
   a call, not merely the share of called leads.

   A lead counts as DEAD when its thread has an outgoing call and either
   (a) the lead's last inbound SMS came after our last outbound SMS and
   sat unanswered for 2+ hours (excluding closures: STOP / not
   interested), or (b) no outbound SMS at all since the last call for
   24+ hours. Population: qualified (non-disqualified) one-box leads
   still in "created" status whose phone appears in the outgoing-calls
   sheet inside the window. */

type Svc = ReturnType<typeof createServiceClient>;
const WINDOW_DAYS = 21;
const CLOSURE = /\bstop\b|not interested|no longer|already (did|done|booked elsewhere)|wrong number/i;

async function allRows<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function computeCallKillStats(svc: Svc, deadlineMs = 240_000): Promise<{ accounts: number; leadsChecked: number; partial: boolean }> {
  const started = Date.now();
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 86400_000);
  const sinceIso = windowStart.toISOString();

  // Called phone numbers inside the window (call sheet dates are D/M/YYYY).
  const callRows = await allRows<{ data: Record<string, unknown> }>((f, t) => svc.from("outgoing_calls").select("data").range(f, t));
  const calledP10 = new Set<string>();
  for (const r of callRows) {
    const d = r.data ?? {};
    const m = String(d["Date"] ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) continue;
    if (new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) < windowStart) continue;
    const p = String(d["Phone Number"] ?? "").replace(/\D/g, "").slice(-10);
    if (p.length === 10) calledP10.add(p);
  }

  type Lead = { slug: string; full_name: string; phone: string; ghl_contact_id: string | null; location_id: string; ghl_status: string; answers: Record<string, unknown> | null };
  const leads = await allRows<Lead>((f, t) =>
    svc.from("onebox_leads")
      .select("slug, full_name, phone, ghl_contact_id, location_id, ghl_status, answers")
      .gte("created_at", sinceIso)
      .range(f, t));
  const qualified = leads
    .filter((l) => !(l.answers ?? {}).disqualified)
    .filter((l) => !/test/i.test(l.full_name ?? ""));
  const qualBySlug = new Map<string, { n: number; loc: string }>();
  for (const l of qualified) {
    const q = qualBySlug.get(l.slug) ?? { n: 0, loc: l.location_id };
    q.n++; qualBySlug.set(l.slug, q);
  }
  // Only still-active (unpaid) called leads can be victims — a paid lead's
  // AI going quiet is expected, not a kill.
  const cands = qualified
    .filter((l) => l.ghl_status === "created" && l.ghl_contact_id)
    .filter((l) => calledP10.has(String(l.phone ?? "").replace(/\D/g, "").slice(-10)));

  const { data: sync } = await svc.from("ghl_sync_status").select("location_id, owner_key");
  const ownerByLoc = new Map((sync ?? []).map((s) => [s.location_id as string, String(s.owner_key ?? "")]));

  const toks = new Map<string, string | null>();
  const tokenFor = async (loc: string) => {
    if (!toks.has(loc)) toks.set(loc, (await getAppLocationToken(loc)).token ?? null);
    return toks.get(loc);
  };

  const acc = new Map<string, { owner_key: string; called: number; dead: number; ignored: number; closures: number }>();
  const bump = (slug: string, loc: string) => {
    const a = acc.get(slug) ?? { owner_key: ownerByLoc.get(loc) ?? "", called: 0, dead: 0, ignored: 0, closures: 0 };
    acc.set(slug, a);
    return a;
  };

  let checked = 0;
  let partial = false;
  const NOW = Date.now();
  async function checkLead(l: Lead) {
    const t = await tokenFor(l.location_id);
    if (!t) return;
    const H4 = { Authorization: `Bearer ${t}`, Version: "2021-04-15", Accept: "application/json" };
    const H7 = { ...H4, Version: "2021-07-28" };
    if (!l.ghl_contact_id) return;
    const vr = await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${l.location_id}&contactId=${l.ghl_contact_id}`, { headers: H4 }).catch(() => null);
    if (!vr || !vr.ok) return;
    const conv = (((await vr.json()) as { conversations?: { id: string }[] }).conversations ?? [])[0];
    if (!conv) return;
    const mr = await fetch(`https://services.leadconnectorhq.com/conversations/${conv.id}/messages?limit=80`, { headers: H7 }).catch(() => null);
    if (!mr || !mr.ok) return;
    const raw = ((await mr.json()) as { messages?: { messages?: { dateAdded?: string; direction?: string; messageType?: string; type?: string; body?: string }[] } }).messages?.messages ?? [];
    const msgs = raw
      .map((m) => ({ t: Date.parse(String(m.dateAdded)), dir: m.direction, type: String(m.messageType ?? m.type ?? ""), body: String(m.body ?? "") }))
      .filter((m) => Number.isFinite(m.t))
      .sort((a, b) => a.t - b.t);
    const calls = msgs.filter((m) => m.type.includes("CALL"));
    if (!calls.length) return; // call not visible in the thread — don't count
    checked++;
    const a = bump(l.slug, l.location_id);
    a.called++;
    const lastCall = calls[calls.length - 1].t;
    const outSms = msgs.filter((m) => m.dir === "outbound" && m.type.includes("SMS"));
    const inSms = msgs.filter((m) => m.dir === "inbound" && m.type.includes("SMS"));
    const lastOut = outSms.length ? outSms[outSms.length - 1].t : 0;
    const inAfterOut = inSms.filter((m) => m.t > lastOut);
    const lastIn = inAfterOut[inAfterOut.length - 1];
    if (lastIn && NOW - lastIn.t > 2 * 3600_000) {
      if (CLOSURE.test(lastIn.body)) { a.closures++; return; }
      a.dead++; a.ignored++;
    } else if (lastOut < lastCall && NOW - lastCall > 24 * 3600_000) {
      a.dead++;
    }
  }

  let i = 0;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (i < cands.length) {
        if (Date.now() - started > deadlineMs) { partial = true; return; }
        const l = cands[i++];
        await checkLead(l);
      }
    })
  );

  const rows = [...qualBySlug.entries()].map(([slug, q]) => {
    const a = acc.get(slug) ?? { owner_key: ownerByLoc.get(q.loc) ?? "", called: 0, dead: 0, ignored: 0, closures: 0 };
    return { slug, ...a, qualified: q.n, window_start: windowStart.toISOString().slice(0, 10), computed_at: new Date().toISOString() };
  });
  // Full refresh: an account whose calls aged out of the window must drop off.
  if (!partial) await svc.from("call_kill_stats").delete().neq("slug", "");
  if (rows.length) await svc.from("call_kill_stats").upsert(rows, { onConflict: "slug" });
  return { accounts: rows.length, leadsChecked: checked, partial };
}
