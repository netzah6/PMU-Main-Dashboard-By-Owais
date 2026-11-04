import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { getPpaRoster, type V3Client } from "@/lib/ppa";
import { getAppLocationToken } from "@/lib/ghl-app";

// ── Session check: did the session really happen? ────────────────────────────
// Owner, 11/03/2026: pay-per-show bills SESSIONS DONE, including leads the
// artist books on her own end — so before Monday's auto-charge, the AI reads
// the chat of everything that could be billed (or missed) without proof:
//
//   deposit   past-due deposit appointments (date passed, stage never moved)
//   calendar  past no-deposit appointments on the artist's GHL calendar
//   stage     leads sitting in "Deposit Collected" with NO deposit on record
//             and no calendar appointment — booked on the artist's end
//   chat      bookings the chat scan found that nobody reviewed yet
//
// Verdicts move money only the way a human reviewer would:
//   deposit/calendar  no_show / cancelled → voided (reason on the billing tab);
//                     not_yet (moved to a later date) → held, re-checked next
//                     Sunday; done / unsure → stay billable (the existing
//                     past-date policy).
//   stage/chat        done → billed as a chat:… charge the Monday auto-charge
//                     collects; anything else → nothing billed (re-checked
//                     next Sunday unless it's a final no-show / cancel).
// Every decision is logged in pps_session_checks with the AI's reason.

const GHL_BASE = "https://services.leadconnectorhq.com";
const CONV_VERSION = "2021-04-15";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const CHECKER = "AI session check";
const DEFAULT_START = "2026-08-01";
const DEPOSIT_STAGE = /deposit\s*collected/i;

type Kind = "deposit" | "calendar" | "stage" | "chat";
type Verdict = "done" | "no_show" | "cancelled" | "not_yet" | "unsure";

interface Candidate {
  key: string;               // pps_session_checks.check_key
  kind: Kind;
  client: V3Client;
  apptId: string | null;     // existing ppa_charges key (deposit / calendar)
  contactId: string | null;
  locationId: string | null;
  conversationId: string | null;
  contactName: string | null;
  email: string | null;
  apptTime: string | null;
  stage: string | null;
}

interface Check { verdict: Verdict; session_date: string | null; reason: string; evidence: string | null }

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Version: CONV_VERSION, Accept: "application/json" };
}

const normName = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

async function conversationFor(c: Candidate, token: string): Promise<string | null> {
  if (c.conversationId) return c.conversationId;
  if (!c.contactId || !c.locationId) return null;
  const r = await fetch(`${GHL_BASE}/conversations/search?locationId=${c.locationId}&contactId=${c.contactId}&limit=1`, { headers: authHeaders(token) });
  if (!r.ok) return null;
  const j = (await r.json()) as { conversations?: Array<{ id?: string }> };
  return j.conversations?.[0]?.id ?? null;
}

// Oldest-first, dated, last 60 text messages — the dates matter here: the AI
// has to tell "see you Friday" before the appointment from "thank you, love
// my brows" after it.
async function datedThread(conversationId: string, token: string): Promise<string> {
  const r = await fetch(`${GHL_BASE}/conversations/${conversationId}/messages?limit=100`, { headers: authHeaders(token) });
  if (!r.ok) return "";
  const j = (await r.json()) as { messages?: { messages?: Array<Record<string, unknown>> } };
  return (j.messages?.messages ?? [])
    .filter((m) => String(m.body ?? "").trim())
    .reverse()
    .slice(-60)
    .map((m) => {
      const when = String(m.dateAdded ?? "").slice(0, 16).replace("T", " ");
      const who = String(m.direction ?? "") === "inbound" ? "Lead" : "Artist";
      return `[${when}] ${who}: ${String(m.body).slice(0, 500)}`;
    })
    .join("\n");
}

async function judge(anthropic: Anthropic, c: Candidate, transcript: string, appts: string): Promise<Check> {
  const today = new Date().toISOString().slice(0, 10);
  const context = [
    `Client of the artist: ${c.contactName ?? "unknown"}`,
    c.stage ? `Pipeline stage: ${c.stage}` : null,
    c.apptTime ? `Appointment on record: ${c.apptTime.slice(0, 16).replace("T", " ")} UTC` : "No appointment date on record.",
    appts ? `Calendar history:\n${appts}` : null,
  ].filter(Boolean).join("\n");
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 350,
    system: [
      `Today's date is ${today}.`,
      "You check the SMS/DM conversation between a permanent-makeup artist and her client to decide whether a SESSION (the actual service appointment, not a consultation call) has ALREADY HAPPENED.",
      "Verdicts:",
      "- done: clear sign the session took place (thanks/aftercare/healing/touch-up talk after the date, photos of results, 'see you at your touch-up', paid the balance, or the appointment date passed with confirmations right before it and nothing suggesting it was missed).",
      "- no_show: the client did not come (artist asks where she is, 'missed you today', no reply after the slot).",
      "- cancelled: the client or artist cancelled and nothing was rebooked.",
      "- not_yet: the session is booked or moved to a date that has not come yet.",
      "- unsure: not enough in the chat to tell.",
      "Be strict about 'done' — this decides whether the artist is billed.",
      'Reply with ONLY a JSON object: {"verdict": "done"|"no_show"|"cancelled"|"not_yet"|"unsure", "session_date": "YYYY-MM-DD"|null, "reason": string, "evidence": string|null}.',
      "\"reason\" = one short plain-English sentence. \"evidence\" = a SHORT verbatim quote (max 200 chars). \"session_date\" = the day the session happened or is booked for, if known.",
    ].join("\n"),
    messages: [{ role: "user", content: `${context}\n\nConversation:\n${transcript.slice(-14000) || "(no messages)"}` }],
  });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text) as Partial<Check>;
    const verdicts: Verdict[] = ["done", "no_show", "cancelled", "not_yet", "unsure"];
    const verdict = verdicts.includes(j.verdict as Verdict) ? (j.verdict as Verdict) : "unsure";
    const sd = typeof j.session_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(j.session_date) ? j.session_date : null;
    return { verdict, session_date: sd, reason: String(j.reason ?? "").slice(0, 300), evidence: j.evidence ? String(j.evidence).slice(0, 300) : null };
  } catch {
    return { verdict: "unsure", session_date: null, reason: "AI reply could not be read.", evidence: null };
  }
}

// Page past Supabase's 1,000-row cap.
async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await page(from, from + 999);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export interface SessionCheckSummary {
  candidates: number;
  checked: number;
  billed: number;
  voided: number;
  held: number;
  unchanged: number;
  partial: boolean;
  errors: string[];
}

type ChargeRow = { appt_id: string; charged: boolean | null; excluded: boolean | null; exclude_reason: string | null; excluded_by: string | null };

export async function verifySessions(deadlineMs = 240_000, ownerKeyFilter?: string): Promise<SessionCheckSummary> {
  const started = Date.now();
  const svc = createServiceClient();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { clients: fullRoster } = await getPpaRoster();
  const ownerKeys0 = fullRoster.map((c) => c.ownerKey).filter((k) => !ownerKeyFilter || k === ownerKeyFilter);

  const { data: cfgRows } = await svc.from("ppa_config").select("owner_key, fee_per_appt, billing_exempt, pps_start").in("owner_key", ownerKeys0);
  const cfgBy = new Map<string, { fee: number | null; exempt: boolean; start: string }>();
  for (const r of (cfgRows ?? []) as Array<{ owner_key: string; fee_per_appt: number | null; billing_exempt: boolean | null; pps_start: string | null }>)
    cfgBy.set(r.owner_key, { fee: r.fee_per_appt == null ? null : Number(r.fee_per_appt), exempt: !!r.billing_exempt, start: r.pps_start ?? DEFAULT_START });
  const roster = fullRoster.filter((c) => ownerKeys0.includes(c.ownerKey) && !cfgBy.get(c.ownerKey)?.exempt);
  const byKey = new Map(roster.map((c) => [c.ownerKey, c]));
  const ownerKeys = roster.map((c) => c.ownerKey);
  const feeFor = (c: V3Client) => c.sheetFee ?? cfgBy.get(c.ownerKey)?.fee ?? 30;
  const startFor = (k: string) => cfgBy.get(k)?.start ?? DEFAULT_START;

  const [billRes, chgRes, depRes, calRes, sbRes, flagRes, prevRes] = await Promise.all([
    svc.from("ppa_deposit_billing").select("appt_id, owner_key, stage_name, start_time, charge_status").in("owner_key", ownerKeys).eq("charge_status", "past_due"),
    svc.from("ppa_charges").select("appt_id, charged, excluded, exclude_reason, excluded_by").in("owner_key", ownerKeys),
    allRows<{ appt_id: string; biz_norm: string; contact_name: string | null; email: string | null }>((a, b) =>
      svc.from("ppa_deposit_rows").select("appt_id, biz_norm, contact_name, email").in("biz_norm", roster.map((c) => c.bizNorm).filter(Boolean)).range(a, b)),
    svc.from("ppa_calendar_booked").select("appt_id, owner_key, contact_id, contact_name, email, start_time").in("owner_key", ownerKeys),
    allRows<{ contact_id: string | null }>((a, b) => svc.from("ppa_selfbooked").select("contact_id").in("owner_key", ownerKeys).range(a, b)),
    svc.from("ppa_chat_flags").select("conversation_id, owner_key, location_id, contact_id, contact_name, detected_date, scanned_at")
      .in("owner_key", ownerKeys).eq("verdict", "booked").eq("dismissed", false).eq("billed", false),
    svc.from("pps_session_checks").select("check_key, verdict").in("owner_key", ownerKeys),
  ]);
  const chgBy = new Map<string, ChargeRow>();
  for (const r of (chgRes.data ?? []) as ChargeRow[]) chgBy.set(r.appt_id, r);
  // Our own holds come back each week; anyone else's decision is final.
  const open = (apptId: string) => {
    const ch = chgBy.get(apptId);
    if (!ch) return true;
    if (ch.charged) return false;
    return !ch.excluded || (ch.excluded_by === CHECKER && ch.exclude_reason === "ai_check");
  };
  const prevBy = new Map<string, string>();
  for (const r of (prevRes.data ?? []) as Array<{ check_key: string; verdict: string }>) prevBy.set(r.check_key, r.verdict);
  const finalBefore = (key: string) => ["no_show", "cancelled"].includes(prevBy.get(key) ?? "");

  const now = Date.now();
  const cands: Candidate[] = [];

  // (a) past-due deposit appointments → find the GHL contact by email, then name.
  const depBy = new Map<string, { contact_name: string | null; email: string | null }>();
  // Deposit names/emails per client — a lead whose deposit row never linked
  // to her GHL contact must not be billed a second time from her stage.
  const depNames = new Map<string, Set<string>>();
  for (const r of depRes) {
    depBy.set(r.appt_id, r);
    const set = depNames.get(r.biz_norm) ?? new Set<string>();
    if (normName(r.contact_name)) set.add(normName(r.contact_name));
    if (r.email) set.add(r.email.trim().toLowerCase());
    depNames.set(r.biz_norm, set);
  }
  for (const b of (billRes.data ?? []) as Array<{ appt_id: string; owner_key: string; stage_name: string | null; start_time: string | null }>) {
    const client = byKey.get(b.owner_key);
    if (!client || !open(b.appt_id)) continue;
    const d = depBy.get(b.appt_id);
    cands.push({ key: b.appt_id, kind: "deposit", client, apptId: b.appt_id, contactId: null, locationId: null, conversationId: null,
      contactName: d?.contact_name ?? null, email: d?.email ?? null, apptTime: b.start_time, stage: b.stage_name });
  }

  // (b) past calendar bookings with no deposit.
  const calContacts = new Set<string>();
  for (const r of (calRes.data ?? []) as Array<{ appt_id: string; owner_key: string; contact_id: string | null; contact_name: string | null; email: string | null; start_time: string | null }>) {
    if (r.contact_id) calContacts.add(r.contact_id);
    const client = byKey.get(r.owner_key);
    if (!client || !r.start_time || new Date(r.start_time).getTime() >= now || !open(r.appt_id)) continue;
    cands.push({ key: r.appt_id, kind: "calendar", client, apptId: r.appt_id, contactId: r.contact_id, locationId: null, conversationId: null,
      contactName: r.contact_name, email: r.email, apptTime: r.start_time, stage: null });
  }

  // (c) "Deposit Collected" leads with no deposit, no calendar booking, not
  // already billed as self-booked or from chat.
  const skip = new Set<string>(calContacts);
  for (const r of sbRes) if (r.contact_id) skip.add(r.contact_id);
  const depContacts = await allRows<{ contact_id: string | null }>((a, b) => svc.from("ppa_deposit_contacts").select("contact_id").in("owner_key", ownerKeys).range(a, b));
  for (const r of depContacts) if (r.contact_id) skip.add(r.contact_id);
  const chatBilled = await allRows<{ contact_id: string | null }>((a, b) => svc.from("ppa_chat_billed_contacts").select("contact_id").range(a, b));
  for (const r of chatBilled) if (r.contact_id) skip.add(r.contact_id);
  // Only the "Deposit Collected" stages (the full map is past the 1,000-row cap).
  const { data: stageMap } = await svc.from("ghl_stage_map").select("location_id, stage_id, stage_name").ilike("stage_name", "%deposit%collected%");
  const stageName = new Map<string, string>();
  for (const s of (stageMap ?? []) as Array<{ location_id: string; stage_id: string; stage_name: string }>) stageName.set(`${s.location_id}|${s.stage_id}`, s.stage_name);
  const { data: opps } = await svc.from("ghl_opportunities")
    .select("id, owner_key, location_id, contact_id, name, stage_id, last_stage_change_at")
    .in("owner_key", ownerKeys).in("stage_id", [...new Set([...stageName.keys()].map((k) => k.split("|")[1]))])
    .not("contact_id", "is", null).gte("last_stage_change_at", DEFAULT_START);
  type Opp = { id: string; owner_key: string; location_id: string; contact_id: string; name: string | null; stage_id: string; last_stage_change_at: string };
  const stageOpps = ((opps ?? []) as Opp[]).filter((o) => DEPOSIT_STAGE.test(stageName.get(`${o.location_id}|${o.stage_id}`) ?? "") && !skip.has(o.contact_id));
  const emailBy = new Map<string, string>();
  if (stageOpps.length) {
    const { data } = await svc.from("ghl_contacts").select("id, email").in("id", stageOpps.map((o) => o.contact_id));
    for (const r of (data ?? []) as Array<{ id: string; email: string | null }>) if (r.email) emailBy.set(r.id, r.email.trim().toLowerCase());
  }
  for (const o of stageOpps) {
    const st = stageName.get(`${o.location_id}|${o.stage_id}`) ?? "";
    if (skip.has(o.contact_id)) continue;
    const dn = depNames.get(byKey.get(o.owner_key)?.bizNorm ?? "");
    if (dn && (dn.has(normName(o.name)) || dn.has(emailBy.get(o.contact_id) ?? "-"))) continue;
    if (o.last_stage_change_at < startFor(o.owner_key)) continue;
    const client = byKey.get(o.owner_key);
    const key = `dc:${o.id}`;
    if (!client || !open(`chat:${key}`) || finalBefore(key)) continue;
    skip.add(o.contact_id);
    cands.push({ key, kind: "stage", client, apptId: null, contactId: o.contact_id, locationId: o.location_id, conversationId: null,
      contactName: o.name, email: null, apptTime: null, stage: st });
  }

  // (d) chat-scan bookings nobody reviewed, once the booked day has passed.
  for (const f of (flagRes.data ?? []) as Array<{ conversation_id: string; owner_key: string; location_id: string | null; contact_id: string | null; contact_name: string | null; detected_date: string | null; scanned_at: string | null }>) {
    const client = byKey.get(f.owner_key);
    const when = f.detected_date ?? day(f.scanned_at);
    if (!client || !when || new Date(when).getTime() >= now || (f.contact_id && skip.has(f.contact_id))) continue;
    const key = `chat:${f.conversation_id}`;
    if (!open(key)) continue;
    cands.push({ key, kind: "chat", client, apptId: null, contactId: f.contact_id, locationId: f.location_id, conversationId: f.conversation_id,
      contactName: f.contact_name, email: null, apptTime: f.detected_date, stage: null });
  }

  const summary: SessionCheckSummary = { candidates: cands.length, checked: 0, billed: 0, voided: 0, held: 0, unchanged: 0, partial: false, errors: [] };

  // Already checked this week (resumable across the Sunday runs).
  const weekAgo = new Date(now - 5 * 24 * 3600 * 1000).toISOString();
  const { data: recent } = await svc.from("pps_session_checks").select("check_key").in("owner_key", ownerKeys).gte("checked_at", weekAgo);
  const doneThisWeek = new Set(((recent ?? []) as Array<{ check_key: string }>).map((r) => r.check_key));

  const tokens = new Map<string, string | null>();
  const locByOwner = new Map<string, string>();
  for (const o of (opps ?? []) as Array<{ owner_key: string; location_id: string }>)
    if (!locByOwner.has(o.owner_key)) locByOwner.set(o.owner_key, o.location_id);

  for (const c of cands) {
    if (Date.now() - started > deadlineMs) { summary.partial = true; break; }
    if (doneThisWeek.has(c.key)) continue;
    try {
      // Resolve the GHL contact for deposit rows (the sheet has email + name only).
      if (!c.contactId) {
        const em = String(c.email ?? "").trim().toLowerCase();
        type Hit = { id: string; location_id: string };
        let hit: Hit | null = null;
        if (em.includes("@")) {
          const { data } = await svc.from("ghl_contacts").select("id, location_id").eq("owner_key", c.client.ownerKey).ilike("email", em).limit(1);
          hit = (data?.[0] as Hit | undefined) ?? null;
        }
        if (!hit && normName(c.contactName).length >= 4) {
          const first = String(c.contactName).trim().split(/\s+/)[0];
          const { data } = await svc.from("ghl_contacts").select("id, location_id, contact_name").eq("owner_key", c.client.ownerKey).ilike("contact_name", `${first}%`).limit(50);
          const want = normName(c.contactName);
          hit = ((data ?? []) as Array<{ id: string; location_id: string; contact_name: string | null }>).find((r) => normName(r.contact_name) === want) ?? null;
        }
        if (hit) { c.contactId = hit.id; c.locationId = hit.location_id; }
      }
      if (c.contactId && !c.locationId) {
        const { data } = await svc.from("ghl_contacts").select("location_id").eq("id", c.contactId).limit(1);
        c.locationId = (data?.[0] as { location_id?: string } | undefined)?.location_id ?? locByOwner.get(c.client.ownerKey) ?? null;
      }
      const loc = c.locationId ?? locByOwner.get(c.client.ownerKey) ?? null;
      let check: Check;
      if (!loc || (!c.contactId && !c.conversationId)) {
        check = { verdict: "unsure", session_date: null, reason: "Could not find this client's contact in GHL.", evidence: null };
      } else {
        if (!tokens.has(loc)) tokens.set(loc, (await getAppLocationToken(loc)).token ?? null);
        const token = tokens.get(loc);
        if (!token) throw new Error("no GHL token");
        c.locationId = loc;
        const convId = await conversationFor(c, token);
        const transcript = convId ? await datedThread(convId, token) : "";
        c.conversationId = convId;
        let appts = "";
        if (c.contactId) {
          const { data } = await svc.from("ghl_appointments").select("start_time, status, title").eq("contact_id", c.contactId).order("start_time").limit(10);
          appts = ((data ?? []) as Array<{ start_time: string | null; status: string | null; title: string | null }>)
            .map((a) => `- ${String(a.start_time ?? "").slice(0, 16).replace("T", " ")} UTC · ${a.status ?? "?"} · ${a.title ?? ""}`).join("\n");
        }
        check = transcript || appts
          ? await judge(anthropic, c, transcript, appts)
          : { verdict: "unsure", session_date: null, reason: "No messages in this client's chat.", evidence: null };
      }
      summary.checked++;
      const action = await apply(svc, c, check, feeFor(c.client));
      if (action === "billed") summary.billed++;
      else if (action === "voided") summary.voided++;
      else if (action === "held") summary.held++;
      else summary.unchanged++;
      await svc.from("pps_session_checks").upsert({
        check_key: c.key, owner_key: c.client.ownerKey, kind: c.kind, contact_id: c.contactId, contact_name: c.contactName,
        appt_time: c.apptTime, verdict: check.verdict, session_date: check.session_date, reason: check.reason, evidence: check.evidence,
        action, billed_appt_id: action === "billed" ? billKey(c) : null, checked_at: new Date().toISOString(), model: MODEL,
      }, { onConflict: "check_key" });
    } catch (e) {
      summary.errors.push(`${c.client.ownerName} · ${c.contactName ?? c.key}: ${e instanceof Error ? e.message : "check failed"}`);
    }
  }
  return summary;
}

const billKey = (c: Candidate) => (c.kind === "stage" ? `chat:${c.key}` : c.key);

async function apply(svc: ReturnType<typeof createServiceClient>, c: Candidate, check: Check, fee: number): Promise<"billed" | "voided" | "held" | "none"> {
  const ts = new Date().toISOString();
  const why = `${CHECKER}: ${check.reason}`.slice(0, 400);
  if (c.kind === "deposit" || c.kind === "calendar") {
    const apptId = c.apptId!;
    if (check.verdict === "no_show" || check.verdict === "cancelled") {
      await svc.from("ppa_charges").upsert({ appt_id: apptId, owner_key: c.client.ownerKey, charged: false, excluded: true, exclude_reason: check.verdict,
        excluded_at: ts, excluded_by: CHECKER, note: why, updated_at: ts }, { onConflict: "appt_id" });
      return "voided";
    }
    if (check.verdict === "not_yet") {
      await svc.from("ppa_charges").upsert({ appt_id: apptId, owner_key: c.client.ownerKey, charged: false, excluded: true, exclude_reason: "ai_check",
        excluded_at: ts, excluded_by: CHECKER, note: why, updated_at: ts }, { onConflict: "appt_id" });
      return "held";
    }
    // done / unsure: billable as before — lift our own earlier hold if any.
    const { data } = await svc.from("ppa_charges").select("excluded_by, exclude_reason").eq("appt_id", apptId).maybeSingle();
    const prev = data as { excluded_by: string | null; exclude_reason: string | null } | null;
    if (prev?.excluded_by === CHECKER && prev.exclude_reason === "ai_check") {
      await svc.from("ppa_charges").update({ excluded: false, exclude_reason: null, excluded_at: null, excluded_by: null, note: why, updated_at: ts }).eq("appt_id", apptId);
    }
    return "none";
  }
  // stage / chat: only a confirmed session is billed.
  if (check.verdict === "done") {
    const when = check.session_date ? new Date(`${check.session_date}T12:00:00Z`).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "UTC" }) : "date unknown";
    await svc.from("ppa_charges").upsert({ appt_id: billKey(c), owner_key: c.client.ownerKey, charged: true, amount: fee,
      note: `AI-verified session (${when}) — ${c.contactName ?? "client"}`, charged_at: ts, charged_by: CHECKER,
      excluded: false, exclude_reason: null, updated_at: ts }, { onConflict: "appt_id" });
    if (c.kind === "chat" && c.conversationId) await svc.from("ppa_chat_flags").update({ billed: true }).eq("conversation_id", c.conversationId);
    return "billed";
  }
  if (c.kind === "chat" && c.conversationId && (check.verdict === "no_show" || check.verdict === "cancelled"))
    await svc.from("ppa_chat_flags").update({ dismissed: true }).eq("conversation_id", c.conversationId);
  return "none";
}
