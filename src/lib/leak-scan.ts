import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";
import { listLeaks, saveLeak, mmdd, type Leak } from "@/lib/leak-tracker";

/* ── Nightly leak check (owner, 11/23/2026) ─────────────────────────────────
   "Something that scans every day all the leads and tells me how we can
   improve the system for all the artists" — only V3 clients, because the
   goal is more deposits.

   Every night (cron /api/cron/leak-scan, 00:00–04:55 PT, every 5 minutes):
   1. QUEUE: every chat in a LIVE V3 client's account with activity in the
      last 24 hours (from the synced conversations table).
   2. READ, ~30 chats per run: the chat's messages and the contact's tags
      are read LIVE from GoHighLevel. Paid leads ("fanbasis buyer") are
      skipped. A small model labels each unpaid chat: where it stopped, and
      either one of the KNOWN leaks (the Leaks tab), a NORMAL reason (said
      no, opted out, too early, test, not a lead), or OTHER with a short why.
   3. SUMMARY, once all chats are read: each known leak gets "last night:
      X chats in Y accounts"; the OTHER chats go to a bigger model that groups
      them, and a group seen in 3+ accounts and 5+ chats becomes a NEW leak on
      the tab (status "new", found by "nightly check", labelled as read from
      the chats only — not verified live yet). Nothing is ever changed in
      GoHighLevel or CloseBot, and no one is texted.
   State: app_settings "leakscan:run" (queue + labels), "leakscan:last"
   (the summary the tab shows). */

type Svc = SupabaseClient;
const RUN_KEY = "leakscan:run";
const LAST_KEY = "leakscan:last";
const READ_MODEL = process.env.LEAKSCAN_READ_MODEL || "claude-sonnet-5-5"; // 11/23: the small model missed a clear busy-later goodbye
const GROUP_MODEL = process.env.LEAKSCAN_GROUP_MODEL || "claude-opus-5-5";
const PAID_TAG = "fanbasis buyer";
const PER_RUN = 30;
const PARALLEL = 6;

type Item = { conv: string; loc: string; contact: string; biz: string };
type Label = {
  conv: string; loc: string; biz: string;
  paid?: boolean; gone?: boolean; error?: string;
  kind?: "known" | "normal" | "other" | "fine";
  leak?: string;          // known leak id
  why?: string;           // short, plain English
  quote?: string;         // the line that shows it (no names)
  stage?: string;
};
type Run = { day: string; built_at: string; items: Item[]; next: number; labels: Label[]; summarized_at?: string };
export type ScanSummary = {
  day: string; at: string; chats: number; read: number; paid: number; errors: number; gone?: number;
  normal: number; fine: number; known: Record<string, { chats: number; accounts: number }>;
  other: number; new_leaks: string[];
};

const ptDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const isV3 = (v: string) => v.toLowerCase().replace(/[^a-z0-9.]/g, "") === "v3";

async function getSetting<T>(svc: Svc, key: string): Promise<T | null> {
  const { data } = await svc.from("app_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value ?? null) as T | null;
}
async function putSetting(svc: Svc, key: string, value: unknown) {
  const { error } = await svc.from("app_settings").upsert({ key, value, updated_by: "nightly leak check", updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

/* Live V3 clients → their accounts → chats active in the last 24 hours. */
export async function buildQueue(svc: Svc, now = new Date()): Promise<Run> {
  const { data: rows } = await svc.from("client_program_rows").select("business_name, version, owner_name, client_status");
  const owners = new Map<string, string>();
  for (const r of (rows ?? []) as { business_name: string | null; version: string | null; owner_name: string | null; client_status: string | null }[]) {
    if (!isV3(String(r.version ?? "")) || String(r.client_status ?? "").trim().toLowerCase() !== "live") continue;
    const o = String(r.owner_name ?? "").trim().toLowerCase();
    if (o) owners.set(o, String(r.business_name ?? "").trim());
  }
  /* Chats whose last message was 24–48 hours ago: a day old, so the outcome
     shows (the 11/23 test called 5-hour-old chats "leaks" — too early). */
  const since = new Date(now.getTime() - 48 * 3600_000).toISOString();
  const until = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const items: Item[] = [];
  const keys = [...owners.keys()];
  for (let i = 0; i < keys.length; i += 50) {
    let from = 0;
    for (;;) {
      const { data, error } = await svc.from("ghl_conversations").select("id, location_id, contact_id, owner_key")
        .in("owner_key", keys.slice(i, i + 50)).gte("last_message_date", since).lt("last_message_date", until).range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const c of (data ?? []) as { id: string; location_id: string; contact_id: string; owner_key: string }[]) {
        if (c.contact_id) items.push({ conv: c.id, loc: c.location_id, contact: c.contact_id, biz: owners.get(c.owner_key) || c.owner_key });
      }
      if (!data || data.length < 1000) break;
      from += 1000;
    }
  }
  return { day: ptDay(new Date(now.getTime() - 36 * 3600_000)), built_at: now.toISOString(), items, next: 0, labels: [] };
}

type Msg = { body?: string; direction?: string; source?: string; messageType?: string; dateAdded?: string };

export async function readChat(it: Item): Promise<{ tags: string[]; transcript: string } | { error: string } | { gone: true }> {
  const tok = await getAppLocationToken(it.loc);
  if (!tok.token) return { error: tok.error ?? "no token" };
  const h = { Authorization: `Bearer ${tok.token}`, Accept: "application/json" };
  const [c, m] = await Promise.all([
    fetch(`https://services.leadconnectorhq.com/contacts/${it.contact}`, { headers: { ...h, Version: "2021-07-28" } }),
    fetch(`https://services.leadconnectorhq.com/conversations/${it.conv}/messages?limit=60`, { headers: { ...h, Version: "2021-04-15" } }),
  ]);
  // Deleted in GoHighLevel since the sync: nothing to read, not an error.
  if (m.status === 400 || m.status === 404 || c.status === 404) return { gone: true };
  if (!c.ok || !m.ok) return { error: `GoHighLevel ${c.status}/${m.status}` };
  const contact = ((await c.json()) as { contact?: { tags?: string[]; dndSettings?: { SMS?: { status?: string } } } }).contact;
  const msgs = (((await m.json()) as { messages?: { messages?: Msg[] } }).messages?.messages ?? []).slice().reverse();
  const lines: string[] = [];
  for (const x of msgs.slice(-45)) {
    const when = x.dateAdded ? new Date(x.dateAdded).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }) : "";
    const t = String(x.messageType ?? "");
    if (/ACTIVITY/.test(t)) { lines.push(`[${when}] (event) ${String(x.body ?? t).slice(0, 80)}`); continue; }
    if (/CALL/.test(t)) { lines.push(`[${when}] (${x.direction === "inbound" ? "lead called" : "business called"})`); continue; }
    const who = x.direction === "inbound" ? "LEAD" : x.source === "workflow" ? "AUTO TEXT" : "AI OR TEAM";
    const body = String(x.body ?? "").replace(/\s+/g, " ").trim().slice(0, 320);
    if (body) lines.push(`[${when}] ${who}${/EMAIL/.test(t) ? " (email)" : ""}: ${body}`);
  }
  const tags = contact?.tags ?? [];
  if (contact?.dndSettings?.SMS?.status === "active") tags.push("(texts blocked — DND)");
  return { tags, transcript: lines.join("\n") };
}

function readPrompt(known: Leak[]): string {
  return [
    "You check one lead's text chat for a permanent-makeup artist (a V3 client: an AI texts leads and asks for a $50 deposit to book). The goal is more paid deposits.",
    "The lead did NOT pay yet. Decide why the chat stopped short of a deposit.",
    "Answer with the JSON object only.",
    "kind rules:",
    "- \"fine\": the chat is still going normally (last message under ~24h ago and someone is expected to answer), or a deposit/booking is clearly in progress.",
    "- \"normal\": the LEAD ended it: said no / not interested / stop / too expensive after a good answer, opted out or texts are blocked (DND), wrong number, spam, test, not a real lead, or asked for a service the artist doesn't do.",
    "- NOT normal: the lead gave a reason to wait (busy, at work, driving, payday, after the holidays, \"I'll reach out when I'm ready\", \"let me think\") and the business side then said goodbye, closed the chat, or stopped following up. That is the busy-later leak if it is on the list.",
    "- NOT normal: the lead asked a question or replied and nobody (AI or team) answered it.",
    "- \"known\": the chat CLEARLY shows one of the known leaks below (give its id). If it only looks a bit like one, or you are not sure, use \"other\" and say why.",
    "- A lead who simply never answered the first texts is \"normal\" unless the business clearly did something wrong.",
    "- \"other\": the business side dropped the ball in a new way (the AI went silent, gave wrong info, never sent the link, a broken link, an automation contradicting the AI, etc.).",
    "Known leaks:",
    ...known.filter((l) => l.status !== "done").map((l) => `- ${l.id}: ${l.title} — ${l.short}${l.problem ? ` (${l.problem.replace(/\s+/g, " ").slice(0, 280)})` : ""}`),
  ].join("\n");
}

const LABEL_TOOL = {
  name: "label_chat",
  description: "Record why this unpaid lead chat stopped short of a deposit.",
  input_schema: {
    type: "object" as const,
    properties: {
      kind: { type: "string", enum: ["known", "normal", "other", "fine"] },
      leak: { type: "string", description: "Known leak id when kind is known, else empty" },
      stage: { type: "string", description: "Where it stopped, 3-6 words" },
      why: { type: "string", description: "One short plain sentence" },
      quote: { type: "string", description: "The one line that shows it, max 20 words, no names or numbers" },
    },
    required: ["kind", "leak", "stage", "why", "quote"],
    additionalProperties: false,
  },
};

const GROUP_TOOL = {
  name: "new_leaks",
  description: "Record the new leak patterns found in last night's chats.",
  input_schema: {
    type: "object" as const,
    properties: {
      leaks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" }, short: { type: "string" }, problem: { type: "string" }, change: { type: "string" },
            chats: { type: "array", items: { type: "integer" } },
          },
          required: ["title", "short", "problem", "change", "chats"],
          additionalProperties: false,
        },
      },
    },
    required: ["leaks"],
    additionalProperties: false,
  },
};

/* Structured output (11/23): the current Sonnet / Opus models refuse a
   forced tool call, so the answer is pinned with output_config.format
   instead. The installed SDK predates the field in its types, so it is
   passed through as-is. */
const jsonFormat = (schema: object) => ({ output_config: { format: { type: "json_schema", schema } } }) as Record<string, unknown>;
function readJson<T>(res: Anthropic.Message): T | null {
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  try { return JSON.parse(text) as T; } catch { return null; }
}

async function labelOne(ai: Anthropic, system: string, it: Item, known: Set<string>): Promise<Label> {
  const base: Label = { conv: it.conv, loc: it.loc, biz: it.biz };
  try {
    const r = await readChat(it);
    if ("gone" in r) return { ...base, gone: true };
    if ("error" in r) return { ...base, error: r.error };
    if (r.tags.some((t) => t.toLowerCase() === PAID_TAG)) return { ...base, paid: true };
    if (!r.transcript) return { ...base, kind: "fine", why: "no messages" };
    /* A forced tool call gives a clean object every time (plain-text JSON
       came back cut off or wrapped in prose for 11 of 12 test chats, 11/23). */
    const res = await ai.messages.create({
      model: READ_MODEL, max_tokens: 4000, system, // room for the model's own thinking
      ...jsonFormat(LABEL_TOOL.input_schema),
      messages: [{ role: "user", content: `Tags: ${r.tags.join(", ") || "none"}\nNow: ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT\n\nChat:\n${r.transcript}` }],
    });
    const j = readJson<{ kind?: string; leak?: string; stage?: string; why?: string; quote?: string }>(res);
    if (!j) return { ...base, error: `no answer (${res.stop_reason})` };
    const kind = (["known", "normal", "other", "fine"].includes(String(j.kind)) ? j.kind : "other") as Label["kind"];
    const leak = kind === "known" && j.leak && known.has(j.leak) ? j.leak : undefined;
    return { ...base, kind: kind === "known" && !leak ? "other" : kind, leak, stage: j.stage?.slice(0, 60), why: j.why?.slice(0, 200), quote: j.quote?.slice(0, 160) };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message.slice(0, 120) : "failed" };
  }
}

/* One cron tick: build tonight's queue if needed, read the next chats, and
   write the summary once everything is read. */
export async function leakScanTick(svc: Svc, opts: { now?: Date; budgetMs?: number } = {}): Promise<Record<string, unknown>> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const budget = opts.budgetMs ?? 240_000;
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: "ANTHROPIC_API_KEY not set" };
  let run = await getSetting<Run>(svc, RUN_KEY);
  const today = ptDay(new Date(now.getTime() - 36 * 3600_000)); // same day label as buildQueue
  if (!run || (run.day !== today && run.summarized_at) || (run.day !== today && Date.now() - Date.parse(run.built_at) > 20 * 3600_000)) {
    run = await buildQueue(svc, now);
    await putSetting(svc, RUN_KEY, run);
  }
  if (run.summarized_at) return { day: run.day, done: true };

  const leaks = await listLeaks(svc);
  const system = readPrompt(leaks);
  const knownIds = new Set(leaks.map((l) => l.id));
  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 });
  let read = 0;
  while (run.next < run.items.length && Date.now() - started < budget) {
    const slice = run.items.slice(run.next, run.next + PER_RUN);
    for (let i = 0; i < slice.length; i += PARALLEL) {
      run.labels.push(...(await Promise.all(slice.slice(i, i + PARALLEL).map((it) => labelOne(ai, system, it, knownIds)))));
    }
    run.next += slice.length;
    read += slice.length;
    await putSetting(svc, RUN_KEY, run);
  }
  if (run.next >= run.items.length) {
    const summary = await summarize(svc, run, leaks, budget - (Date.now() - started));
    run.summarized_at = new Date().toISOString();
    await putSetting(svc, RUN_KEY, run);
    return { day: run.day, read, summary };
  }
  return { day: run.day, read, left: run.items.length - run.next };
}

type NewLeak = { title: string; short: string; problem: string; change: string; chats: number[] };

async function summarize(svc: Svc, run: Run, leaks: Leak[], budgetMs: number): Promise<ScanSummary> {
  const L = run.labels;
  const known: ScanSummary["known"] = {};
  for (const l of L.filter((x) => x.kind === "known" && x.leak)) {
    const k = (known[l.leak!] ??= { chats: 0, accounts: 0 });
    k.chats++;
  }
  for (const id of Object.keys(known)) known[id].accounts = new Set(L.filter((x) => x.leak === id).map((x) => x.loc)).size;
  const others = L.filter((x) => x.kind === "other");
  const created: string[] = [];

  // Known leaks: how often each was seen last night.
  const day = mmdd(new Date(`${run.day}T12:00:00Z`));
  for (const lk of leaks) {
    const k = known[lk.id];
    const seen = k ? `Last night (${day}): ${k.chats} unpaid chat${k.chats === 1 ? "" : "s"} in ${k.accounts} account${k.accounts === 1 ? "" : "s"} looked like this.` : `Last night (${day}): not seen.`;
    if (lk.seen !== seen) await saveLeak(svc, { ...lk, seen }, "nightly leak check");
  }

  // New patterns: the bigger model groups the "other" chats.
  if (others.length >= 5 && budgetMs > 60_000) {
    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: Math.min(budgetMs - 10_000, 180_000) });
    const list = others.map((o, i) => `${i}. [${o.biz}] stopped at: ${o.stage ?? "?"} — ${o.why ?? ""}${o.quote ? ` — "${o.quote}"` : ""}`).join("\n");
    const res = await ai.messages.create({
      model: GROUP_MODEL, max_tokens: 16000,
      ...jsonFormat(GROUP_TOOL.input_schema),
      system: [
        "You review last night's unpaid lead chats for permanent-makeup artists (V3 clients: an AI texts leads and asks for a $50 deposit). Each line is one chat where the business side seemed to drop the ball in a way that is not on the known list.",
        "Group them into patterns. Keep ONLY patterns that show up in at least 3 different businesses and at least 5 chats, and that are NOT one of the known leaks below.",
        "For each pattern write, in very simple English (the owner's first language is not English; no tech words): title (max 8 words), short (one line), problem (2-3 sentences: what happens and why it costs deposits), change (one sentence: a fix idea to test). List the chat numbers.",
        "Answer with the JSON object only (an empty list if nothing qualifies).",
        "Known leaks:",
        ...leaks.map((l) => `- ${l.title} — ${l.short}`),
      ].join("\n"),
      messages: [{ role: "user", content: list }],
    });
    const found = readJson<{ leaks?: NewLeak[] }>(res)?.leaks ?? [];
    let order = Math.max(0, ...leaks.map((l) => l.order ?? 0));
    for (const n of found) {
      const chats = (n.chats ?? []).map((i) => others[i]).filter(Boolean);
      const accounts = new Set(chats.map((c) => c.loc)).size;
      if (chats.length < 5 || accounts < 3 || !n.title) continue; // check the rule ourselves
      const id = `night-${run.day}-${n.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
      if (leaks.some((l) => l.id === id)) continue;
      const examples = chats.slice(0, 6).map((c) => `• ${c.biz}: ${c.why ?? ""}${c.quote ? ` ("${c.quote}")` : ""}`).join("\n");
      await saveLeak(svc, {
        id, order: ++order, status: "new", area: "Found by the nightly check", found_by: "nightly check",
        title: n.title.slice(0, 120), short: n.short.slice(0, 200), problem: n.problem, change: `Fix idea: ${n.change}`,
        examples: `${chats.length} unpaid chats in ${accounts} accounts on ${day}. Examples:\n${examples}`,
        checked: "Read from the chats by the nightly check only. Not verified live in GoHighLevel yet — check before any fix.",
        next: "Claude checks it live, then asks you before any change.",
        updated: mmdd(),
      }, "nightly leak check");
      created.push(n.title);
    }
  }

  const summary: ScanSummary = {
    day: run.day, at: new Date().toISOString(), chats: run.items.length, read: L.filter((x) => !x.error && !x.gone).length,
    paid: L.filter((x) => x.paid).length, errors: L.filter((x) => x.error).length, gone: L.filter((x) => x.gone).length,
    normal: L.filter((x) => x.kind === "normal").length, fine: L.filter((x) => x.kind === "fine").length,
    known, other: others.length, new_leaks: created,
  };
  await putSetting(svc, LAST_KEY, summary);
  return summary;
}

export async function lastScan(svc: Svc): Promise<ScanSummary | null> {
  return getSetting<ScanSummary>(svc, LAST_KEY);
}

/* Test: label a few of tonight's chats without saving anything. */
export async function leakScanSample(svc: Svc, n: number, convIds: string[] = []): Promise<Label[]> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const run = await buildQueue(svc);
  const leaks = await listLeaks(svc);
  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 });
  // Named chats first (to re-test a known case), then an even spread of tonight's list.
  const named: Item[] = [];
  if (convIds.length) {
    const { data } = await svc.from("ghl_conversations").select("id, location_id, contact_id, owner_key").in("id", convIds.slice(0, 10));
    for (const c of (data ?? []) as { id: string; location_id: string; contact_id: string; owner_key: string }[]) named.push({ conv: c.id, loc: c.location_id, contact: c.contact_id, biz: c.owner_key });
  }
  const pick = [...named, ...run.items.filter((_, i) => i % Math.max(1, Math.floor(run.items.length / n)) === 0).slice(0, n)];
  const out: Label[] = [];
  for (let i = 0; i < pick.length; i += PARALLEL) {
    out.push(...(await Promise.all(pick.slice(i, i + PARALLEL).map((it) => labelOne(ai, readPrompt(leaks), it, new Set(leaks.map((l) => l.id)))))));
  }
  return out;
}
