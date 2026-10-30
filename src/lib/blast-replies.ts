import Anthropic from "@anthropic-ai/sdk";
import { getAppLocationToken } from "@/lib/ghl-app";
import type { createServiceClient } from "@/lib/supabase/server";

type Svc = ReturnType<typeof createServiceClient>;

/* Blast results (owner 10/30/2026): after a text blast, show how many people
   replied POSITIVELY — interested / wants to book / asks price or times.
   "STOP", "not interested", "wrong number" do not count.

   Every 30 minutes we look at recipients texted in the last 7 days who have
   not replied yet, read their GHL conversation for an inbound text after our
   send, then sort each reply into positive / negative / neutral. */

const GHL = "https://services.leadconnectorhq.com";
const WINDOW_DAYS = 7;
const PER_RUN = 150;
const RECHECK_MIN = 25;
const MODEL = "claude-sonnet-4-5";

type Rec = { id: string; job_id: string; contact_id: string; sent_at: string; name: string | null };

async function gget(url: string, token: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Version: "2021-04-15", Accept: "application/json" } });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
  } catch { return null; }
}

/** Inbound texts from this contact after `since`, oldest first. */
async function repliesAfter(locationId: string, token: string, contactId: string, since: string): Promise<Array<{ at: string; text: string }>> {
  const s = await gget(`${GHL}/conversations/search?locationId=${locationId}&contactId=${contactId}&limit=5`, token);
  const convs = (s?.conversations as Array<{ id: string }> | undefined) ?? [];
  const out: Array<{ at: string; text: string }> = [];
  for (const c of convs) {
    const m = await gget(`${GHL}/conversations/${c.id}/messages?limit=30`, token);
    const msgs = ((m?.messages as { messages?: unknown[] } | undefined)?.messages ?? []) as Array<Record<string, unknown>>;
    for (const x of msgs) {
      const at = String(x.dateAdded ?? "");
      const body = String(x.body ?? "").trim();
      if (x.direction === "inbound" && body && at > since) out.push({ at, text: body });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

const NEGATIVE_RE = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|remove me|wrong number|not interested|no thanks?|no thank you)\b/i;

/** positive | negative | neutral for each reply (index-aligned). */
export async function classifyReplies(texts: string[]): Promise<Array<"positive" | "negative" | "neutral">> {
  const out = texts.map((t) => (NEGATIVE_RE.test(t) ? "negative" : null)) as Array<"positive" | "negative" | "neutral" | null>;
  const todo = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (todo.length && process.env.ANTHROPIC_API_KEY) {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const list = todo.map((i, k) => `${k + 1}. ${texts[i].slice(0, 300).replace(/\n/g, " ")}`).join("\n");
    try {
      const res = await anthropic.messages.create({
        model: MODEL, max_tokens: 400,
        messages: [{ role: "user", content:
          `A permanent-makeup artist sent a promotional text to past leads. Label each reply.\n` +
          `positive = interested: yes, wants to book, asks price / availability / details, says send info.\n` +
          `negative = not interested, stop, no, wrong number, annoyed, already done elsewhere.\n` +
          `neutral = anything else (who is this?, thanks, emoji only, unrelated).\n\n${list}\n\n` +
          `Answer with ONLY a JSON array of labels in order, e.g. ["positive","neutral"].` }],
      });
      const txt = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      const arr = JSON.parse(txt.slice(txt.indexOf("["), txt.lastIndexOf("]") + 1)) as string[];
      todo.forEach((i, k) => { const v = arr[k]; out[i] = v === "positive" || v === "negative" ? v : "neutral"; });
    } catch { /* leave unclassified → neutral below */ }
  }
  return out.map((v) => v ?? "neutral");
}

export async function scanBlastReplies(svc: Svc, windowDays = WINDOW_DAYS): Promise<{ checked: number; replied: number; positive: number }> {
  const since = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const recheck = new Date(Date.now() - RECHECK_MIN * 60_000).toISOString();
  const { data } = await svc.from("blast_recipients")
    .select("id, job_id, contact_id, sent_at, name")
    .eq("status", "sent").is("reply_at", null).gte("sent_at", since)
    .or(`reply_checked_at.is.null,reply_checked_at.lt.${recheck}`)
    .order("reply_checked_at", { ascending: true, nullsFirst: true })
    .limit(PER_RUN);
  const recs = (data ?? []) as Rec[];
  if (!recs.length) return { checked: 0, replied: 0, positive: 0 };

  const jobIds = [...new Set(recs.map((r) => r.job_id))];
  const { data: jobs } = await svc.from("blast_jobs").select("id, location_id").in("id", jobIds);
  const locOf = new Map(((jobs ?? []) as Array<{ id: string; location_id: string }>).map((j) => [j.id, j.location_id]));
  const tokens = new Map<string, string | null>();
  for (const loc of new Set(locOf.values())) tokens.set(loc, (await getAppLocationToken(loc)).token ?? null);

  const found: Array<{ rec: Rec; at: string; text: string }> = [];
  const now = new Date().toISOString();
  let next = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (next < recs.length) {
      const r = recs[next++];
      const loc = locOf.get(r.job_id); const tok = loc ? tokens.get(loc) : null;
      if (!loc || !tok) continue;
      const replies = await repliesAfter(loc, tok, r.contact_id, r.sent_at);
      if (replies.length) found.push({ rec: r, at: replies[0].at, text: replies.slice(0, 3).map((x) => x.text).join(" / ").slice(0, 600) });
    }
  }));
  await svc.from("blast_recipients").update({ reply_checked_at: now }).in("id", recs.map((r) => r.id));

  const kinds = await classifyReplies(found.map((f) => f.text));
  for (let i = 0; i < found.length; i++) {
    await svc.from("blast_recipients").update({ reply_at: found[i].at, reply_text: found[i].text, reply_kind: kinds[i] }).eq("id", found[i].rec.id);
  }
  // Refresh the per-blast counters for every blast touched this run.
  for (const jobId of new Set(found.map((f) => f.rec.job_id))) {
    const { count: total } = await svc.from("blast_recipients").select("*", { count: "exact", head: true }).eq("job_id", jobId).not("reply_at", "is", null);
    const { count: pos } = await svc.from("blast_recipients").select("*", { count: "exact", head: true }).eq("job_id", jobId).eq("reply_kind", "positive");
    await svc.from("blast_jobs").update({ replies_total: total ?? 0, replies_positive: pos ?? 0 }).eq("id", jobId);
  }
  return { checked: recs.length, replied: found.length, positive: kinds.filter((k) => k === "positive").length };
}
