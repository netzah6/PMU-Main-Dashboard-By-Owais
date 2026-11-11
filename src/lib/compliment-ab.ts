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
   landed ("has been confirmed") within 8 days. */

export const COMP_AB_START = "2026-11-11T21:25:00Z";
export const COMP_AB_LOCATIONS_KEY = "compliment_ab_locations"; // { locations: string[] } read off the slay agent's Sources
const CURSOR_KEY = "compliment_ab_cursor";
const DEMO_LOCATION = "asaIf2fxizaCNJ71iywk";
const REPLY_MS = 86400_000;
const WINDOW_MS = 8 * 86400_000;
const NEW_RX = /i love this|picture your new|going to be obsessed/i;
const OLD_RX = /so beautiful|can.?t wait to slay/i;
const PUTDOWN_RX = /too old|i'?m old|i am old|old lol|old haha|not me\b|that'?s not me|eye ?bags|wrinkle|ugly|not (that |so )?(beautiful|pretty|cute)|no make ?up|excuse (my|the)|hardly|don'?t look|bad (pic|picture|photo|angle|lighting)/i;
const HAPPY_RX = /thank|thx|\bty\b|aww|sweet|kind|appreciate|yay|you too|lol|haha|omg|❤|♥|💕|💖|🥰|😍|😊|☺|🙏|🤗|😘|😁|😂|🤭/i;
const BOOKED_RX = /i have you (down|booked|scheduled)|you'?re (all set|booked)|booked you|got you (down|booked|scheduled)|see you (on|then)/i;
const PAID_RX = /has been confirmed/i;

type Msg = { t: number; dir: string; type: string; body: string };
type Row = { conv_id: string; location_id: string; contact_id: string; line: string; phone_last: string | null; expected: string | null; sent_at: string; checked_at: string; final: boolean };

export function replyKind(body: string): "happy" | "putdown" | "other" {
  if (PUTDOWN_RX.test(body)) return "putdown";
  if (HAPPY_RX.test(body)) return "happy";
  return "other";
}

export async function compAbLocations(svc: Svc): Promise<string[]> {
  const { data } = await svc.from("app_settings").select("value").eq("key", COMP_AB_LOCATIONS_KEY).maybeSingle();
  return ((data?.value as { locations?: string[] } | null)?.locations ?? []).filter((l) => l !== DEMO_LOCATION);
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
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("compliment_ab_results")
      .select("conv_id, location_id, contact_id, line, phone_last, expected, sent_at, checked_at, final").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Row[]) known.set(r.conv_id, r);
    if (!data || data.length < 1000) break;
  }

  const toks = new Map<string, string | null>();
  const tokenFor = async (loc: string) => {
    if (!toks.has(loc)) toks.set(loc, (await getAppLocationToken(loc)).token ?? null);
    return toks.get(loc) ?? null;
  };
  const ghl = async (tok: string, path: string) => {
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`https://services.leadconnectorhq.com${path}`, { headers: { Authorization: `Bearer ${tok}`, Version: "2021-04-15", Accept: "application/json" } }).catch(() => null);
      if (r && r.status === 429) { await new Promise((z) => setTimeout(z, 2000 * (i + 1))); continue; }
      if (!r || !r.ok) return null;
      return r.json() as Promise<Record<string, unknown>>;
    }
    return null;
  };

  // 1) Conversations that moved since the last scan, per slay account.
  type Todo = { conv: string; loc: string; contact: string };
  const todo = new Map<string, Todo>();
  let partial = false;
  let li = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (li < locations.length) {
      if (Date.now() - started > deadlineMs * 0.4) { partial = true; return; }
      const loc = locations[li++];
      const tok = await tokenFor(loc);
      if (!tok) continue;
      const s = await ghl(tok, `/conversations/search?locationId=${loc}&limit=100&sortBy=last_message_date&sort=desc`);
      for (const c of ((s?.conversations ?? []) as { id: string; contactId: string; lastMessageDate?: number }[])) {
        if ((c.lastMessageDate ?? 0) < scanFrom) continue;
        const k = known.get(c.id);
        if (k?.final) continue;
        todo.set(c.id, { conv: c.id, loc, contact: c.contactId });
      }
    }
  }));
  // 2) Rows still open: re-read at 2 h, 8 h, then daily gaps even if nothing moved.
  const now = Date.now();
  for (const r of known.values()) {
    if (r.final || todo.has(r.conv_id)) continue;
    const age = now - Date.parse(r.sent_at);
    const gap = age < 86400_000 ? 2 * 3600_000 : age < 3 * 86400_000 ? 8 * 3600_000 : 24 * 3600_000;
    if (now - Date.parse(r.checked_at) >= gap) todo.set(r.conv_id, { conv: r.conv_id, loc: r.location_id, contact: r.contact_id });
  }

  let checked = 0, saved = 0;
  const items = [...todo.values()];
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < items.length) {
      if (Date.now() - started > deadlineMs) { partial = true; return; }
      const it = items[i++];
      try {
        const tok = await tokenFor(it.loc);
        if (!tok) continue;
        const mr = await ghl(tok, `/conversations/${it.conv}/messages?limit=100`);
        if (!mr) continue;
        checked++;
        const raw = ((mr.messages as { messages?: Record<string, unknown>[] } | undefined)?.messages ?? []);
        const msgs: Msg[] = raw.map((m) => ({ t: Date.parse(String(m.dateAdded)), dir: String(m.direction ?? ""), type: String(m.messageType ?? ""), body: String(m.body ?? "") }))
          .filter((m) => Number.isFinite(m.t)).sort((a, b) => a.t - b.t);
        const comp = msgs.find((m) => m.dir === "outbound" && m.t >= startMs && (NEW_RX.test(m.body) || OLD_RX.test(m.body)));
        if (!comp) continue;
        const prev = known.get(it.conv);
        let phoneLast = prev?.phone_last ?? null;
        let isTest = false;
        if (!prev) {
          const ct = await ghl(tok, `/contacts/${it.contact}`);
          const c = (ct?.contact ?? {}) as { phone?: string; tags?: string[] };
          isTest = (c.tags ?? []).includes("claude-test");
          const digits = String(c.phone ?? "").replace(/\D/g, "");
          phoneLast = digits ? digits.slice(-1) : null;
        }
        if (isTest) continue;
        const line = NEW_RX.test(comp.body) ? "new" : "old";
        const expected = phoneLast == null ? null : /[0-3]/.test(phoneLast) ? "new" : "old";
        const reply = msgs.find((m) => m.dir === "inbound" && !/REACTION/i.test(m.type) && m.t > comp.t && m.t < comp.t + REPLY_MS && (m.body.trim() || /SMS|WHATSAPP/i.test(m.type)));
        const after = msgs.filter((m) => m.dir === "outbound" && m.t > comp.t && m.t < comp.t + WINDOW_MS);
        const paid = after.some((m) => PAID_RX.test(m.body));
        const booked = paid || after.some((m) => BOOKED_RX.test(m.body));
        const final = paid || now - comp.t > WINDOW_MS;
        await svc.from("compliment_ab_results").upsert({
          conv_id: it.conv, location_id: it.loc, contact_id: it.contact, line, phone_last: phoneLast, expected,
          sent_at: new Date(comp.t).toISOString(), reply_at: reply ? new Date(reply.t).toISOString() : null,
          reply_kind: reply ? replyKind(reply.body) : null, booked, paid, checked_at: new Date().toISOString(), final,
        });
        saved++;
      } catch (e) {
        console.error("[compliment-ab] check failed:", e instanceof Error ? e.message : e);
      }
    }
  }));
  if (!partial) await svc.from("app_settings").upsert({ key: CURSOR_KEY, value: { scannedTo: new Date(started).toISOString() } });
  return { locations: locations.length, candidates: items.length, checked, saved, partial };
}
