import { createServiceClient } from "@/lib/supabase/server";
import { readSheetValues } from "@/lib/sheets";
import { GHL_BASE } from "@/lib/ghl-tasks";
import type { PmuAccount } from "@/lib/ghl-conversations";

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
};

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

type SheetPerson = Omit<WinbackRow, "contact_id" | "match_note" | "tagged_at" | "outcome">;

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
export async function syncWinback(acct: PmuAccount, budgetMs = 200_000): Promise<SyncResult> {
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
      outcome: e?.outcome ?? null,
      synced_at: new Date().toISOString(),
    };
  });
  for (let i = 0; i < base.length; i += 200) {
    const { error } = await svc.from("winback_contacts").upsert(base.slice(i, i + 200), { onConflict: "sheet_row" });
    if (error) throw new Error(error.message);
  }

  // 2. Match + tag the "Follow Up" rows; untag rows flipped to "Not".
  const todo = base.filter((r) => (r.active && !r.tagged_at && (!r.match_note || !!r.contact_id)) || (!r.active && r.tagged_at && r.contact_id));
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
      const { contact, note } = await findContact(acct, r);
      const patch: Partial<WinbackRow> = { contact_id: contact?.id ?? null, match_note: note };
      if (contact) {
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
