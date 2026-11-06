/* 🔁 Win-back tracker (owner, 11/06/2026: "I need to see a central place
   where I can track everything that we are doing here"). One read-only view
   of the whole reactivation effort:
     - former clients (winback_contacts): who was texted, who answered, who
       came back, who is still getting follow-ups, when the next one goes out
       and what it says;
     - people who had a demo (sales_demos): who closed and who did not — the
       next group to reach out to.
   Nothing here sends or changes anything. */
import { createServiceClient } from "@/lib/supabase/server";
import { messageFor, firstNameOf, type SequenceRow } from "@/lib/winback-sequence";
import { FOLLOWUP_TEXT } from "@/lib/winback-followup";

type Svc = ReturnType<typeof createServiceClient>;

export type TrackerStatus =
  | "joined"      // came back and is a client again
  | "interested"  // answered, still open
  | "said_no"     // answered no / asked us to stop
  | "following"   // texted, no answer yet, more messages coming
  | "no_answer"   // all four messages sent, never answered
  | "scheduled"   // approved, first text has a date
  | "picked"      // owner ticked her for the next blast (no date yet)
  | "not_yet"     // clean history, not texted and no date yet
  | "held"        // not contacting: the old chat ended tense / badly, or no phone
  | "removed";    // owner took her off the list, or she is a current client

export type TrackerPerson = {
  sheetRow: number; name: string; business: string | null; lastPaid: string | null; contactId: string | null;
  status: TrackerStatus; batchNo: number | null; textedAt: string | null; messagesSent: number;
  repliedAt: string | null;
  /** When the next message goes out (null = nothing automatic is planned). */
  nextAt: string | null;
  /** Short name of the next message, and its full text. */
  nextLabel: string | null; nextText: string | null;
  /** The extra "answered but didn't come back" follow-up, if one was sent. */
  followupAt: string | null; followupKind: "price" | "spots" | null; followupUntil: string | null;
  note: string | null;
  /** What the AI review said about how the old chat ended. */
  reviewNote: string | null;
  /** The owner may tick her for the next blast (she can be texted and isn't in a batch). */
  canPick: boolean;
};

export type DemoPerson = { key: string; picked: boolean; name: string; status: "closed" | "no_close" | "no_money"; demoDate: string | null; closer: string | null; year: number | null; alsoFormerClient: boolean };

export type Tracker = {
  people: TrackerPerson[];
  counts: Record<TrackerStatus, number> & { texted: number; answered: number };
  demos: { closed: DemoPerson[]; open: DemoPerson[] };
  generatedAt: string;
};

type Row = SequenceRow & { picked_at?: string | null; planned_send_at?: string | null; followup_sent_at?: string | null; followup_kind?: string | null; followup_until?: string | null };

const STEP_LABEL: Record<number, string> = {
  1: "First text (price question)",
  2: "Reminder text (day 3)",
  3: "Email with the offer (day 7)",
  4: "Last text (day 14)",
};

export function statusOf(r: Row): TrackerStatus {
  if (r.outcome === "won") return "joined";
  if (!r.active && !r.batch_no) return "removed";
  if (r.outcome === "lost") return "said_no";
  if (r.stopped_reason === "current_client") return "removed";
  if (r.batch_no) {
    if (r.stopped_reason === "opted_out") return "said_no";
    if (r.replied_at || r.stopped_reason === "human") return "interested";
    if (r.next_due_at) return "following";
    return "no_answer";
  }
  if (r.planned_send_at) return "scheduled";
  if (r.picked_at && canPick(r)) return "picked";
  const clean = r.review_verdict === "ok" || r.review_verdict === "no_chat";
  return clean && r.contact_id && !r.stopped_reason ? "not_yet" : "held";
}

/* She can go into a next blast: on the list, found in GHL with a phone, never
   asked us to stop, not a client, not already in a batch or scheduled. */
function canPick(r: Row): boolean {
  return r.active && !r.batch_no && !r.planned_send_at && !r.outcome && !!r.contact_id && !r.stopped_reason && r.review_verdict !== "opted_out";
}

function heldNote(r: Row): string | null {
  if (!r.active) return "Taken off the list";
  if (r.stopped_reason === "current_client") return "Current client";
  if (r.stopped_reason === "opted_out") return "Asked for no texts (do-not-disturb is on in GHL)";
  if (r.send_error) return r.send_error;
  if (!r.contact_id) return r.match_note || "Not found in GHL";
  if (r.review_verdict === "tense") return "Old chat ended tense";
  if (r.review_verdict === "bad") return "Old chat ended badly";
  if (r.review_verdict === "opted_out") return "Asked us not to text";
  if (!r.review_verdict) return "Chat not reviewed yet";
  return null;
}

export function toPerson(r: Row): TrackerPerson {
  const status = statusOf(r);
  const first = firstNameOf(null, r.owner_name);
  let nextAt: string | null = null, nextLabel: string | null = null, nextText: string | null = null;
  if (status === "following") {
    const step = (r.step ?? 0) + 1;
    nextAt = r.next_due_at; nextLabel = STEP_LABEL[step] ?? null; nextText = messageFor(step, r.offer, first).text;
  } else if (status === "scheduled") {
    nextAt = r.planned_send_at ?? null; nextLabel = STEP_LABEL[1]; nextText = messageFor(1, r.offer, first).text;
  }
  const kind = r.followup_kind === "price" || r.followup_kind === "spots" ? r.followup_kind : null;
  return {
    sheetRow: r.sheet_row, name: r.owner_name, business: r.business, lastPaid: r.last_paid, contactId: r.contact_id,
    status, batchNo: r.batch_no ?? null, textedAt: r.batch_started_at ?? null, messagesSent: r.batch_no ? r.step ?? 0 : 0,
    repliedAt: r.replied_at ?? null, nextAt, nextLabel, nextText,
    followupAt: r.followup_sent_at ?? null, followupKind: kind, followupUntil: r.followup_until ?? null,
    note: status === "held" || status === "removed" ? heldNote(r) : status === "not_yet" || status === "picked" ? r.send_error ?? null : null,
    reviewNote: r.review_note ?? null,
    canPick: canPick(r),
  };
}

/** The text of the extra follow-up, for the legend on the page. */
export const FOLLOWUP_LEGEND = { price: FOLLOWUP_TEXT.price.en, spots: FOLLOWUP_TEXT.spots.en };

const nameKey = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
// Sales sheet dates are DD/MM/YYYY.
function sheetDate(s: string): { iso: string | null; year: number | null } {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s ?? "").trim());
  if (!m) return { iso: null, year: null };
  return { iso: `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`, year: Number(m[3]) };
}

async function readAll<T>(svc: Svc, table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  // Paged: Supabase returns at most 1,000 rows per read.
  for (let off = 0; ; off += 1000) {
    const { data, error } = await svc.from(table).select(cols).order("sheet_row").range(off, off + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function buildTracker(svc: Svc = createServiceClient()): Promise<Tracker> {
  const rows = await readAll<Row>(svc, "winback_contacts", "*");
  const people = rows.map(toPerson);
  const counts = { joined: 0, interested: 0, said_no: 0, following: 0, no_answer: 0, scheduled: 0, picked: 0, not_yet: 0, held: 0, removed: 0, texted: 0, answered: 0 };
  for (const p of people) {
    counts[p.status]++;
    if (p.batchNo) { counts.texted++; if (p.repliedAt || p.status === "joined" || p.status === "said_no" || p.status === "interested") counts.answered++; }
  }

  // Demos: one line per person — closed wins over everything, else her latest demo.
  const former = new Set(rows.map((r) => nameKey(r.owner_name)));
  const demoRows = await readAll<{ data: Record<string, string>; sheet_row: number }>(svc, "sales_demos", "data, sheet_row");
  const { data: pickRows, error: pickErr } = await svc.from("winback_demo_picks").select("name_key");
  if (pickErr) throw new Error(pickErr.message);
  const picks = new Set((pickRows ?? []).map((r) => String(r.name_key)));
  const byName = new Map<string, DemoPerson>();
  for (const d of demoRows) {
    const name = String(d.data?.["Full Name"] ?? "").trim();
    const st = String(d.data?.Status ?? "").trim();
    const status: DemoPerson["status"] | null = /^closed$/i.test(st) || /deposit collected/i.test(st) ? "closed" : /no money/i.test(st) ? "no_money" : /^didn't close/i.test(st) ? "no_close" : null;
    if (!name || !status) continue;
    const key = nameKey(name);
    const { iso, year } = sheetDate(d.data?.Date);
    const prev = byName.get(key);
    if (prev?.status === "closed" && status !== "closed") continue;
    byName.set(key, { key, picked: picks.has(key), name, status, demoDate: iso, closer: String(d.data?.["Assigned Person"] ?? "").trim() || null, year, alsoFormerClient: former.has(key) });
  }
  const all = [...byName.values()].sort((a, b) => (b.demoDate ?? "").localeCompare(a.demoDate ?? ""));
  return {
    people, counts,
    demos: { closed: all.filter((d) => d.status === "closed"), open: all.filter((d) => d.status !== "closed") },
    generatedAt: new Date().toISOString(),
  };
}

/** Tick / untick people for the next blast. Nothing is sent: it only marks them. */
export async function setPicks(opts: { group: "former" | "demo"; keys: string[]; picked: boolean; by: string | null }, svc: Svc = createServiceClient()): Promise<{ changed: number }> {
  const keys = [...new Set(opts.keys)].slice(0, 1000);
  if (!keys.length) return { changed: 0 };
  if (opts.group === "former") {
    const rows = keys.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!rows.length) return { changed: 0 };
    let q = svc.from("winback_contacts").update({ picked_at: opts.picked ? new Date().toISOString() : null }).in("sheet_row", rows);
    // Only people who can still be texted and are not in a batch can be ticked.
    if (opts.picked) q = q.eq("active", true).is("batch_no", null).is("planned_send_at", null).is("outcome", null).is("stopped_reason", null).not("contact_id", "is", null).or("review_verdict.is.null,review_verdict.neq.opted_out");
    const { data, error } = await q.select("sheet_row");
    if (error) throw new Error(error.message);
    return { changed: data?.length ?? 0 };
  }
  if (!opts.picked) {
    let changed = 0;
    // In chunks: a long list of names would not fit in one request.
    for (let i = 0; i < keys.length; i += 100) {
      const { data, error } = await svc.from("winback_demo_picks").delete().in("name_key", keys.slice(i, i + 100)).select("name_key");
      if (error) throw new Error(error.message);
      changed += data?.length ?? 0;
    }
    return { changed };
  }
  // Demo people come from the sales sheet: keep a copy of what was ticked.
  const open = (await buildTracker(svc)).demos.open.filter((d) => keys.includes(d.key));
  if (!open.length) return { changed: 0 };
  const { error } = await svc.from("winback_demo_picks").upsert(
    open.map((d) => ({ name_key: d.key, name: d.name, demo_status: d.status, demo_date: d.demoDate, closer: d.closer, picked_by: opts.by })),
    { onConflict: "name_key", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
  return { changed: open.length };
}
