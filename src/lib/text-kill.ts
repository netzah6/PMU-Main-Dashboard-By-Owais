import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

/* Kill Text (owner, 10/27/2026) — the twin of Kill % for calls (call-kill.ts):
   per sub-account, how often the AI dies because the artist texted a lead
   herself. GHL can't tell her texts from CloseBot's: both arrive as
   source "app" with her user id (Joanel / Jes Chuson thread, 10/21). The
   signal is CloseBot's own reaction — its "Bot Auto Shutoff" tags the lead
   "ai off" the moment an outbound text appears that it didn't write, and
   it never speaks again. So: for unpaid qualified leads that carry "ai off",
   read the thread, find the texts a person typed (a model reads them — the
   bot's style is unmistakable next to an artist's), and count the lead as
   killed when the AI fell silent after the first one.

   Kill Text % = dead / QUALIFIED over the last 30 days (owner, 10/27/2026;
   Kill Call uses 21), same population as Kill Call. A lead whose first takeover was a CALL
   belongs to Kill % and is skipped here. */

type Svc = ReturnType<typeof createServiceClient>;
const WINDOW_DAYS = 30;
const CLOSURE = /\bstop\b|not interested|no longer|already (did|done|booked elsewhere)|wrong number/i;
const AUTOMATED = /workflow|campaign|bulk|drip|automation|trigger/i;
const TEXT_TYPES = /SMS|FACEBOOK|INSTAGRAM|WHATSAPP|LIVE_CHAT|GMB|WEBCHAT/i;
const MODEL = process.env.TEXT_KILL_MODEL || "claude-opus-5-5";
const MAX_EVENTS = 60;

type Msg = { id: string; t: number; dir: string; type: string; body: string; source: string };
type Verdict = { human: string[] }; // ids of outbound texts a person typed
export type TextKillEvent = { contactId: string; name: string; at: string; message: string; ignored: boolean; reply?: string };

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

const SYSTEM = `You read a text-message thread between a permanent-makeup (PMU) studio and a lead. The studio's side is written by two senders who look identical in the data: an AI sales assistant, and the artist (studio owner) typing by hand. Your job: say which of the numbered studio messages the artist typed herself.
The AI assistant: polished, complete sentences, correct punctuation and capitalisation, often uses the lead's first name, offers specific times ("I have Wednesday 11/4 at 11:00 AM or…"), asks a closing question, sends reservation/deposit links, "just checking in" follow-ups, sometimes sends 2–3 near-identical messages within seconds.
The artist typing by hand: short, casual, lowercase or typos, slang, single words ("yes", "ok", "perfect!"), stray characters, personal details, mentions calling/DMs/her schedule or family, answers that don't sound scripted, often a reply to something the AI got wrong.
Reply with JSON only: {"human": [<numbers of the studio messages the artist typed>]} — an empty list when the AI wrote all of them. When unsure, leave the message out.`;

function threadText(msgs: Msg[], outIds: string[]): string {
  const num = new Map(outIds.map((id, i) => [id, i + 1]));
  return msgs.filter((m) => m.dir === "inbound" || num.has(m.id)).slice(-60).map((m) => {
    const when = new Date(m.t).toISOString().slice(5, 16).replace("T", " ");
    return m.dir === "inbound" ? `[${when}] LEAD: ${m.body.slice(0, 400)}` : `[${when}] STUDIO #${num.get(m.id)}: ${m.body.slice(0, 400)}`;
  }).join("\n");
}

async function whoTyped(client: Anthropic, msgs: Msg[], outIds: string[]): Promise<Verdict | null> {
  if (!outIds.length) return { human: [] };
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: "user", content: `Thread (oldest first):\n${threadText(msgs, outIds)}\n\nWhich studio messages did the artist type herself? JSON only.` }],
      betas: ["server-side-fallback-2026-07-01"],
      ...({ fallbacks: "default", output_config: { effort: "low" } } as Record<string, unknown>),
    });
    if (res.stop_reason === "refusal") return null;
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const nums = ((JSON.parse(m[0]) as { human?: unknown }).human ?? []) as unknown[];
    return { human: nums.map((n) => outIds[Number(n) - 1]).filter((x): x is string => !!x) };
  } catch {
    return null;
  }
}

export async function computeTextKillStats(svc: Svc, deadlineMs = 255_000): Promise<{ accounts: number; candidates: number; checked: number; classified: number; partial: boolean }> {
  const started = Date.now();
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 86400_000);

  type Lead = { slug: string; full_name: string; phone: string; ghl_contact_id: string | null; location_id: string; ghl_status: string; answers: Record<string, unknown> | null };
  const leads = await allRows<Lead>((f, t) =>
    svc.from("onebox_leads").select("slug, full_name, phone, ghl_contact_id, location_id, ghl_status, answers").gte("created_at", windowStart.toISOString()).range(f, t));
  const qualified = leads.filter((l) => !(l.answers ?? {}).disqualified).filter((l) => !/test/i.test(l.full_name ?? ""));
  const qualBySlug = new Map<string, { n: number; loc: string }>();
  for (const l of qualified) { const q = qualBySlug.get(l.slug) ?? { n: 0, loc: l.location_id }; q.n++; qualBySlug.set(l.slug, q); }

  // Unpaid leads CloseBot has switched off ("ai off" on the GHL contact).
  const active = qualified.filter((l) => l.ghl_status === "created" && l.ghl_contact_id);
  const offIds = new Set<string>();
  const ids = [...new Set(active.map((l) => l.ghl_contact_id as string))];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await svc.from("ghl_lead_status").select("contact_id").in("contact_id", ids.slice(i, i + 300)).eq("ai_off", true);
    for (const r of data ?? []) offIds.add(String(r.contact_id));
  }
  const cands = active.filter((l) => offIds.has(l.ghl_contact_id as string));

  const { data: sync } = await svc.from("ghl_sync_status").select("location_id, owner_key");
  const ownerByLoc = new Map((sync ?? []).map((s) => [s.location_id as string, String(s.owner_key ?? "")]));
  const cacheRows = await allRows<{ contact_id: string; last_message_id: string; verdict: Verdict }>((f, t) =>
    svc.from("text_kill_threads").select("contact_id, last_message_id, verdict").range(f, t));
  const cache = new Map(cacheRows.map((c) => [c.contact_id, c]));

  const toks = new Map<string, string | null>();
  const tokenFor = async (loc: string) => {
    if (!toks.has(loc)) toks.set(loc, (await getAppLocationToken(loc)).token ?? null);
    return toks.get(loc);
  };
  const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 }) : null;

  const acc = new Map<string, { texted: number; dead: number; ignored: number; events: TextKillEvent[] }>();
  const bump = (slug: string) => { const a = acc.get(slug) ?? { texted: 0, dead: 0, ignored: 0, events: [] }; acc.set(slug, a); return a; };
  let checked = 0, classified = 0, partial = false;
  const NOW = Date.now();

  async function checkLead(l: Lead) {
    const t = await tokenFor(l.location_id);
    if (!t || !l.ghl_contact_id) return;
    const H4 = { Authorization: `Bearer ${t}`, Version: "2021-04-15", Accept: "application/json" };
    const vr = await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${l.location_id}&contactId=${l.ghl_contact_id}`, { headers: H4 }).catch(() => null);
    if (!vr || !vr.ok) return;
    const conv = (((await vr.json()) as { conversations?: { id: string }[] }).conversations ?? [])[0];
    if (!conv) return;
    const mr = await fetch(`https://services.leadconnectorhq.com/conversations/${conv.id}/messages?limit=100`, { headers: { ...H4, Version: "2021-07-28" } }).catch(() => null);
    if (!mr || !mr.ok) return;
    const raw = ((await mr.json()) as { messages?: { messages?: Record<string, unknown>[] } }).messages?.messages ?? [];
    const msgs: Msg[] = raw
      .map((m) => ({ id: String(m.id), t: Date.parse(String(m.dateAdded)), dir: String(m.direction ?? ""), type: String(m.messageType ?? m.type ?? ""), body: String(m.body ?? "").trim(), source: String(m.source ?? "") }))
      .filter((m) => Number.isFinite(m.t) && !/ACTIVITY|COMMENT/i.test(m.type))
      .sort((a, b) => a.t - b.t);
    if (!msgs.length) return;
    checked++;
    // Outbound texts not sent by an automation: the AI's and the artist's.
    const outs = msgs.filter((m) => m.dir === "outbound" && TEXT_TYPES.test(m.type) && !AUTOMATED.test(m.source) && m.body);
    const lastId = msgs[msgs.length - 1].id;
    let verdict: Verdict | null = null;
    const hit = cache.get(l.ghl_contact_id);
    if (hit && hit.last_message_id === lastId) verdict = hit.verdict;
    else if (client) {
      if (Date.now() - started > deadlineMs) { partial = true; return; }
      verdict = await whoTyped(client, msgs, outs.map((m) => m.id));
      if (verdict) {
        classified++;
        await svc.from("text_kill_threads").upsert({ contact_id: l.ghl_contact_id, slug: l.slug, location_id: l.location_id, last_message_id: lastId, verdict, checked_at: new Date().toISOString() });
      }
    }
    if (!verdict) return;
    const human = new Set(verdict.human);
    const firstHuman = outs.find((m) => human.has(m.id));
    if (!firstHuman) return;
    // A call before her first text: that's Kill % (calls), not this column.
    const firstCall = msgs.find((m) => m.dir === "outbound" && /CALL/i.test(m.type));
    if (firstCall && firstCall.t < firstHuman.t) return;
    const a = bump(l.slug);
    a.texted++;
    // Killed = the AI never wrote again after her first text.
    const aiAfter = outs.some((m) => m.t > firstHuman.t && !human.has(m.id));
    if (aiAfter) return;
    a.dead++;
    const lastOut = msgs.filter((m) => m.dir === "outbound").map((m) => m.t).pop() ?? 0;
    const lastIn = msgs.filter((m) => m.dir === "inbound" && m.t > lastOut).pop();
    const ignored = !!lastIn && NOW - lastIn.t > 2 * 3600_000 && !CLOSURE.test(lastIn.body);
    if (ignored) a.ignored++;
    a.events.push({ contactId: l.ghl_contact_id, name: l.full_name, at: new Date(firstHuman.t).toISOString(), message: firstHuman.body.slice(0, 280), ignored, ...(ignored && lastIn ? { reply: lastIn.body.slice(0, 160) } : {}) });
  }

  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < cands.length) {
      if (Date.now() - started > deadlineMs) { partial = true; return; }
      await checkLead(cands[i++]).catch(() => undefined);
    }
  }));

  /* A partial run only warms the cache (the next run is faster); the
     column is rewritten from complete runs only, so it never undercounts. */
  if (partial) return { accounts: 0, candidates: cands.length, checked, classified, partial };
  const rows = [...qualBySlug.entries()].map(([slug, q]) => {
    const a = acc.get(slug) ?? { texted: 0, dead: 0, ignored: 0, events: [] };
    return {
      slug, owner_key: ownerByLoc.get(q.loc) ?? "", qualified: q.n, texted: a.texted, dead: a.dead, ignored: a.ignored,
      events: a.events.sort((x, y) => y.at.localeCompare(x.at)).slice(0, MAX_EVENTS),
      window_start: windowStart.toISOString().slice(0, 10), computed_at: new Date().toISOString(),
    };
  });
  await svc.from("text_kill_stats").delete().neq("slug", "");
  if (rows.length) await svc.from("text_kill_stats").upsert(rows, { onConflict: "slug" });
  return { accounts: rows.length, candidates: cands.length, checked, classified, partial };
}
