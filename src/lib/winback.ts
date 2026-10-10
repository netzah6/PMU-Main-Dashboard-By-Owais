import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { getSheetsClient, readSheetValues, resolveTabName } from "@/lib/sheets";
import { GHL_BASE } from "@/lib/ghl-tasks";
import { getThread, type PmuAccount, type ThreadMessage } from "@/lib/ghl-conversations";

/* Win-back (owner, 2026-10-10): former clients we are trying to bring back.
   The owner manages the list in the "Follow up To PPS" sheet — "Follow up /
   not" decides who is in, "Program" which offer they may hear (PPS or the
   normal monthly program, his call per client). The AI tab's 🔁 Win-back view
   lists only these people; every AI reply is a draft he approves or rewrites.
   Nothing in this file sends a message. */

export const WINBACK_SHEET_ID = "194tvBtKS3wpZ6cqjSdwHzj6B7yK5ohnRuWFq7z9tC8c";
export const WINBACK_TAG = "win-back-2026";

export type WinbackOffer = "pps" | "monthly";
export type WinbackRow = {
  sheet_row: number;
  owner_name: string;
  business: string | null;
  phone: string | null;
  email: string | null;
  last_paid: string | null;
  offer: WinbackOffer | null;
  contact_id: string | null;
  match_note: string | null;
  tagged_at: string | null;
  active: boolean;
  outcome: "won" | "lost" | null;
  review_verdict: ReviewVerdict | null;
  review_note: string | null;
  review_quote: string | null;
  reviewed_at: string | null;
};
export type ReviewVerdict = "ok" | "tense" | "bad" | "opted_out" | "no_chat";

// PPS terms agreed 2026-10-10: we keep the $50 booking deposit, $60 per show.
const OFFER_TEXT: Record<WinbackOffer | "none", string> = {
  pps: "Pay-per-show program: NO monthly fee. Their new clients put down a $50 deposit to book (that deposit covers us), and they pay $60 only when the client actually shows up for the first session. Touch-ups, upsells and referrals from those clients are 100% theirs.",
  monthly: "The regular monthly program. Since they left we upgraded a lot (AI that books clients 24/7, new funnels, deposits collected for them). Do NOT quote a monthly price in text — say we'll go over the numbers together.",
  none: "No offer is approved for this person yet. Do NOT mention any program, price or fee — keep the conversation warm, ask about their business, and leave the offer for later.",
};

/** Steering the reply engine gets for a win-back chat (added before any note the user typed). */
export function winbackInstructions(r: Pick<WinbackRow, "owner_name" | "business" | "last_paid" | "offer">): string {
  return [
    `This person is a FORMER client of ours (PMU Care ran their ads and bookings${r.last_paid ? `; last paid ${r.last_paid}` : ""}) — ${r.owner_name}${r.business ? ` of ${r.business}` : ""}. We are reaching out to win them back.`,
    `Approved offer: ${OFFER_TEXT[r.offer ?? "none"]}`,
    "How the conversation goes: if they're slow or want more clients, ask how many new brow clients a month would feel great, then present the offer. If they're busy and happy, be happy for them and leave the door open. If they had a bad experience with us, acknowledge it in one short line, say what changed, then the offer. If they're not interested, thank them warmly and stop — never push.",
    "The goal is a short call to set it up, but only invite them to a call when the call switch is on.",
  ].join("\n");
}

export async function getWinbackForContact(contactId: string): Promise<WinbackRow | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("winback_contacts").select("*").eq("contact_id", contactId).eq("active", true).maybeSingle();
  return (data as WinbackRow | null) ?? null;
}

// ─── Sheet → table → GHL tag ────────────────────────────────────────────────

const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
const clean = (v: unknown) => {
  const s = String(v ?? "").trim();
  // Paste debris seen in the sheet (2026-10-10): FALSE / #ERROR! cells.
  return !s || /^(false|true)$/i.test(s) || s.startsWith("#") ? "" : s;
};

function offerFrom(program: string): WinbackOffer | null {
  if (/pps|pay\s*per/i.test(program)) return "pps";
  if (/normal|monthly|retainer|regular/i.test(program)) return "monthly";
  return null;
}

type SheetPerson = Omit<WinbackRow, "contact_id" | "match_note" | "tagged_at" | "outcome" | "review_verdict" | "review_note" | "review_quote" | "reviewed_at">;

export async function readWinbackSheet(): Promise<SheetPerson[]> {
  const rows = await readSheetValues(WINBACK_SHEET_ID, "Sheet1", 0);
  const head = (rows[0] ?? []).map((h) => lower(h));
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const c = {
    n: col(/^#$/), follow: col(/follow/), program: col(/program/), owner: col(/^owner/),
    biz: col(/^business/), phone: col(/^phone/), email: col(/^email/), last: col(/last paid/),
  };
  if (c.n < 0 || c.follow < 0 || c.owner < 0) throw new Error('The sheet needs "#", "Follow up / not" and "Owner" columns');
  const out: SheetPerson[] = [];
  for (const r of rows.slice(1)) {
    const n = Number(r[c.n]);
    const owner = clean(r[c.owner]);
    if (!Number.isInteger(n) || !owner) continue;
    out.push({
      sheet_row: n,
      owner_name: owner,
      business: clean(r[c.biz]) || null,
      phone: clean(r[c.phone]) || null,
      email: clean(r[c.email]) || null,
      last_paid: clean(r[c.last]) || null,
      offer: c.program >= 0 ? offerFrom(String(r[c.program] ?? "")) : null,
      active: /follow/i.test(String(r[c.follow] ?? "")),
    });
  }
  return out;
}

type Contact = { id: string; email?: string | null; phone?: string | null };

// Find the person in PMU Bookings On Demand by email, then phone. Never creates
// a contact — someone who isn't there is listed as "not found" for the owner.
async function findContact(acct: PmuAccount, p: SheetPerson): Promise<{ contact: Contact | null; note: string }> {
  const H = { Authorization: `Bearer ${acct.token}`, Version: "2021-07-28", Accept: "application/json" };
  const wantEmail = lower(p.email);
  const phones = String(p.phone ?? "").split(/[,/]/).map(digits).map((d) => (d.length === 11 && d.startsWith("1") ? d.slice(1) : d)).filter((d) => d.length === 10);
  const tries: Array<["email" | "number", string]> = [
    ...(wantEmail ? [["email", wantEmail] as ["email", string]] : []),
    ...phones.map((d) => ["number", `+1${d}`] as ["number", string]),
  ];
  if (!tries.length) return { contact: null, note: "No phone or email in the sheet" };
  for (const [key, val] of tries) {
    const r = await fetch(`${GHL_BASE}/contacts/search/duplicate?locationId=${acct.locationId}&${key}=${encodeURIComponent(val)}`, { headers: H });
    if (r.status === 429) throw new Error("GHL rate limit — click Sync again in a minute");
    const c = r.ok ? ((await r.json()) as { contact?: Contact | null }).contact ?? null : null;
    if (!c) continue;
    const ok = key === "email" ? lower(c.email) === wantEmail : phones.some((d) => digits(c.phone).endsWith(d));
    if (ok) return { contact: c, note: `matched by ${key === "email" ? "email" : "phone"}` };
  }
  return { contact: null, note: "Not found in PMU Bookings On Demand by email or phone" };
}

async function setTag(acct: PmuAccount, contactId: string, add: boolean): Promise<boolean> {
  const r = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: add ? "POST" : "DELETE",
    headers: { Authorization: `Bearer ${acct.token}`, Version: "2021-07-28", "Content-Type": "application/json" },
    body: JSON.stringify({ tags: [WINBACK_TAG] }),
  }).catch(() => null);
  return !!r && r.ok;
}

export type SyncResult = { inSheet: number; followUp: number; tagged: number; untagged: number; notFound: number; remaining: number };

/* Idempotent and resumable: each run matches + tags only rows that still need
   it, within a time budget, so a second click finishes a big first sync. */
export async function syncWinback(acct: PmuAccount, opts: { budgetMs?: number; tag?: boolean } = {}): Promise<SyncResult> {
  const budgetMs = opts.budgetMs ?? 200_000;
  const tag = opts.tag !== false; // false = find people in GHL only (the chat review runs before any tag)
  const started = Date.now();
  const svc = createServiceClient();
  const people = await readWinbackSheet();
  const { data: existingRows } = await svc.from("winback_contacts").select("*");
  const existing = new Map(((existingRows ?? []) as WinbackRow[]).map((r) => [r.sheet_row, r]));

  // 1. Sheet facts (name, offer, in/out) land for everyone right away.
  const base = people.map((p) => {
    const e = existing.get(p.sheet_row);
    const sameIdentity = e && lower(e.email) === lower(p.email) && digits(e.phone) === digits(p.phone);
    return {
      ...p,
      contact_id: sameIdentity ? e!.contact_id : null,
      match_note: sameIdentity ? e!.match_note : null,
      tagged_at: sameIdentity ? e!.tagged_at : null,
      // A new phone/email is a new person to look at — review again.
      ...(sameIdentity ? {} : { review_verdict: null, review_note: null, review_quote: null, reviewed_at: null }),
      outcome: e?.outcome ?? null,
      synced_at: new Date().toISOString(),
    };
  });
  for (let i = 0; i < base.length; i += 200) {
    const { error } = await svc.from("winback_contacts").upsert(base.slice(i, i + 200), { onConflict: "sheet_row" });
    if (error) throw new Error(error.message);
  }

  // 2. Match + tag the "Follow Up" rows; untag rows flipped to "Not".
  // Someone who asked us to stop texting never gets the tag (the review finds them).
  const optedOut = (n: number) => existing.get(n)?.review_verdict === "opted_out";
  const todo = base.filter((r) => (r.active && !r.tagged_at && !optedOut(r.sheet_row) && (!r.match_note || (tag && !!r.contact_id))) || (tag && !r.active && r.tagged_at && r.contact_id));
  let tagged = 0, untagged = 0, done = 0;
  const queue = [...todo];
  const worker = async () => {
    while (queue.length && Date.now() - started < budgetMs) {
      const r = queue.shift()!;
      if (!r.active) {
        if (await setTag(acct, r.contact_id!, false)) {
          untagged++;
          await svc.from("winback_contacts").update({ tagged_at: null }).eq("sheet_row", r.sheet_row);
        }
        done++;
        continue;
      }
      const { contact, note } = r.contact_id && r.match_note ? { contact: { id: r.contact_id }, note: r.match_note } : await findContact(acct, r);
      const patch: Partial<WinbackRow> = { contact_id: contact?.id ?? null, match_note: note };
      if (contact && tag) {
        if (await setTag(acct, contact.id, true)) { patch.tagged_at = new Date().toISOString(); tagged++; }
        else patch.match_note = `${note} — tagging failed, will retry on the next sync`;
      }
      await svc.from("winback_contacts").update(patch).eq("sheet_row", r.sheet_row);
      done++;
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  const { data: after } = await svc.from("winback_contacts").select("active, contact_id, match_note");
  const rows = (after ?? []) as Array<{ active: boolean; contact_id: string | null; match_note: string | null }>;
  return {
    inSheet: people.length,
    followUp: people.filter((p) => p.active).length,
    tagged, untagged,
    notFound: rows.filter((r) => r.active && !r.contact_id && r.match_note).length,
    remaining: todo.length - done,
  };
}

// ─── Chat review: did we end on bad terms? ─────────────────────────────────
/* Before anyone is tagged (owner, 2026-10-10): read each Follow Up person's
   whole history with us in PMU Bookings On Demand and flag the ones who left
   angry, disputed, or asked us to stop. Read-only — no tags, no texts. */

const REVIEW_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

async function conversationIds(acct: PmuAccount, contactId: string): Promise<string[]> {
  const r = await fetch(`${GHL_BASE}/conversations/search?locationId=${acct.locationId}&contactId=${encodeURIComponent(contactId)}&limit=5`, {
    headers: { Authorization: `Bearer ${acct.token}`, Version: "2021-04-15", Accept: "application/json" },
  });
  if (r.status === 429) throw new Error("GHL rate limit — click Review again in a minute");
  if (!r.ok) return [];
  return (((await r.json()) as { conversations?: Array<{ id: string }> }).conversations ?? []).map((c) => String(c.id));
}

function transcriptOf(msgs: ThreadMessage[]): string {
  // Oldest → newest; the END of the relationship matters most, so keep the tail.
  const lines = msgs.map((m) => `[${(m.dateAdded ?? "").slice(0, 10)}] ${m.direction === "inbound" ? "CLIENT" : "US"} (${m.channel}): ${m.body.replace(/\s+/g, " ").slice(0, 600)}`);
  let out = lines.join("\n");
  if (out.length > 14000) out = "…earlier messages cut…\n" + out.slice(-14000);
  return out;
}

type Review = { verdict: Exclude<ReviewVerdict, "no_chat">; note: string; quote: string | null };

async function classifyEnding(anthropic: Anthropic, who: string, transcript: string): Promise<Review> {
  const res = await anthropic.messages.create({
    model: REVIEW_MODEL,
    max_tokens: 300,
    system: [
      "You review the full message history between a marketing agency (US) and a former CLIENT of theirs (a permanent-makeup artist who paid the agency for ads and bookings).",
      "The agency wants to invite this person back. Decide how the relationship ENDED, judging mostly by the last weeks of contact.",
      "verdict:",
      "- \"bad\": the client was angry or hostile, called it a scam / waste of money, demanded or disputed a refund, threatened a chargeback, bad review or legal action, insulted the team, or left with a serious complaint that was never resolved.",
      "- \"opted_out\": the client asked not to be contacted (STOP, unsubscribe, 'don't text me', 'remove me').",
      "- \"tense\": unhappy or disappointed (few leads, poor results, billing confusion) but civil, or it ended on an unresolved disagreement.",
      "- \"ok\": neutral or friendly ending (paused for money/season/personal reasons, just stopped replying, thanked the team).",
      "Automated texts from US (reminders, workflows) are not the relationship — focus on what real people said.",
      'Reply with ONLY JSON: {"verdict": "bad"|"opted_out"|"tense"|"ok", "note": string, "quote": string|null}.',
      "note = one short plain-English sentence on why (max 140 chars). quote = a short verbatim line from the CLIENT that shows it (max 160 chars), or null for ok.",
    ].join("\n"),
    messages: [{ role: "user", content: `Client: ${who}\n\n${transcript}` }],
  });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text) as Partial<Review>;
    const verdict = (["bad", "opted_out", "tense", "ok"] as const).find((v) => v === j.verdict) ?? "tense";
    return { verdict, note: String(j.note ?? "").slice(0, 200) || "No reason given", quote: j.quote ? String(j.quote).slice(0, 240) : null };
  } catch {
    return { verdict: "tense", note: "The AI's answer couldn't be read — open the chat to check", quote: null };
  }
}

export type ReviewResult = { followUp: number; matched: number; reviewed: number; flagged: number; remaining: number; notFound: number };

export async function reviewWinback(acct: PmuAccount, budgetMs = 230_000): Promise<ReviewResult> {
  const started = Date.now();
  // 1. Sheet → table and find everyone in GHL, WITHOUT tagging.
  await syncWinback(acct, { budgetMs: Math.min(120_000, budgetMs / 2), tag: false });
  const svc = createServiceClient();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { data } = await svc.from("winback_contacts").select("*").eq("active", true);
  const rows = (data ?? []) as WinbackRow[];
  const queue = rows.filter((r) => r.contact_id && !r.reviewed_at);

  // 2. Read and judge each person's history.
  let reviewed = 0;
  const worker = async () => {
    while (queue.length && Date.now() - started < budgetMs) {
      const r = queue.shift()!;
      const ids = await conversationIds(acct, r.contact_id!);
      const threads = await Promise.all(ids.slice(0, 3).map((id) => getThread(acct, id, { limit: 100, labelMedia: true }).catch(() => [])));
      const msgs = threads.flat().sort((a, b) => (a.dateAdded ?? "").localeCompare(b.dateAdded ?? ""));
      const patch: Partial<WinbackRow> = { reviewed_at: new Date().toISOString() };
      if (!msgs.some((m) => m.direction === "inbound")) {
        Object.assign(patch, { review_verdict: "no_chat", review_note: "Never wrote to us in PMU Bookings On Demand", review_quote: null });
      } else {
        const v = await classifyEnding(anthropic, `${r.owner_name}${r.business ? ` (${r.business})` : ""}`, transcriptOf(msgs));
        Object.assign(patch, { review_verdict: v.verdict, review_note: v.note, review_quote: v.quote });
      }
      await svc.from("winback_contacts").update(patch).eq("sheet_row", r.sheet_row);
      reviewed++;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  await writeRedFlags().catch((e) => { throw new Error(`Reviewed, but couldn't write the "Red flag" column (share the sheet as Editor): ${e instanceof Error ? e.message : e}`); });

  const { data: after } = await svc.from("winback_contacts").select("contact_id, match_note, reviewed_at, review_verdict").eq("active", true);
  const a = (after ?? []) as Array<{ contact_id: string | null; match_note: string | null; reviewed_at: string | null; review_verdict: string | null }>;
  return {
    followUp: a.length,
    matched: a.filter((x) => x.contact_id).length,
    reviewed,
    flagged: a.filter((x) => ["bad", "tense", "opted_out"].includes(x.review_verdict ?? "")).length,
    remaining: a.filter((x) => (x.contact_id && !x.reviewed_at) || !x.match_note).length,
    notFound: a.filter((x) => !x.contact_id && x.match_note).length,
  };
}

const RED_FLAG_LABEL: Record<ReviewVerdict, string> = {
  bad: "🚩 Ended badly",
  opted_out: "⛔ Asked us to stop",
  tense: "⚠ Unhappy",
  ok: "✅ No red flag",
  no_chat: "✅ No red flag (never chatted with us)",
};
const OUR_NOTE = /^(🚩|⛔|⚠|✅|❔)/;

/* Write each reviewed person's result into the sheet's "Red flag" column
   (owner, 2026-10-10). Rows are found by the "#" column (the sheet gets
   re-sorted), and a cell the owner typed himself is never overwritten — only
   empty cells and our own earlier notes. */
export async function writeRedFlags(): Promise<number> {
  const svc = createServiceClient();
  const { data } = await svc.from("winback_contacts").select("*").eq("active", true);
  const byNum = new Map(((data ?? []) as WinbackRow[]).map((r) => [r.sheet_row, r]));

  const values = await readSheetValues(WINBACK_SHEET_ID, "Sheet1", 0);
  const head = (values[0] ?? []).map((h) => lower(h));
  const nCol = head.findIndex((h) => /^#$/.test(h));
  const flagCol = head.findIndex((h) => /red\s*flag/.test(h));
  if (nCol < 0 || flagCol < 0) throw new Error('No "Red flag" column in the sheet');
  const tab = await resolveTabName(WINBACK_SHEET_ID, "Sheet1", 0);
  const colA1 = (i: number) => { let n = i + 1, out = ""; while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); } return out; };

  const updates: { range: string; values: string[][] }[] = [];
  values.slice(1).forEach((r, i) => {
    const n = Number(r[nCol]);
    const cur = String(r[flagCol] ?? "").trim();
    if (cur && !OUR_NOTE.test(cur)) return; // the owner's own note
    const w = byNum.get(n);
    let text = "";
    if (!w) return; // "Not" rows are left alone
    if (w.review_verdict) {
      text = RED_FLAG_LABEL[w.review_verdict];
      if (["bad", "opted_out", "tense"].includes(w.review_verdict)) {
        text += ` — ${w.review_note ?? ""}${w.review_quote ? ` (“${w.review_quote}”)` : ""}`;
      }
    } else if (!w.contact_id && w.match_note) {
      text = "❔ Not checked — not found in PMU Bookings On Demand";
    }
    if (text && text !== cur) updates.push({ range: `'${tab}'!${colA1(flagCol)}${i + 2}`, values: [[text]] });
  });
  if (!updates.length) return 0;
  const sheets = await getSheetsClient();
  for (let i = 0; i < updates.length; i += 200) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: WINBACK_SHEET_ID,
      requestBody: { valueInputOption: "RAW", data: updates.slice(i, i + 200) },
    });
  }
  return updates.length;
}
