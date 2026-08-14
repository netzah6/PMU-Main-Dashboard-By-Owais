import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { getPpaRoster } from "@/lib/ppa";
import { getAppLocationToken } from "@/lib/ghl-app";

// ── Chat scan: find bookings that only exist in the conversation ─────────────
// Last line of detection for pay-per-show. Deposits, done-stages, and calendar
// appointments are all deterministic; this pass reads recent GHL conversations
// of PPS clients' leads that NONE of those paths cover and asks Claude whether
// the artist and the lead actually agreed on an appointment in chat.
//
// Findings are REVIEW CANDIDATES only — they show up in a review panel with
// the evidence quoted, and a human decides to bill or dismiss. Nothing found
// here is ever auto-charged: chat is too fuzzy to move money on.

const GHL_BASE = "https://services.leadconnectorhq.com";
const CONV_VERSION = "2021-04-15";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const LOOKBACK_DAYS = 14;
const MAX_CONVS_PER_CLIENT = 100;

// Cheap prefilter so Claude only reads conversations that could plausibly
// contain a booking — most threads are price questions and silence.
const BOOKING_HINTS =
  /\b(book|appoint|schedul|confirm|see you|address|deposit|reschedul|come in|slot|available|opening|tomorrow|tonight|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\d{1,2}\s*(:\d{2})?\s*(am|pm)/i;

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Version: CONV_VERSION, Accept: "application/json" };
}

type Conv = { id: string; contactId: string | null; contactName: string; lastMessageAt: string | null };

async function recentConversations(locationId: string, token: string): Promise<Conv[]> {
  const url = `${GHL_BASE}/conversations/search?locationId=${locationId}&limit=${MAX_CONVS_PER_CLIENT}&sortBy=last_message_date&sort=desc`;
  const r = await fetch(url, { headers: authHeaders(token) });
  if (!r.ok) return [];
  const j = (await r.json()) as { conversations?: Array<Record<string, unknown>> };
  return (j.conversations ?? []).map((c) => {
    const ts = Number(c.lastMessageDate ?? 0);
    return {
      id: String(c.id),
      contactId: (c.contactId as string) ?? null,
      contactName: String(c.contactName ?? c.fullName ?? "").trim(),
      lastMessageAt: ts > 0 ? new Date(ts).toISOString() : null,
    };
  });
}

async function threadText(conversationId: string, token: string): Promise<string> {
  const r = await fetch(`${GHL_BASE}/conversations/${conversationId}/messages?limit=100`, { headers: authHeaders(token) });
  if (!r.ok) return "";
  const j = (await r.json()) as { messages?: { messages?: Array<Record<string, unknown>> } };
  const raw = j.messages?.messages ?? [];
  // Oldest-first, text only, last 40 messages — enough context without paying
  // for the whole history.
  return raw
    .filter((m) => String(m.body ?? "").trim())
    .reverse()
    .slice(-40)
    .map((m) => `${String(m.direction ?? "") === "inbound" ? "Lead" : "Artist"}: ${String(m.body).slice(0, 500)}`)
    .join("\n");
}

type Verdict = { booked: boolean; when: string | null; evidence: string | null };

async function classify(anthropic: Anthropic, transcript: string): Promise<Verdict> {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: [
      "You review SMS/DM conversations between a permanent-makeup artist and a prospective client.",
      "Decide whether they AGREED ON A CONCRETE APPOINTMENT in this conversation — a specific day and/or time that both sides confirmed, or clear evidence a session already happened.",
      "NOT enough: interest, price talk, 'I'll check my schedule', an unanswered proposal, or the artist sending a booking link with no confirmed slot.",
      'Reply with ONLY a JSON object: {"booked": boolean, "when": string|null, "evidence": string|null}.',
      "\"when\" = the agreed day/time as stated (e.g. \"Friday 2pm\", \"Aug 20\"). \"evidence\" = a SHORT verbatim quote (max 200 chars) showing the agreement. Use null when booked is false.",
    ].join("\n"),
    messages: [{ role: "user", content: transcript.slice(0, 12000) }],
  });
  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text) as Verdict;
    return { booked: !!j.booked, when: j.when ?? null, evidence: j.evidence ?? null };
  } catch {
    return { booked: false, when: null, evidence: null };
  }
}

export interface ChatScanSummary {
  clients: number;
  conversations: number;
  scanned: number;
  flagged: number;
  skippedKnownBillable: number;
  partial: boolean;
  errors: string[];
}

export async function scanChats(deadlineMs = 240_000): Promise<ChatScanSummary> {
  const started = Date.now();
  const svc = createServiceClient();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { clients: roster } = await getPpaRoster();
  const ownerKeys = roster.map((c) => c.ownerKey);

  // Contacts already covered by a deterministic billing path — their chats
  // don't need reading: deposit leads, done-stage leads, calendar-booked leads.
  const covered = new Set<string>();
  const [depRes, apptRes] = await Promise.all([
    svc.from("ppa_deposit_contacts").select("contact_id").in("owner_key", ownerKeys),
    svc.from("ghl_appointments").select("contact_id").in("owner_key", ownerKeys),
  ]);
  for (const r of (depRes.data ?? []) as Array<{ contact_id: string | null }>) if (r.contact_id) covered.add(r.contact_id);
  for (const r of (apptRes.data ?? []) as Array<{ contact_id: string | null }>) if (r.contact_id) covered.add(r.contact_id);
  // Done-stage contacts (self-booked path) — page past the 1,000-row cap.
  for (let from = 0; ; from += 1000) {
    const { data } = await svc.from("ppa_selfbooked").select("contact_id").range(from, from + 999);
    const page = (data ?? []) as Array<{ contact_id: string | null }>;
    for (const r of page) if (r.contact_id) covered.add(r.contact_id);
    if (page.length < 1000) break;
  }

  // Scan state: skip conversations already scanned with no new messages, and
  // anything already billed or dismissed.
  const flagBy = new Map<string, { last_message_at: string | null; billed: boolean; dismissed: boolean }>();
  const { data: flags } = await svc.from("ppa_chat_flags").select("conversation_id, last_message_at, billed, dismissed");
  for (const f of (flags ?? []) as Array<{ conversation_id: string; last_message_at: string | null; billed: boolean; dismissed: boolean }>)
    flagBy.set(f.conversation_id, f);

  // One location per client (all a client's leads live in her sub-account).
  const locByOwner = new Map<string, string>();
  const { data: locs } = await svc
    .from("ghl_opportunities").select("owner_key, location_id").in("owner_key", ownerKeys).not("location_id", "is", null).limit(1000);
  for (const r of (locs ?? []) as Array<{ owner_key: string; location_id: string }>)
    if (!locByOwner.has(r.owner_key)) locByOwner.set(r.owner_key, r.location_id);

  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000;
  const summary: ChatScanSummary = { clients: 0, conversations: 0, scanned: 0, flagged: 0, skippedKnownBillable: 0, partial: false, errors: [] };

  for (const client of roster) {
    if (Date.now() - started > deadlineMs) { summary.partial = true; break; }
    const locationId = locByOwner.get(client.ownerKey);
    if (!locationId) continue;
    summary.clients++;
    try {
      const t = await getAppLocationToken(locationId);
      if (!t.token) continue;
      const convs = await recentConversations(locationId, t.token);
      for (const conv of convs) {
        if (Date.now() - started > deadlineMs) { summary.partial = true; break; }
        if (!conv.lastMessageAt || new Date(conv.lastMessageAt).getTime() < cutoff) break; // sorted desc
        summary.conversations++;
        if (conv.contactId && covered.has(conv.contactId)) { summary.skippedKnownBillable++; continue; }
        const prev = flagBy.get(conv.id);
        if (prev && (prev.billed || prev.dismissed)) continue;
        if (prev && prev.last_message_at && conv.lastMessageAt <= prev.last_message_at) continue;

        const transcript = await threadText(conv.id, t.token);
        let verdict: Verdict = { booked: false, when: null, evidence: null };
        if (transcript && BOOKING_HINTS.test(transcript)) {
          verdict = await classify(anthropic, transcript);
        }
        summary.scanned++;
        if (verdict.booked) summary.flagged++;
        await svc.from("ppa_chat_flags").upsert({
          conversation_id: conv.id,
          owner_key: client.ownerKey,
          location_id: locationId,
          contact_id: conv.contactId,
          contact_name: conv.contactName || null,
          verdict: verdict.booked ? "booked" : "none",
          detected_when: verdict.when,
          evidence: verdict.evidence,
          last_message_at: conv.lastMessageAt,
          scanned_at: new Date().toISOString(),
        }, { onConflict: "conversation_id" });
      }
    } catch (e) {
      summary.errors.push(`${client.ownerName}: ${e instanceof Error ? e.message : "scan failed"}`);
    }
  }
  return summary;
}
