import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { buildPortalView, portalOwnerByToken, type PortalView } from "@/lib/ppa-portal";
import { getAppLocationToken } from "@/lib/ghl-app";
import { getRecentConversations, getThread, type ConvSummary, type ThreadMessage } from "@/lib/ghl-conversations";
import { locationTimezone } from "@/lib/onebox";
import type { GReviews } from "@/lib/g-reviews";

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

/** Token → client, once per request (also counts the view once). */
const ownerOf = cache(async (token: string): Promise<string | null> => portalOwnerByToken(createServiceClient(), token));
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
const chatAccount = cache(async (token: string): Promise<ChatAccount | null> => {
  const acct = await accountOf(token);
  if (!acct?.locationId) return null;
  const t = await getAppLocationToken(acct.locationId);
  if (!t.token) return null;
  const tz = (await locationTimezone(acct.locationId, t.token)) || "America/New_York";
  return { ownerKey: acct.ownerKey, locationId: acct.locationId, token: t.token, tz };
});

/** Her own time zone (her sub-account's), for showing times anywhere in the app. */
export const appTz = async (token: string): Promise<string> => (await chatAccount(token))?.tz ?? "America/New_York";

/** Is the AI assistant answering this lead? From the contact's "ai on" /
 *  "ai off" tags (live from GoHighLevel when it sends them, else our last
 *  sync). null = no tag either way, so we say nothing. */
export type AiState = "on" | "off" | null;
export type AppChat = { id: string; name: string; preview: string; at: string | null; fromLead: boolean; unread: number; channel: string; ai: AiState };
export const loadChats = cache(async (token: string): Promise<{ chats: AppChat[]; tz: string } | null> => {
  const acct = await chatAccount(token);
  if (!acct) return null;
  const svc = createServiceClient();
  const [list, { data: synced }] = await Promise.all([
    getRecentConversations(acct, 60).catch(() => [] as ConvSummary[]),
    svc.from("ghl_lead_status").select("contact_id, ai_on, ai_off").eq("owner_key", acct.ownerKey).limit(2000),
  ]);
  const byContact = new Map<string, AiState>();
  for (const r of (synced ?? []) as Array<{ contact_id: string | null; ai_on: boolean | null; ai_off: boolean | null }>) {
    if (r.contact_id) byContact.set(r.contact_id, r.ai_off ? "off" : r.ai_on ? "on" : null);
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

/** She tapped "ask my team to turn Google Reviews on". Records it once. */
export async function requestReviews(token: string): Promise<boolean> {
  const svc = createServiceClient();
  const ownerKey = await portalOwnerByToken(svc, token);
  if (!ownerKey) return false;
  const { data: cur } = await svc.from("client_app_settings").select("reviews_requested_at").eq("owner_key", ownerKey).maybeSingle();
  if ((cur as { reviews_requested_at?: string | null } | null)?.reviews_requested_at) return true;
  const now = new Date().toISOString();
  const { error } = await svc.from("client_app_settings").upsert({ owner_key: ownerKey, reviews_requested_at: now, updated_at: now }, { onConflict: "owner_key" });
  return !error;
}
