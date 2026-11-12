import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { buildPortalView, portalOwnerByToken, type PortalView } from "@/lib/ppa-portal";
import { getAppLocationToken } from "@/lib/ghl-app";
import { getRecentConversations, getThread, type ConvSummary, type ThreadMessage } from "@/lib/ghl-conversations";
import { locationTimezone } from "@/lib/onebox";

/* Client app (owner, 11/11/2026): the "PMU Bookings On Demand" app a client
   keeps on her phone — Home, Chats, Bookings, Leads, Billing. DEMO stage:
   opened by the same secret token as /my-billing (table ppa_portal_links);
   a real email sign-in replaces the token before any client gets it.

   Everything a client sees comes through here, so this file is where "what
   may a client see" is decided: her own leads' names, dates and status; her
   own chats with her leads (read-only until sign-in exists — nobody may send
   a text from a link alone); her bookings; her billing. No staff notes, no
   AI internals, never another client's data. */

export type AppLead = { name: string; at: string | null; state: "paid" | "booked" | "talking" };
export type AppData = {
  view: PortalView; leads: AppLead[]; leads30: number; booked30: number; paid30: number;
  /** Sessions that came in through us, all time: charged + waiting for the next bill. */
  sessionsDone: number;
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

/** One load per request, shared by the layout and the page. */
export const loadApp = cache(async (token: string): Promise<AppData | null> => {
  const ownerKey = await ownerOf(token);
  if (!ownerKey) return null;
  const svc = createServiceClient();
  const [view, { data: leadRows }] = await Promise.all([
    buildPortalView(svc, ownerKey).catch(() => null),
    svc.from("ghl_lead_status")
      .select("contact_name, date_added, booked, deposit_collected")
      .eq("owner_key", ownerKey).order("date_added", { ascending: false }).limit(300),
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
  };
});

// ── Chats: the client's own GoHighLevel conversations, read live ────────────
/* The GHL token used here is minted for THIS client's sub-account only, so
   it cannot read another client's conversations even if a conversation id
   from elsewhere were pasted into the address. */
type ChatAccount = { locationId: string; token: string; tz: string };
const chatAccount = cache(async (token: string): Promise<ChatAccount | null> => {
  const ownerKey = await ownerOf(token);
  if (!ownerKey) return null;
  const svc = createServiceClient();
  const { data } = await svc.from("ghl_lead_status").select("location_id")
    .eq("owner_key", ownerKey).not("location_id", "is", null).limit(1);
  const locationId = String((data?.[0] as { location_id?: string } | undefined)?.location_id ?? "");
  if (!locationId) return null;
  const t = await getAppLocationToken(locationId);
  if (!t.token) return null;
  const tz = (await locationTimezone(locationId, t.token)) || "America/New_York";
  return { locationId, token: t.token, tz };
});

export type AppChat = { id: string; name: string; preview: string; at: string | null; fromLead: boolean; unread: number; channel: string };
export const loadChats = cache(async (token: string): Promise<{ chats: AppChat[]; tz: string } | null> => {
  const acct = await chatAccount(token);
  if (!acct) return null;
  const list: ConvSummary[] = await getRecentConversations(acct, 60).catch(() => []);
  return {
    tz: acct.tz,
    chats: list.map((c) => ({
      id: c.id, name: niceName(c.contactName), preview: c.lastMessageBody, at: c.lastMessageDate,
      fromLead: String(c.lastMessageDirection ?? "").toLowerCase() === "inbound", unread: c.unreadCount, channel: c.channel,
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
