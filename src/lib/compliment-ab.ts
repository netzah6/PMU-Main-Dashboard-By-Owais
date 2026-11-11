import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

type Svc = ReturnType<typeof createServiceClient>;

/* Photo-compliment A/B test (owner, 11/11/2026). Artists disliked the AI's
   reply to a lead's photo ("Omg you are so beautiful, I can't wait to slay
   your Eyebrows! 😍"), so the slay CloseBot flow (v0.0.245a) now splits on the
   lead's phone: last digit 0-3 gets the NEW line ("Omg I love this!! I can
   already picture your new Eyebrows, you're going to be obsessed 😍"), every
   other lead keeps the OLD one. 0-3 holds two odd and two even digits, so both
   sides carry the same share of the deposit-ask test (odd last digit = B).

   CloseBot has no API, so the AI's actual text in each GHL thread decides the
   side, and the phone's last digit is kept next to it as a split check (a
   wrong side means the CloseBot switch broke). One row per conversation in
   compliment_ab_results, filled hourly by /api/cron/compliment-ab: the first
   compliment after the launch, the lead's first reply within a day (sorted
   happy / put-down by keywords), and whether the AI booked her or the deposit
   landed ("has been confirmed") within 8 days. compliment_ab_seen remembers
   threads already read, so a thread is fetched again only once it moves. */

export const COMP_AB_START = "2026-11-11T21:25:00Z";
export const COMP_AB_LOCATIONS_KEY = "compliment_ab_locations"; // { locations: string[] } read off the slay agent's Sources
const CURSOR_KEY = "compliment_ab_cursor";
const DEMO_LOCATION = "asaIf2fxizaCNJ71iywk";
const REPLY_MS = 86400_000;
const WINDOW_MS = 8 * 86400_000;
// Match the photo compliment itself, not any text with "beautiful" (win-back / check-in texts use it too).
const NEW_RX = /already picture your new|going to be obsessed/i;
const OLD_RX = /you are so beautiful,? i can.?t wait to slay|can.?t wait to slay your/i;
const PUTDOWN_RX = /too old|i'?m old|i am old|old lol|old haha|\bnot me\b|that'?s not me|eye ?bags|wrinkle|ugly|not (that |so )?(beautiful|pretty|cute)|no make ?up|excuse (my|the) (face|eyes?|bags|skin|look|mess|messy|pic|picture|photo|hair)|don'?t look (good|great|my best|like)|bad (pic|picture|photo|angle|lighting)|i look (tired|old|bad|terrible|awful|rough)/i;
const HAPPY_RX = /thank|thx|\bty\b|\baww+|so sweet|(you'?re|your|ur) (so )?(sweet|kind)|so kind|appreciate|\byay\b|you too|❤|♥|💕|💖|🥰|😍|😊|☺|🙏|🤗|😘|😁|🤭/i;
const LAUGH_RX = /\blol\b|\bhaha|\bomg\b|😂/i; // happy only when she isn't asking something
const BOOKED_RX = /i have you (down|booked|scheduled)|you'?re (all set|booked)|booked you|got you (down|booked|scheduled)|see you (on|then)/i;
const PAID_RX = /has been confirmed/i;

type Msg = { t: number; dir: string; type: string; body: string };
type Row = { conv_id: string; location_id: string; contact_id: string; line: string; phone_last: string | null; expected: string | null; sent_at: string; checked_at: string; final: boolean };

export function replyKind(body: string): "happy" | "putdown" | "other" {
  if (PUTDOWN_RX.test(body)) return "putdown";
  if (HAPPY_RX.test(body)) return "happy";
  if (LAUGH_RX.test(body) && !body.includes("?")) return "happy";
  return "other";
}

export async function compAbLocations(svc: Svc): Promise<string[]> {
  const { data } = await svc.from("app_settings").select("value").eq("key", COMP_AB_LOCATIONS_KEY).maybeSingle();
  return ((data?.value as { locations?: string[] } | null)?.locations ?? []).filter((l) => l !== DEMO_LOCATION);
}

async function allRows<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

export async function checkCompliments(svc: Svc, deadlineMs = 250_000) {
  const started = Date.now();
  const startMs = Date.parse(COMP_AB_START);
  if (started < startMs) return { skipped: "not started" };
  const locations = await compAbLocations(svc);
  const { data: cur } = await svc.from("app_settings").select("value").eq("key", CURSOR_KEY).maybeSingle();
  const scannedTo = Date.parse(((cur?.value as { scannedTo?: string } | null)?.scannedTo) ?? COMP_AB_START);
  const scanFrom = Math.max(startMs, scannedTo - 2 * 3600_000); // overlap so a slow hour is never skipped

  const known = new Map<string, Row>();
  for (const r of await allRows<Row>((f, t) => svc.from("compliment_ab_results")
    .select("conv_id, location_id, contact_id, line, phone_last, expected, sent_at, checked_at, final").order("conv_id").range(f, t))) known.set(r.conv_id, r);
  const seen = new Map<string, number>();
  for (const r of await allRows<{ conv_id: string; last_message_at: string }>((f, t) => svc.from("compliment_ab_seen")
    .select("conv_id, last_message_at").gte("last_message_at", new Date(scanFrom).toISOString()).order("conv_id").range(f, t))) seen.set(r.conv_id, Date.parse(r.last_message_at));

  const toks = new Map<string, string | null>();
  const tokenFor = async (loc: string) => {
    if (!toks.has(loc)) toks.set(loc, (await getAppLocationToken(loc).catch(() => ({ token: undefined }))).token ?? null);
    return toks.get(loc) ?? null;
  };
  const ghl = async (tok: string, path: string): Promise<Record<string, unknown> | null> => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`https://services.leadconnectorhq.com${path}`, {
          headers: { Authorization: `Bearer ${tok}`, Version: "2021-04-15", Accept: "application/json" }, signal: AbortSignal.timeout(20_000),
        });
        if (r.status === 429) {
          if (i === 2) return null;
          const after = Number(r.headers.get("retry-after"));
          await new Promise((z) => setTimeout(z, Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 2000 * (i + 1)));
          continue;
        }
        if (!r.ok) return null;
        return (await r.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  };

  type Todo = { conv: string; loc: string; contact: string; lastMs: number | null };
  let partial = false;

  // 1) Rows still open come first: re-read at 2 h, 8 h, then daily gaps.
  const now = Date.now();
  const recheck: Todo[] = [];
  for (const r of known.values()) {
    if (r.final) continue;
    const age = now - Date.parse(r.sent_at);
    const gap = age < 86400_000 ? 2 * 3600_000 : age < 3 * 86400_000 ? 8 * 3600_000 : 24 * 3600_000;
    if (now - Date.parse(r.checked_at) >= gap) recheck.push({ conv: r.conv_id, loc: r.location_id, contact: r.contact_id, lastMs: null });
  }
  const queued = new Set(recheck.map((x) => x.conv));

  // 2) Threads that moved since the last scan and weren't read at that point yet, per slay account.
  const byLoc = new Map<string, Todo[]>();
  let li = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (li < locations.length) {
      if (Date.now() - started > deadlineMs * 0.4) { partial = true; return; }
      const loc = locations[li++];
      try {
        const tok = await tokenFor(loc);
        if (!tok) continue;
        const s = await ghl(tok, `/conversations/search?locationId=${loc}&limit=100&sortBy=last_message_date&sort=desc`);
        const list: Todo[] = [];
        for (const c of ((s?.conversations ?? []) as { id: string; contactId: string; lastMessageDate?: number }[])) {
          const last = c.lastMessageDate ?? 0;
          const k = known.get(c.id);
          if (last < scanFrom || queued.has(c.id) || k?.final) continue;
          if ((seen.get(c.id) ?? -1) >= last) continue; // read already, hasn't moved
          if (k && Date.parse(k.checked_at) >= last) continue;
          list.push({ conv: c.id, loc, contact: c.contactId, lastMs: last });
        }
        if (list.length) byLoc.set(loc, list);
      } catch (e) {
        console.error("[compliment-ab] scan failed:", e instanceof Error ? e.message : e);
      }
    }
  }));
  // Interleave accounts so the 6 workers never hammer one location at once.
  const scan: Todo[] = [];
  const lists = [...byLoc.values()];
  for (let k = 0; lists.some((l) => k < l.length); k++) for (const l of lists) if (k < l.length) scan.push(l[k]);
  const items = [...recheck, ...scan];

  let checked = 0, saved = 0, failed = 0;
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < items.length) {
      if (Date.now() - started > deadlineMs) { partial = true; return; }
      const it = items[i++];
      const prev = known.get(it.conv);
      const touch = async (final = false) => {
        if (!prev) return;
        await svc.from("compliment_ab_results").update({ checked_at: new Date().toISOString(), ...(final ? { final: true } : {}) }).eq("conv_id", it.conv);
      };
      const tooOld = prev ? now - Date.parse(prev.sent_at) > WINDOW_MS : false;
      try {
        const tok = await tokenFor(it.loc);
        if (!tok) { await touch(tooOld); continue; }
        const mr = await ghl(tok, `/conversations/${it.conv}/messages?limit=100`);
        if (!mr) { await touch(tooOld); continue; }
        checked++;
        const raw = ((mr.messages as { messages?: Record<string, unknown>[] } | undefined)?.messages ?? []);
        const msgs: Msg[] = raw.map((m) => ({ t: Date.parse(String(m.dateAdded)), dir: String(m.direction ?? ""), type: String(m.messageType ?? ""), body: String(m.body ?? "") }))
          .filter((m) => Number.isFinite(m.t)).sort((a, b) => a.t - b.t);
        const comp = msgs.find((m) => m.dir === "outbound" && m.t >= startMs && (NEW_RX.test(m.body) || OLD_RX.test(m.body)));
        if (!comp) {
          if (prev) await touch(tooOld);
          else if (it.lastMs) await svc.from("compliment_ab_seen").upsert({ conv_id: it.conv, last_message_at: new Date(it.lastMs).toISOString(), checked_at: new Date().toISOString() });
          continue;
        }
        let phoneLast = prev?.phone_last ?? null;
        if (!prev) {
          const ct = await ghl(tok, `/contacts/${it.contact}`);
          if (!ct) continue; // try again next hour rather than store a row with no phone check
          const c = (ct.contact ?? {}) as { phone?: string; tags?: string[] };
          if ((c.tags ?? []).includes("claude-test")) continue;
          const digits = String(c.phone ?? "").replace(/\D/g, "");
          phoneLast = digits ? digits.slice(-1) : null;
        }
        const line = NEW_RX.test(comp.body) ? "new" : "old";
        const expected = phoneLast == null ? null : /[0-3]/.test(phoneLast) ? "new" : "old";
        /* Replied = any message back within a day (a photo counts); the kind
           comes from her first message WITH text, so a second photo landing
           after the compliment never hides her "thank you" / "excuse my bags". */
        const inbound = msgs.filter((m) => m.dir === "inbound" && !/REACTION/i.test(m.type) && m.t > comp.t && m.t < comp.t + REPLY_MS);
        const reply = inbound[0];
        const replyText = inbound.find((m) => m.body.trim());
        const after = msgs.filter((m) => m.dir === "outbound" && m.t > comp.t && m.t < comp.t + WINDOW_MS);
        const paid = after.some((m) => PAID_RX.test(m.body));
        const booked = paid || after.some((m) => BOOKED_RX.test(m.body));
        const final = paid || now - comp.t > WINDOW_MS;
        const { error } = await svc.from("compliment_ab_results").upsert({
          conv_id: it.conv, location_id: it.loc, contact_id: it.contact, line, phone_last: phoneLast, expected,
          sent_at: new Date(comp.t).toISOString(), reply_at: reply ? new Date(reply.t).toISOString() : null,
          reply_kind: reply ? (replyText ? replyKind(replyText.body) : "other") : null, booked, paid, checked_at: new Date().toISOString(), final,
        });
        if (error) { failed++; console.error("[compliment-ab] save failed:", error.message); } else saved++;
      } catch (e) {
        failed++;
        console.error("[compliment-ab] check failed:", e instanceof Error ? e.message : e);
      }
    }
  }));
  /* A partial run keeps the cursor: threads it did read are in
     compliment_ab_seen / compliment_ab_results, so the next run only does
     the rest instead of growing every hour. */
  if (!partial) await svc.from("app_settings").upsert({ key: CURSOR_KEY, value: { scannedTo: new Date(started).toISOString() } });
  return { locations: locations.length, rechecks: recheck.length, scanned: scan.length, checked, saved, failed, partial };
}
