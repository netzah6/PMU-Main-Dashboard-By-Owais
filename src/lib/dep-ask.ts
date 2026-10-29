import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

type Svc = ReturnType<typeof createServiceClient>;

/* Deposit-ask A/B test (owner, 10/28/2026). Pickers are tagged dep-ask-a/b
   at the slot step; the slay CloseBot flow sends b straight to "confirm your
   picked time + reservation link". CloseBot only speaks after the lead texts
   back, so the test is judged on the leads who texted back BEFORE paying —
   a lead who paid right on the page never met the AI on either side (owner,
   10/29/2026: "a client that booked with a deposit right away isn't a
   conversion in any of those").

   For each tagged contact this records the first text back after the pick
   (and before any payment) in dep_ask_results; the Funnels-tab card counts
   those leads and how many paid after. Both rules sit before the AI's first
   different word, so the split stays fair. */

export const DEP_ASK_START = "2026-10-28T23:50:00Z";
export const DEP_ASK_KEY = "dep_ask_slugs";
const PAID = new Set(["booked", "paid", "paid-not-booked", "paid-followup"]);
const WINDOW_MS = 8 * 86400_000; // a first reply later than this doesn't count
const INBOUND_TEXT = /SMS|WHATSAPP/i;

type Lead = {
  slug: string; location_id: string; ghl_contact_id: string | null; ghl_status: string;
  created_at: string; picked_time_at: string | null; paid_at: string | null; answers: Record<string, unknown> | null;
};
type Result = { contact_id: string; reply_at: string | null; paid: boolean; checked_at: string; final: boolean };

async function allRows<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

/** The slay-flow funnels the test counts (read off CloseBot's sources). */
export async function depAskSlugs(svc: Svc): Promise<string[] | undefined> {
  const { data } = await svc.from("app_settings").select("value").eq("key", DEP_ASK_KEY).maybeSingle();
  return (data?.value as { slugs?: string[] } | null)?.slugs;
}

export async function checkDepAskReplies(svc: Svc, deadlineMs = 250_000) {
  const started = Date.now();
  const slugs = new Set((await depAskSlugs(svc)) ?? []);
  const leads = (await allRows<Lead>((f, t) => svc.from("onebox_leads")
    .select("slug, location_id, ghl_contact_id, ghl_status, created_at, picked_time_at, paid_at, answers")
    .gte("picked_time_at", DEP_ASK_START).not("answers->>depAsk", "is", null).range(f, t)))
    .filter((l) => l.ghl_contact_id && slugs.has(l.slug));

  // One entry per contact (a lead can have several form rows).
  const byContact = new Map<string, Lead[]>();
  for (const l of leads) byContact.set(l.ghl_contact_id as string, [...(byContact.get(l.ghl_contact_id as string) ?? []), l]);
  const ids = [...byContact.keys()];
  const known = new Map<string, Result>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await svc.from("dep_ask_results").select("contact_id, reply_at, paid, checked_at, final").in("contact_id", ids.slice(i, i + 300));
    for (const r of (data ?? []) as Result[]) known.set(r.contact_id, r);
  }

  const toks = new Map<string, string | null>();
  const tokenFor = async (loc: string) => {
    if (!toks.has(loc)) toks.set(loc, (await getAppLocationToken(loc)).token ?? null);
    return toks.get(loc);
  };
  const now = Date.now();
  let checked = 0, saved = 0, partial = false;

  async function one(contactId: string) {
    const rows = byContact.get(contactId) ?? [];
    const prev = known.get(contactId);
    if (prev?.final) return;
    const latest = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const arm = String((latest.answers ?? {}).depAsk ?? "");
    if (arm !== "a" && arm !== "b") return;
    /* The pick that tagged them: stored since 10/29; before that the row's
       creation (the pick follows the survey within minutes), never earlier
       than the launch — an older lead re-picking starts at the launch. */
    const starts = rows.map((r) => {
      const at = String((r.answers ?? {}).depAskAt ?? "");
      return at ? Date.parse(at) : Math.max(Date.parse(r.created_at), Date.parse(DEP_ASK_START));
    });
    const startMs = Math.min(...starts);
    const paidRows = rows.filter((r) => PAID.has(r.ghl_status));
    const paid = paidRows.length > 0;
    const age = now - startMs;
    const base = { contact_id: contactId, location_id: latest.location_id, slug: latest.slug, arm, start_at: new Date(startMs).toISOString() };

    // Already texted back: only the payment can still change — no GHL call.
    if (prev?.reply_at) {
      if (paid || age > WINDOW_MS) {
        const stamped = paidRows.map((r) => (r.paid_at ? Date.parse(r.paid_at) : NaN)).filter(Number.isFinite);
        await svc.from("dep_ask_results").upsert({
          ...base, reply_at: prev.reply_at, paid, paid_at: stamped.length ? new Date(Math.min(...stamped)).toISOString() : null,
          checked_at: new Date().toISOString(), final: true,
        });
        saved++;
      }
      return;
    }
    // Not yet: look again at 2 h, then 8 h, then daily gaps as the lead ages.
    const gap = age < 86400_000 ? 2 * 3600_000 : age < 3 * 86400_000 ? 8 * 3600_000 : 24 * 3600_000;
    if (prev && !paid && now - Date.parse(prev.checked_at) < gap) return;

    const tok = await tokenFor(latest.location_id);
    if (!tok) return;
    const H = { Authorization: `Bearer ${tok}`, Version: "2021-04-15", Accept: "application/json" };
    const sr = await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${latest.location_id}&contactId=${contactId}`, { headers: H }).catch(() => null);
    if (!sr || !sr.ok) return;
    const conv = (((await sr.json()) as { conversations?: { id: string }[] }).conversations ?? [])[0];
    let msgs: { t: number; dir: string; type: string; body: string }[] = [];
    if (conv) {
      const mr = await fetch(`https://services.leadconnectorhq.com/conversations/${conv.id}/messages?limit=100`, { headers: H }).catch(() => null);
      if (!mr || !mr.ok) return;
      const raw = ((await mr.json()) as { messages?: { messages?: Record<string, unknown>[] } }).messages?.messages ?? [];
      msgs = raw.map((m) => ({ t: Date.parse(String(m.dateAdded)), dir: String(m.direction ?? ""), type: String(m.messageType ?? ""), body: String(m.body ?? "") }))
        .filter((m) => Number.isFinite(m.t)).sort((a, b) => a.t - b.t);
    }
    checked++;
    /* When they paid: the book route stamps it since 10/29. Earlier payers:
       the "your appointment has been confirmed" text the deposit triggers
       (the AI's own bookings stay unconfirmed until the deposit lands);
       failing both, the pick itself — paid on the page. */
    let paidMs: number | null = null;
    if (paid) {
      const stamped = paidRows.map((r) => (r.paid_at ? Date.parse(r.paid_at) : NaN)).filter(Number.isFinite);
      const confirmed = msgs.find((m) => m.dir === "outbound" && /has been confirmed/i.test(m.body));
      paidMs = stamped.length ? Math.min(...stamped)
        : confirmed ? confirmed.t
        : Date.parse(latest.picked_time_at ?? latest.created_at);
    }
    const reply = msgs.find((m) => m.dir === "inbound" && INBOUND_TEXT.test(m.type) && !/REACTION/i.test(m.type)
      && m.t >= startMs && m.t < startMs + WINDOW_MS && (paidMs == null || m.t < paidMs));
    const final = paid || age > WINDOW_MS;
    await svc.from("dep_ask_results").upsert({
      ...base, reply_at: reply ? new Date(reply.t).toISOString() : null, paid,
      paid_at: paidMs ? new Date(paidMs).toISOString() : null, checked_at: new Date().toISOString(), final,
    });
    saved++;
  }

  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < ids.length) {
      if (Date.now() - started > deadlineMs) { partial = true; return; }
      await one(ids[i++]).catch((e) => console.error("[dep-ask] check failed:", e instanceof Error ? e.message : e));
    }
  }));
  return { contacts: ids.length, checked, saved, partial };
}
