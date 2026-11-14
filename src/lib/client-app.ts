import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { buildPortalView, portalOwnerByToken, type PortalShow, type PortalView } from "@/lib/ppa-portal";
import { getAppLocationToken } from "@/lib/ghl-app";
import { findConversationByContact, getRecentConversations, getThread, type ConvSummary, type ThreadMessage } from "@/lib/ghl-conversations";
import { locationTimezone } from "@/lib/onebox";
import type { GReviews } from "@/lib/g-reviews";
import { appGate } from "@/lib/client-app-auth";

/* Client app (owner, 11/11/2026): the "PMU Bookings On Demand" app a client
   keeps on her phone — Home, Chats, Bookings, Leads, Billing (+ Google
   Reviews from Home). DEMO stage: opened by the same secret token as
   /my-billing (table ppa_portal_links); a real email sign-in replaces the
   token before any client gets it.

   Everything a client sees comes through here, so this file is where "what
   may a client see" is decided: her own leads' names, dates and status; her
   own chats with her leads (read-only until sign-in exists — nobody may send
   a text from a link alone); her bookings; her billing; her Google reviews.
   No staff notes, no AI internals, never another client's data. */

export type AppLead = { name: string; at: string | null; state: "paid" | "booked" | "talking" };
export type AppReviews = {
  on: boolean;                 // the team turned the section on for this client
  requestedAt: string | null;  // she asked for it to be turned on
  connected: boolean;          // we found her Google listing and its numbers
  rating: number | null; count: number | null;
  gained: number | null;       // reviews gained since `since` (null = tracking just started)
  since: string | null;
  latest: Array<{ name: string; stars: number; text: string; when: string }>;
};
/* Her campaign, in her words (owner, 11/12/2026): is it live, and is there
   anything SHE has to do. From the same row the team's Performance tab shows:
   the team's own status (Live / Paused) and Facebook's ad-account status.
   "unknown" = live with us but Facebook's status isn't on file this week, so
   we say "Live" and claim nothing about the ads. */
export type CampaignState = "live" | "unsettled" | "grace" | "disabled" | "paused" | "unknown";
export type AppCampaign = { state: CampaignState; coach: string | null; sheetRow: number | null };
type PerfRow = { sheet_row: number; owner_name: string | null; client_status: string | null; campaign_status: string | null; campaign_paused: boolean | null; assigned: string | null };
const stateOf = (r: PerfRow): CampaignState => {
  const st = (r.campaign_status ?? "").toUpperCase();
  if ((r.client_status ?? "").trim().toLowerCase() !== "live") return "paused";
  if (st.includes("UNSETTLED")) return "unsettled";
  if (st.includes("GRACE")) return "grace";
  if (st.includes("DISABLE") || st.includes("CLOSED")) return "disabled";
  if (st.includes("ACTIVE") && r.campaign_paused !== true) return "live";
  return "unknown";
};
// Several businesses under one owner: an action she must take wins, then live.
const RANK: CampaignState[] = ["unsettled", "grace", "disabled", "live", "unknown", "paused"];
export const loadCampaign = cache(async (ownerKey: string): Promise<AppCampaign | null> => {
  const { data } = await createServiceClient().from("performance_overview")
    .select("sheet_row, owner_name, client_status, campaign_status, campaign_paused, assigned");
  const mine = ((data ?? []) as PerfRow[]).filter((r) => (r.owner_name ?? "").trim().toLowerCase() === ownerKey);
  if (!mine.length) return null;
  const best = [...mine].sort((a, b) => RANK.indexOf(stateOf(a)) - RANK.indexOf(stateOf(b)))[0];
  return { state: stateOf(best), coach: (best.assigned ?? "").trim() || null, sheetRow: best.sheet_row };
});

export type AppData = {
  view: PortalView; leads: AppLead[]; leads30: number; booked30: number; paid30: number;
  /** Campaign status + what she has to do, or null when she isn't on the team's list. */
  campaign: AppCampaign | null;
  /** Sessions that came in through us, all time: charged + waiting for the next bill. */
  sessionsDone: number;
  logo: string | null;
  reviews: AppReviews;
};

/* "jenny thum" → "Jenny Thum"; names already written with capitals stay as
   they are ("McKenna", "DeShawn"). */
export const niceName = (raw: string | null | undefined) => {
  const s = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "(no name)";
  return s === s.toLowerCase() || s === s.toUpperCase()
    ? s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase())
    : s;
};

/** Token → client, once per request (also counts the view once).
 *  A client on the sign-in beta list must be signed in (or it is the team
 *  looking) — otherwise the link opens nothing. Every screen and every app API
 *  goes through here, so this is the one door. */
const gateOf = cache(async (token: string): Promise<{ ownerKey: string | null; needsSignIn: boolean }> => {
  const ownerKey = await portalOwnerByToken(createServiceClient(), token);
  if (!ownerKey) return { ownerKey: null, needsSignIn: false };
  const gate = await appGate(ownerKey).catch(() => "signin" as const);
  return gate === "ok" ? { ownerKey, needsSignIn: false } : { ownerKey: null, needsSignIn: true };
});
const ownerOf = async (token: string): Promise<string | null> => (await gateOf(token)).ownerKey;
/** True when the link is real but its client has to sign in first. */
export const appNeedsSignIn = async (token: string): Promise<boolean> => (await gateOf(token)).needsSignIn;
export const appOwner = ownerOf;

/* Her GoHighLevel sub-account and her funnel (logo, Google reviews). */
type Account = { ownerKey: string; locationId: string; slug: string | null; logo: string | null; gReviews: GReviews | null };
const accountOf = cache(async (token: string): Promise<Account | null> => {
  const ownerKey = await ownerOf(token);
  if (!ownerKey) return null;
  const svc = createServiceClient();
  const { data } = await svc.from("ghl_lead_status").select("location_id")
    .eq("owner_key", ownerKey).not("location_id", "is", null).limit(1);
  const locationId = String((data?.[0] as { location_id?: string } | undefined)?.location_id ?? "");
  if (!locationId) return { ownerKey, locationId: "", slug: null, logo: null, gReviews: null };
  const { data: funnels } = await svc.from("onebox_clients").select("slug, status, config, extras").eq("location_id", locationId);
  type F = { slug: string; status: string | null; config: Record<string, unknown> | null; extras: { gReviews?: GReviews } | null };
  const list = (funnels ?? []) as F[];
  const f = list.find((x) => x.status === "live") ?? list[0];
  const logo = String(f?.config?.logo ?? "").trim();
  return { ownerKey, locationId, slug: f?.slug ?? null, logo: /^https:\/\//.test(logo) ? logo : null, gReviews: f?.extras?.gReviews ?? null };
});

async function loadReviews(acct: Account): Promise<AppReviews> {
  const svc = createServiceClient();
  const { data: s } = await svc.from("client_app_settings").select("reviews_on, reviews_requested_at").eq("owner_key", acct.ownerKey).maybeSingle();
  const g = acct.gReviews;
  const base: AppReviews = {
    on: !!(s as { reviews_on?: boolean } | null)?.reviews_on,
    requestedAt: (s as { reviews_requested_at?: string | null } | null)?.reviews_requested_at ?? null,
    connected: !!g && g.count != null, rating: g?.rating ?? null, count: g?.count ?? null,
    gained: null, since: null,
    latest: (g?.reviews ?? []).slice(0, 5).map((r) => ({ name: r.name, stars: r.stars, text: r.text, when: r.when })),
  };
  if (!base.on || !base.connected || !acct.slug) return base;
  // Gained = today's count minus the count ~30 days ago (or the oldest point we have).
  const { data: hist } = await svc.from("client_review_history").select("day, review_count").eq("slug", acct.slug).order("day", { ascending: true });
  const rows = (hist ?? []) as Array<{ day: string; review_count: number }>;
  const cut = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const ref = [...rows].reverse().find((r) => r.day <= cut) ?? rows[0];
  if (ref && ref.day < today) { base.gained = (base.count ?? 0) - ref.review_count; base.since = ref.day; }
  return base;
}

/** One load per request, shared by the layout and the page. */
export const loadApp = cache(async (token: string): Promise<AppData | null> => {
  const acct = await accountOf(token);
  if (!acct) return null;
  const svc = createServiceClient();
  const [view, { data: leadRows }, reviews, campaign] = await Promise.all([
    buildPortalView(svc, acct.ownerKey).catch(() => null),
    svc.from("ghl_lead_status")
      .select("contact_name, date_added, booked, deposit_collected")
      .eq("owner_key", acct.ownerKey).order("date_added", { ascending: false }).limit(300),
    loadReviews(acct),
    loadCampaign(acct.ownerKey).catch(() => null),
  ]);
  if (!view) return null;
  type Row = { contact_name: string | null; date_added: string | null; booked: boolean | null; deposit_collected: boolean | null };
  const rows = (leadRows ?? []) as Row[];
  const cut = Date.now() - 30 * 86_400_000;
  const recent = rows.filter((r) => r.date_added && new Date(r.date_added).getTime() >= cut);
  const state = (r: Row): AppLead["state"] => (r.deposit_collected ? "paid" : r.booked ? "booked" : "talking");
  return {
    view,
    leads: rows.slice(0, 100).map((r) => ({ name: niceName(r.contact_name), at: r.date_added, state: state(r) })),
    leads30: recent.length,
    booked30: recent.filter((r) => r.booked || r.deposit_collected).length,
    paid30: recent.filter((r) => r.deposit_collected).length,
    sessionsDone: view.owed.count + view.payments.reduce((n, p) => n + p.names.length, 0),
    logo: acct.logo,
    reviews,
    campaign,
  };
});

// ── Chats: the client's own GoHighLevel conversations, read live ────────────
/* The GHL token used here is minted for THIS client's sub-account only, so
   it cannot read another client's conversations even if a conversation id
   from elsewhere were pasted into the address. */
type ChatAccount = { ownerKey: string; locationId: string; token: string; tz: string };
export type AppChatAccount = ChatAccount;
export const chatAccount = cache(async (token: string): Promise<ChatAccount | null> => {
  const acct = await accountOf(token);
  if (!acct?.locationId) return null;
  const t = await getAppLocationToken(acct.locationId);
  if (!t.token) return null;
  const tz = (await locationTimezone(acct.locationId, t.token)) || "America/New_York";
  return { ownerKey: acct.ownerKey, locationId: acct.locationId, token: t.token, tz };
});


/** Is the AI assistant answering this lead? From the contact's "ai on" /
 *  "ai off" tags (live from GoHighLevel when it sends them, else our last
 *  sync). null = no tag either way, so we say nothing. */
export type AiState = "on" | "off" | null;
/* Where a lead is on her way to becoming a client (owner, 11/12/2026: "a
   little update on their status in the client journey"). It is the stage she
   is in on the client's own pipeline, in the pipeline's own words without the
   emojis — the same words the client sees in her account — except the two
   steps the whole app already names: "Paid a deposit" and "Picked a time".
   From our last sync, so it can be a few minutes behind.

   "Paid a deposit" needs PROOF of a payment: the paid tag on the lead. The
   pipeline stage "Deposit Collected" is not proof — the account's
   confirmation workflow gives it to EVERY confirmed booking, deposit or not
   (seen in GoHighLevel, 11/13/2026: a test booking with no deposit landed
   there). Without the tag that stage reads "Booked". */
export const PAID_TAGS = ["fanbasis buyer", "deposit collected"];
export type Journey = { label: string; tone: "green" | "amber" | "red" | "gray" };
export const JOURNEY_CLS: Record<Journey["tone"], string> = {
  green: "bg-[#e6f7ee] text-[#15803d]", amber: "bg-[#fff4e5] text-[#b45309]", red: "bg-[#fde8ee] text-[#be123c]", gray: "bg-[#f1f5f9] text-[#52627a]",
};
const plainStage = (s: string) => s
  .replace(/[0-9#*]\uFE0F?\u20E3/g, " ")           // keycap emojis (1️⃣ 2️⃣ …)
  .replace(/\([^)]*\)/g, " ")                       // "(Filled Survey)"
  .replace(/[^\p{L}\p{N}\s/&'-]/gu, " ").replace(/\s+/g, " ").trim();
export function journeyOf(stage: string | null | undefined, f?: { booked?: boolean | null; paid?: boolean | null }): Journey | null {
  const s = (stage ?? "").toLowerCase();
  if (/session\s*(done|complete)|(5|five)\s*stars?|google\s*review/.test(s)) return { label: "Session done", tone: "green" };
  if (f?.paid) return { label: "Paid a deposit", tone: "green" };
  if (/declin/.test(s)) return { label: plainStage(stage ?? ""), tone: "red" };
  if (/deposit\s*(collected|paid)/.test(s)) return { label: "Booked", tone: "amber" };
  if (f?.booked || /waiting for deposit|booked/.test(s)) return { label: "Picked a time", tone: "amber" };
  const label = plainStage(stage ?? "");
  return label ? { label, tone: "gray" } : null;
}

export type AppChat = { id: string; name: string; preview: string; at: string | null; fromLead: boolean; unread: number; channel: string; ai: AiState; journey: Journey | null; contactId: string | null };
export const loadChats = cache(async (token: string): Promise<{ chats: AppChat[]; tz: string } | null> => {
  const acct = await chatAccount(token);
  if (!acct) return null;
  const svc = createServiceClient();
  const list = await getRecentConversations(acct, 60).catch(() => [] as ConvSummary[]);
  // Only the people in these chats — never the whole account (a busy client has thousands of leads).
  const ids = [...new Set(list.map((c) => c.contactId).filter((x): x is string => !!x))];
  const [{ data: synced }, { data: opps }, { data: stages }] = ids.length ? await Promise.all([
    svc.from("ghl_lead_status").select("contact_id, ai_on, ai_off, booked, deposit_collected").eq("owner_key", acct.ownerKey).in("contact_id", ids),
    svc.from("ghl_opportunities").select("contact_id, stage_id, last_stage_change_at").eq("location_id", acct.locationId).in("contact_id", ids),
    svc.from("ghl_stage_map").select("stage_id, stage_name").eq("location_id", acct.locationId),
  ]) : [{ data: [] }, { data: [] }, { data: [] }];
  const byContact = new Map<string, AiState>();
  const flags = new Map<string, { booked: boolean; paid: boolean }>();
  for (const r of (synced ?? []) as Array<{ contact_id: string | null; ai_on: boolean | null; ai_off: boolean | null; booked: boolean | null; deposit_collected: boolean | null }>) {
    if (!r.contact_id) continue;
    byContact.set(r.contact_id, r.ai_off ? "off" : r.ai_on ? "on" : null);
    flags.set(r.contact_id, { booked: !!r.booked, paid: !!r.deposit_collected });
  }
  const stageName = new Map<string, string>();
  for (const r of (stages ?? []) as Array<{ stage_id: string; stage_name: string | null }>) if (r.stage_name) stageName.set(r.stage_id, r.stage_name);
  // A lead with two pipeline cards: the one that moved last is where she is now.
  const stageOf = new Map<string, { name: string; at: string }>();
  for (const r of (opps ?? []) as Array<{ contact_id: string | null; stage_id: string | null; last_stage_change_at: string | null }>) {
    const name = r.stage_id ? stageName.get(r.stage_id) : undefined;
    if (!r.contact_id || !name) continue;
    const at = r.last_stage_change_at ?? "";
    const cur = stageOf.get(r.contact_id);
    if (!cur || at > cur.at) stageOf.set(r.contact_id, { name, at });
  }
  const aiOf = (c: ConvSummary): AiState => {
    if (c.tags) return c.tags.includes("ai off") ? "off" : c.tags.includes("ai on") ? "on" : null;
    return (c.contactId && byContact.get(c.contactId)) || null;
  };
  return {
    tz: acct.tz,
    chats: list.map((c) => ({
      id: c.id, name: niceName(c.contactName), preview: c.lastMessageBody, at: c.lastMessageDate,
      fromLead: String(c.lastMessageDirection ?? "").toLowerCase() === "inbound", unread: c.unreadCount, channel: c.channel,
      ai: aiOf(c),
      journey: c.contactId ? journeyOf(stageOf.get(c.contactId)?.name, {
        booked: flags.get(c.contactId)?.booked,
        // Her tags, live from GoHighLevel when it sends them; else our last sync.
        paid: c.tags ? PAID_TAGS.some((t) => c.tags!.includes(t)) : flags.get(c.contactId)?.paid,
      }) : null,
      contactId: c.contactId,
    })),
  };
});

export type AppMessage = { id: string; fromLead: boolean; body: string; at: string | null; images: string[]; files: number };
const IMAGE_URL = /\.(jpe?g|png|gif|webp)(\?|$)/i;
export async function loadThread(token: string, conversationId: string): Promise<{ messages: AppMessage[]; tz: string } | null> {
  if (!/^[A-Za-z0-9_-]{8,48}$/.test(conversationId)) return null;
  const acct = await chatAccount(token);
  if (!acct) return null;
  const msgs: ThreadMessage[] = await getThread(acct, conversationId, { withAttachments: true, limit: 100 }).catch(() => []);
  return {
    tz: acct.tz,
    messages: msgs.map((m) => {
      const att = m.attachments ?? [];
      const images = att.filter((u) => IMAGE_URL.test(u));
      return { id: m.id, fromLead: m.direction === "inbound", body: m.body, at: m.dateAdded, images, files: att.length - images.length };
    }),
  };
}

// ── Bookings: who each appointment is with, so a tap opens her chat ─────────
/* The appointment list is the billing one (names + times). The lead behind a
   row is found by the appointment's exact start time on the client's own
   calendar; when two appointments start at the same minute we don't guess —
   that row simply has no chat link. */
export type AppBooking = PortalShow & {
  contactId: string | null;
  /** Her calendar's id for this appointment — only on upcoming rows she may move or cancel. */
  apptId: string | null;
};
const DEAD_APPT = /cancel|invalid|no.?show/i;
export const loadBookings = cache(async (token: string): Promise<{ upcoming: AppBooking[]; done: AppBooking[]; tz: string | null } | null> => {
  const [app, ownerKey] = await Promise.all([loadApp(token), ownerOf(token)]);
  if (!app || !ownerKey) return null;
  const svc = createServiceClient();
  const [{ data }, { data: log }, acct] = await Promise.all([
    svc.from("ghl_appointments").select("id, contact_id, start_time, status").eq("owner_key", ownerKey)
      .gte("start_time", "2026-08-01T00:00:00Z").order("start_time", { ascending: false }).limit(1000),
    // What she moved or cancelled from this app in the last days: the billing
    // list catches up later, so her own changes are laid over it right away.
    svc.from("client_app_booking_log").select("action, from_start, to_start").eq("owner_key", ownerKey).eq("ok", true)
      .gte("created_at", new Date(Date.now() - 4 * 86_400_000).toISOString()).order("created_at", { ascending: true }).limit(200),
    chatAccount(token).catch(() => null),
  ]);
  const at = new Map<number, Map<string, string>>(); // start → contact → appointment id
  for (const r of (data ?? []) as Array<{ id: string; contact_id: string | null; start_time: string | null; status: string | null }>) {
    if (!r.contact_id || !r.start_time || DEAD_APPT.test(r.status ?? "")) continue;
    const ms = new Date(r.start_time).getTime();
    at.set(ms, (at.get(ms) ?? new Map()).set(r.contact_id, r.id));
  }
  const changed = new Map<number, number | null>(); // old start → new start (null = cancelled)
  for (const r of (log ?? []) as Array<{ action: string; from_start: string | null; to_start: string | null }>) {
    if (!r.from_start) continue;
    changed.set(new Date(r.from_start).getTime(), r.action === "move" && r.to_start ? new Date(r.to_start).getTime() : null);
  }
  const who = (s: PortalShow, live: boolean): AppBooking | null => {
    let ms = s.date && /T\d{2}:/.test(s.date) ? new Date(s.date).getTime() : NaN;
    let date = s.date;
    for (let hop = 0; live && hop < 6 && changed.has(ms); hop++) {
      const to = changed.get(ms);
      if (to == null) return null;                    // she cancelled it here
      ms = to; date = new Date(to).toISOString();
    }
    const hit = at.get(ms);
    const one = hit && hit.size === 1 ? [...hit.entries()][0] : null;
    return { ...s, date, contactId: one?.[0] ?? null, apptId: live && one && ms > Date.now() ? one[1] : null };
  };
  const v = app.view;
  return {
    tz: acct?.tz ?? null,
    upcoming: v.upcoming.map((s) => who(s, true)).filter((x): x is AppBooking => !!x)
      .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? ""))),
    done: [...v.owed.shows].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? ""))).map((s) => who(s, false)!),
  };
});

/** The chat with one of her leads (from Bookings): the conversation id + the lead's name. */
export async function chatWithContact(token: string, contactId: string): Promise<{ id: string | null; name: string | null } | null> {
  if (!/^[A-Za-z0-9]{10,40}$/.test(contactId)) return null;
  const acct = await chatAccount(token);
  if (!acct) return null;
  // Her own lead only: the contact must be on file under this client.
  const { data } = await createServiceClient().from("ghl_contacts").select("contact_name").eq("id", contactId).eq("owner_key", acct.ownerKey).maybeSingle();
  if (!data) return null;
  const id = await findConversationByContact(acct, contactId).catch(() => null);
  return { id, name: niceName((data as { contact_name: string | null }).contact_name) };
}

/** She tapped "ask my team to turn Google Reviews on". Records it once. */
export async function requestReviews(token: string): Promise<boolean> {
  const svc = createServiceClient();
  const ownerKey = await ownerOf(token);
  if (!ownerKey) return false;
  const { data: cur } = await svc.from("client_app_settings").select("reviews_requested_at").eq("owner_key", ownerKey).maybeSingle();
  if ((cur as { reviews_requested_at?: string | null } | null)?.reviews_requested_at) return true;
  const now = new Date().toISOString();
  const { error } = await svc.from("client_app_settings").upsert({ owner_key: ownerKey, reviews_requested_at: now, updated_at: now }, { onConflict: "owner_key" });
  return !error;
}
