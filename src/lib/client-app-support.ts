import { cache } from "react";
import { randomUUID } from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { appOwner, appTz, loadCampaign } from "@/lib/client-app";
import { getReplyAccount, getThread, type PmuAccount, type ThreadMessage } from "@/lib/ghl-conversations";
import { GHL_BASE, GHL_VERSION } from "@/lib/ghl-tasks";

/* Client app · Support tab (owner, 11/12/2026): the client talks to her
   client success coach — the coach's name and photo, the chat history, text
   and voice notes.

   History = the texts between the team and THIS client in PMU Bookings On
   Demand (the same conversation she already has on her phone). The client is
   found by her Clients-sheet Contact ID, accepted only when that contact
   really has her email or phone — the same rule the "ask the bank" text uses,
   so a stale or recycled id can never show someone else's conversation.

   DEMO stage: what she writes or records here is kept in
   client_app_support_messages and shown back to her; it is NOT passed on to
   the coach yet (delivered_at stays empty). A link alone must never put a
   message into a real client's conversation — that waits for the sign-in. */

const CONV_VERSION = "2021-04-15";
const BUCKET = "client-app-voice";
const MAX_TEXT = 2000;
const MAX_AUDIO_BYTES = 700_000;
const MAX_PER_DAY = 60;

const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
const H = (token: string, version: string) => ({ Authorization: `Bearer ${token}`, Version: version, Accept: "application/json" });

export type Coach = { name: string; first: string; photo: string | null };
export type SupportMessage = {
  id: string; mine: boolean; body: string; at: string | null;
  images: string[]; audio: string[]; files: number;
  /** Who on the team sent it (first name), when GoHighLevel says. */
  by: string | null;
  /** Written in the app during the demo: saved, not yet passed on to the coach. */
  demo: boolean;
  transcript: string | null;
};
export type SupportData = { coach: Coach | null; messages: SupportMessage[]; tz: string; history: boolean };

type GhlUser = { id: string; name: string; first: string; photo: string | null };
const teamOf = cache(async (acct: PmuAccount): Promise<GhlUser[]> => {
  const r = await fetch(`${GHL_BASE}/users/?locationId=${acct.locationId}`, { headers: H(acct.token, GHL_VERSION) }).catch(() => null);
  if (!r?.ok) return [];
  const j = (await r.json().catch(() => ({}))) as { users?: Array<Record<string, unknown>> };
  return (j.users ?? []).map((u) => {
    const name = String(u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`).trim();
    const photo = String(u.profilePhoto ?? "").trim();
    return { id: String(u.id), name, first: String(u.firstName ?? name.split(/\s+/)[0] ?? "").trim(), photo: /^https:\/\//.test(photo) ? photo : null };
  });
});

/** The coach on her Clients-sheet row, with the full name and photo from the
 *  team's GoHighLevel user when exactly one teammate has that first name. */
function coachFrom(team: GhlUser[], assigned: string | null): Coach | null {
  const want = (assigned ?? "").trim();
  if (!want) return null;
  const first = want.split(/\s+/)[0];
  const hits = team.filter((u) => lower(u.first) === lower(first) || lower(u.name) === lower(want));
  const u = hits.length === 1 ? hits[0] : null;
  return { name: u?.name || want, first: u?.first || first, photo: u?.photo ?? null };
}

/* Her contact in PMU Bookings On Demand → the conversation with the team. */
type Contact = { id: string; email?: string; phone?: string; locationId?: string };
async function conversationOf(acct: PmuAccount, sheetRow: number): Promise<string | null> {
  const { data: row } = await createServiceClient().from("clients_master").select("data").eq("sheet_row", sheetRow).maybeSingle();
  const d = (row as { data?: Record<string, unknown> } | null)?.data;
  if (!d) return null;
  const wantEmail = lower(d["Email"]);
  const wantPhone = digits(d["Phone"]);
  const isClient = (c: Contact | null | undefined) => !!c && (
    (!!wantEmail && lower(c.email) === wantEmail) || (wantPhone.length === 10 && digits(c.phone) === wantPhone));
  const h = H(acct.token, GHL_VERSION);
  let contact: Contact | null = null;
  const cid = String(d["Contact ID"] ?? "").trim();
  if (cid) {
    const r = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(cid)}`, { headers: h }).catch(() => null);
    const c = r?.ok ? ((await r.json().catch(() => ({}))) as { contact?: Contact }).contact ?? null : null;
    if (c && c.locationId === acct.locationId && isClient(c)) contact = c;
  }
  const e164 = wantPhone.length === 10 ? `+1${wantPhone}` : "";
  for (const [key, val] of [["email", wantEmail], ["number", e164]] as const) {
    if (contact || !val) continue;
    const r = await fetch(`${GHL_BASE}/contacts/search/duplicate?locationId=${acct.locationId}&${key}=${encodeURIComponent(val)}`, { headers: h }).catch(() => null);
    const c = r?.ok ? ((await r.json().catch(() => ({}))) as { contact?: Contact | null }).contact ?? null : null;
    if (isClient(c)) contact = c;
  }
  if (!contact) return null;
  const r = await fetch(`${GHL_BASE}/conversations/search?locationId=${acct.locationId}&contactId=${encodeURIComponent(contact.id)}&limit=1`,
    { headers: H(acct.token, CONV_VERSION) }).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { conversations?: Array<{ id?: string; contactId?: string }> };
  const conv = (j.conversations ?? []).find((c) => c.contactId === contact!.id);
  return conv?.id ? String(conv.id) : null;
}

const IMAGE_URL = /\.(jpe?g|png|gif|webp)(\?|$)/i;
const AUDIO_URL = /\.(mp3|m4a|aac|ogg|oga|wav|amr|3gp|caf)(\?|$)/i;

export const loadSupport = cache(async (token: string): Promise<SupportData | null> => {
  const ownerKey = await appOwner(token);
  if (!ownerKey) return null;
  const svc = createServiceClient();
  const [campaign, acct, tz, { data: own }] = await Promise.all([
    loadCampaign(ownerKey).catch(() => null),
    getReplyAccount().catch(() => null),
    appTz(token).catch(() => "America/New_York"),
    svc.from("client_app_support_messages").select("id, body, audio_path, transcript, created_at")
      .eq("owner_key", ownerKey).order("created_at", { ascending: true }).limit(200),
  ]);
  const [team, convId] = acct
    ? await Promise.all([teamOf(acct), campaign?.sheetRow != null ? conversationOf(acct, campaign.sheetRow).catch(() => null) : null])
    : [[] as GhlUser[], null];
  const thread: ThreadMessage[] = acct && convId
    ? await getThread(acct, convId, { withAttachments: true, limit: 100 }).catch(() => [])
    : [];
  const firstOf = new Map(team.map((u) => [u.id, u.first]));

  const messages: SupportMessage[] = thread
    // Texts and chat only — emails and call logs are not part of this chat.
    .filter((m) => m.channel !== "Email" && m.channel !== "Call")
    .map((m) => {
      const att = m.attachments ?? [];
      const images = att.filter((u) => IMAGE_URL.test(u));
      const audio = att.filter((u) => AUDIO_URL.test(u));
      return {
        id: m.id, mine: m.direction === "inbound", body: m.body, at: m.dateAdded,
        images, audio, files: att.length - images.length - audio.length,
        by: m.direction === "outbound" && m.userId ? firstOf.get(m.userId) ?? null : null,
        demo: false, transcript: null,
      };
    });

  type Own = { id: string; body: string | null; audio_path: string | null; transcript: string | null; created_at: string };
  const ownRows = (own ?? []) as Own[];
  const paths = ownRows.map((r) => r.audio_path).filter((p): p is string => !!p);
  const signed = new Map<string, string>();
  if (paths.length) {
    const { data: urls } = await svc.storage.from(BUCKET).createSignedUrls(paths, 3600);
    for (const u of urls ?? []) if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
  }
  for (const r of ownRows) {
    const url = r.audio_path ? signed.get(r.audio_path) : undefined;
    messages.push({
      id: `app-${r.id}`, mine: true, body: (r.body ?? "").trim(), at: r.created_at,
      images: [], audio: url ? [url] : [], files: 0, by: null, demo: true, transcript: r.transcript,
    });
  }
  messages.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  return { coach: coachFrom(team, campaign?.coach ?? null), messages, tz, history: !!convId };
});

// An MP3 starts with an ID3 tag or an MPEG frame sync — not a renamed file.
const looksLikeMp3 = (b: Uint8Array) =>
  (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);

/** She pressed Send in the Support tab: a text, a voice note, or both. */
export async function saveSupportMessage(
  token: string, input: { text: string; audio: Uint8Array | null; seconds: number | null },
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const svc = createServiceClient();
  const ownerKey = await appOwner(token);
  if (!ownerKey) return { ok: false, error: "Not available", status: 400 };
  const text = input.text.trim();
  if (!text && !input.audio) return { ok: false, error: "Write a message or record a voice note first", status: 400 };
  if (text.length > MAX_TEXT) return { ok: false, error: "That message is too long — please make it shorter", status: 400 };
  if (input.audio && (input.audio.length > MAX_AUDIO_BYTES || !looksLikeMp3(input.audio))) {
    return { ok: false, error: "That voice note didn't come through — please record it again", status: 400 };
  }
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await svc.from("client_app_support_messages").select("id", { count: "exact", head: true })
    .eq("owner_key", ownerKey).gte("created_at", since);
  if ((count ?? 0) >= MAX_PER_DAY) return { ok: false, error: "That's a lot of messages for one day — please try again tomorrow", status: 429 };

  let audioPath: string | null = null;
  if (input.audio) {
    audioPath = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}.mp3`;
    const { error } = await svc.storage.from(BUCKET).upload(audioPath, input.audio, { contentType: "audio/mpeg", upsert: false });
    if (error) return { ok: false, error: "Couldn't save the voice note — please try again", status: 500 };
  }
  const { error } = await svc.from("client_app_support_messages").insert({
    owner_key: ownerKey, body: text, audio_path: audioPath,
    audio_seconds: input.audio && input.seconds != null && Number.isFinite(input.seconds) ? Math.round(input.seconds * 10) / 10 : null,
  });
  if (error) {
    if (audioPath) await svc.storage.from(BUCKET).remove([audioPath]).catch(() => undefined);
    return { ok: false, error: "Couldn't save your message — please try again", status: 500 };
  }
  return { ok: true };
}
