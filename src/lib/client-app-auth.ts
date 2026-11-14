import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getReplyAccount, sendConversationMessage, fetchWithBackoff } from "@/lib/ghl-conversations";

/* Client app · sign-in (owner, 11/14/2026).

   A client signs in with her PHONE NUMBER and a 6-digit code we text her from
   the agency's own number. Owner's rules, in his words: "please don't send
   anything to the clients yet. I only want to do it once I tell you that, and
   only once they try to log in" and "a test for 3 clients first as a beta".

   So three locks sit in front of every text:
     1. the master switch (app_settings key client_app_signin → sendEnabled),
        OFF until the owner says so;
     2. the beta list (client_app_users): only a client HE named, active;
     3. she asked for the code herself, just now, on the sign-in screen.
   Nothing here ever messages a client on its own.

   Clients are NOT Supabase Auth users (a signed-in Supabase user gets write
   grants on some dashboard tables). The session is our own signed cookie that
   only says "this browser is client X until date Y".

   A client on the beta list can open her app only with that session; the team
   (a signed-in dashboard user with a role) can open any client's app. A client
   who is not on the list keeps working as before: by her secret link. */

const SETTINGS_KEY = "client_app_signin";
const COOKIE = "pmu_app";
const SESSION_DAYS = 60;
const CODE_MINUTES = 10;
const MAX_CODES_PER_15_MIN = 3;
const MAX_TRIES = 5;
const GHL = "https://services.leadconnectorhq.com";

/** The words of the text. The owner approves them before the switch goes on. */
export const codeText = (code: string) =>
  `Your PMU Bookings On Demand code is ${code}. It works for ${CODE_MINUTES} minutes. If you did not ask for it, please ignore this text.`;

const secret = () => createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").update("client-app-session-v1").digest();
const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");
const codeHash = (ownerKey: string, code: string) => createHash("sha256").update(`${ownerKey}|${code}|`).update(secret()).digest("hex");

/** "+12065550100" for a US number typed any way, else null. */
export function normalizePhone(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return /^[2-9]\d{9}$/.test(ten) ? `+1${ten}` : null;
}

type BetaUser = { owner_key: string; phone: string; active: boolean };
async function betaUserByOwner(ownerKey: string): Promise<BetaUser | null> {
  const { data } = await createServiceClient().from("client_app_users").select("owner_key, phone, active").eq("owner_key", ownerKey).maybeSingle();
  const u = data as BetaUser | null;
  return u?.active ? u : null;
}
async function betaUserByPhone(phone: string): Promise<BetaUser | null> {
  const { data } = await createServiceClient().from("client_app_users").select("owner_key, phone, active").eq("phone", phone).eq("active", true).limit(1);
  return ((data ?? []) as BetaUser[])[0] ?? null;
}

// ── Session cookie ──────────────────────────────────────────────────────────
function sessionValue(ownerKey: string): string {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${Buffer.from(ownerKey, "utf8").toString("base64url")}.${exp}`;
  return `${payload}.${sign(payload)}`;
}
/** The client this browser is signed in as, or null. */
export function sessionOwner(): string | null {
  const v = cookies().get(COOKIE)?.value ?? "";
  const [o, exp, mac] = v.split(".");
  if (!o || !exp || !mac) return null;
  const want = Buffer.from(sign(`${o}.${exp}`)), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (!(Number(exp) > Date.now())) return null;
  return Buffer.from(o, "base64url").toString("utf8") || null;
}
export function setSession(ownerKey: string) {
  cookies().set(COOKIE, sessionValue(ownerKey), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_DAYS * 86_400 });
}
export function clearSession() {
  cookies().set(COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
}

/** May this request open this client's app? "signin" = she is on the beta list and must sign in first. */
export async function appGate(ownerKey: string): Promise<"ok" | "signin"> {
  const user = await betaUserByOwner(ownerKey);
  if (!user) return "ok";                         // not in the beta: her secret link works as before
  if (sessionOwner() === ownerKey) return "ok";
  const team = await getAuth().catch(() => null); // the team may look at any client's app
  return team?.role ? "ok" : "signin";
}

// ── Asking for a code ───────────────────────────────────────────────────────
export type CodeAnswer =
  | { ok: true; state: "sent" | "closed" }        // closed = sign-in is not switched on yet
  | { ok: false; error: string; status: number };

async function sendEnabled(): Promise<boolean> {
  const { data } = await createServiceClient().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  return (data?.value as { sendEnabled?: boolean } | null)?.sendEnabled === true;
}

/* The answer never says whether a number is on the list — a stranger typing
   numbers learns nothing. */
export async function requestCode(phoneRaw: unknown): Promise<CodeAnswer> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return { ok: false, error: "Type your mobile number, like (555) 123-4567.", status: 400 };
  if (!(await sendEnabled())) return { ok: true, state: "closed" };
  const user = await betaUserByPhone(phone);
  if (!user) return { ok: true, state: "sent" };
  const svc = createServiceClient();
  const { count } = await svc.from("client_app_login_codes").select("id", { count: "exact", head: true })
    .eq("owner_key", user.owner_key).gte("created_at", new Date(Date.now() - 15 * 60_000).toISOString());
  if ((count ?? 0) >= MAX_CODES_PER_15_MIN) return { ok: false, error: "Too many codes. Please wait 15 minutes and try again.", status: 429 };

  const acct = await getReplyAccount().catch(() => null);
  if (!acct) return { ok: false, error: "We couldn't send the code. Please try again.", status: 502 };
  // Her contact in the agency's own account — the text comes from the number she already knows.
  const r = await fetchWithBackoff(`${GHL}/contacts/search/duplicate?locationId=${acct.locationId}&number=${encodeURIComponent(phone)}`, {
    headers: { Authorization: `Bearer ${acct.token}`, Version: "2021-07-28", Accept: "application/json" },
  }).catch(() => null);
  const contact = r?.ok ? (((await r.json().catch(() => null)) as { contact?: { id?: string; phone?: string } | null } | null)?.contact ?? null) : null;
  if (!contact?.id || !String(contact.phone ?? "").replace(/\D/g, "").endsWith(phone.slice(2))) {
    console.error("[client-app signin] no agency contact for a beta user", user.owner_key);
    return { ok: false, error: "We couldn't send the code. Please ask your coach.", status: 502 };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const { error } = await svc.from("client_app_login_codes").insert({
    owner_key: user.owner_key, code_hash: codeHash(user.owner_key, code),
    expires_at: new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
  });
  if (error) return { ok: false, error: "We couldn't send the code. Please try again.", status: 500 };
  const sent = await sendConversationMessage(acct, { contactId: contact.id, message: codeText(code), channel: "SMS" });
  if (!sent.ok) return { ok: false, error: "We couldn't send the code. Please try again.", status: 502 };
  return { ok: true, state: "sent" };
}

// ── Checking the code ───────────────────────────────────────────────────────
export async function verifyCode(phoneRaw: unknown, codeRaw: unknown): Promise<{ ok: true; redirect: string } | { ok: false; error: string; status: number }> {
  const phone = normalizePhone(phoneRaw);
  const code = String(codeRaw ?? "").replace(/\D/g, "");
  const wrong = { ok: false as const, error: "That code is not right. Check the text and try again.", status: 400 };
  if (!phone || code.length !== 6) return wrong;
  const user = await betaUserByPhone(phone);
  if (!user) return wrong;
  const svc = createServiceClient();
  const { data } = await svc.from("client_app_login_codes").select("id, code_hash, attempts")
    .eq("owner_key", user.owner_key).is("used_at", null).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(1);
  const row = ((data ?? []) as Array<{ id: string; code_hash: string; attempts: number }>)[0];
  if (!row) return { ok: false, error: "That code is too old. Ask for a new one.", status: 400 };
  if (row.attempts >= MAX_TRIES) return { ok: false, error: "Too many tries. Ask for a new code.", status: 429 };
  const a = Buffer.from(row.code_hash), b = Buffer.from(codeHash(user.owner_key, code));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await svc.from("client_app_login_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    return wrong;
  }
  await svc.from("client_app_login_codes").update({ used_at: new Date().toISOString() }).eq("id", row.id);
  // Her app address: the link she may already have, or a new one.
  const { data: link } = await svc.from("ppa_portal_links").select("token").eq("owner_key", user.owner_key).maybeSingle();
  let token = (link as { token?: string } | null)?.token ?? null;
  if (!token) {
    token = randomBytes(24).toString("hex");
    const { error } = await svc.from("ppa_portal_links").insert({ owner_key: user.owner_key, token, created_by: "client sign-in" });
    if (error) return { ok: false, error: "We couldn't open your app. Please try again.", status: 500 };
  }
  setSession(user.owner_key);
  return { ok: true, redirect: `/m/${token}` };
}
