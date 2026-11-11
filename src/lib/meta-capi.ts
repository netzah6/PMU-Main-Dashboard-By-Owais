import { createHash } from "node:crypto";

// Meta Conversions API — the server-side twin of the browser pixel.
//
// Roughly a fifth to a third of browser events never reach Meta (iOS
// privacy, ad blockers, Safari ITP), so campaigns optimise on a partial
// picture. We already hold the lead's details server-side, so we send the
// same event again from here with a shared event_id; Meta deduplicates
// and keeps whichever arrived, with much better match quality.
//
// Token: one system-user token in the agency Business Manager covers
// every dataset it has access to (META_CAPI_TOKEN). A client whose
// dataset lives in their own BM can carry its own token in the funnel's
// extras.capiToken.

const GRAPH = "https://graph.facebook.com/v21.0";

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

// Meta wants normalised-then-hashed values: lowercase/trimmed, phone as
// digits with country code, and nothing hashed twice.
function norm(v: string | undefined | null): string | undefined {
  const s = (v ?? "").trim().toLowerCase();
  return s || undefined;
}
function hash(v: string | undefined): string | undefined {
  return v ? sha256(v) : undefined;
}
function phoneDigits(v: string | undefined | null): string | undefined {
  let d = (v ?? "").replace(/\D/g, "");
  if (!d) return undefined;
  if (d.length === 10) d = "1" + d; // US numbers arrive without the country code
  return d;
}

export type CapiUser = {
  email?: string | null;
  phone?: string | null;
  fullName?: string | null;
  fbp?: string | null;   // _fbp cookie
  fbc?: string | null;   // _fbc cookie (click id)
  clientIp?: string | null;
  userAgent?: string | null;
  /* The lead's own stable id (onebox_leads.visitor_id, the page's ob_vid),
     hashed here. Sent on the server Lead AND the later server Purchase, so
     Meta can tie a deposit paid days later in another browser back to the
     same person who clicked the ad (owner 11/10/2026). */
  externalId?: string | null;
};

export type CapiEvent = {
  pixelId: string;
  token: string;
  eventName: "Lead" | "Schedule" | "Purchase";
  eventId: string;          // must match the browser event for dedup
  eventSourceUrl?: string;
  user: CapiUser;
  value?: number;
  currency?: string;
  testEventCode?: string;
  /* Unix seconds of the real moment (a payment found later by the
     safety net); defaults to now. Meta takes up to 7 days back. */
  eventTime?: number;
};

export type CapiResult = { ok: boolean; error?: string; status?: number; code?: number; subcode?: number };

export async function sendCapiEvent(ev: CapiEvent): Promise<CapiResult> {
  if (!ev.pixelId || !ev.token) return { ok: false, error: "missing pixel or token" };

  const [first, ...rest] = (ev.user.fullName ?? "").trim().split(/\s+/);
  const user_data: Record<string, unknown> = {
    em: hash(norm(ev.user.email)),
    ph: hash(phoneDigits(ev.user.phone)),
    fn: hash(norm(first)),
    ln: hash(norm(rest.join(" "))),
    fbp: ev.user.fbp || undefined,
    fbc: ev.user.fbc || undefined,
    client_ip_address: ev.user.clientIp || undefined,
    client_user_agent: ev.user.userAgent || undefined,
    external_id: hash(norm(ev.user.externalId)),
  };
  for (const k of Object.keys(user_data)) if (user_data[k] === undefined) delete user_data[k];

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: ev.eventName,
        event_time: ev.eventTime ?? Math.floor(Date.now() / 1000),
        event_id: ev.eventId,
        action_source: "website",
        ...(ev.eventSourceUrl ? { event_source_url: ev.eventSourceUrl } : {}),
        user_data,
        ...(ev.value != null
          ? { custom_data: { value: ev.value, currency: ev.currency ?? "USD" } }
          : {}),
      },
    ],
    ...(ev.testEventCode ? { test_event_code: ev.testEventCode } : {}),
  };

  /* One quick retry on a Meta hiccup (5xx / 429 / network) with the same
     event_id, so Meta still counts it once. A 4xx is a real rejection
     (permission, bad pixel) — no retry, and Meta's own reason is kept in
     capi_events.error so a dataset the token can't reach is named, not
     just "capi 400" (audit 11/10/2026). */
  let last: CapiResult = { ok: false, error: "network" };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((res) => setTimeout(res, 600));
    try {
      const r = await fetch(`${GRAPH}/${encodeURIComponent(ev.pixelId)}/events?access_token=${encodeURIComponent(ev.token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(attempt ? 5000 : 8000),
      });
      if (r.ok) return { ok: true };
      const t = (await r.text()).slice(0, 600);
      console.error("[capi]", ev.eventName, r.status, t);
      const why = metaError(t);
      last = { ok: false, error: `capi ${r.status}${metaReason(t)}`, status: r.status, code: why?.code, subcode: why?.error_subcode };
      if (r.status < 500 && r.status !== 429) return last;
    } catch (e) {
      console.error("[capi] send failed:", e);
      last = { ok: false, error: "network" };
    }
  }
  return last;
}

function metaError(body: string): { message?: string; code?: number; error_subcode?: number } | null {
  try { return (JSON.parse(body) as { error?: { message?: string; code?: number; error_subcode?: number } }).error ?? null; }
  catch { return null; }
}

/* ": <message> (code N)" from a Graph error body, or "" when unreadable. */
function metaReason(body: string): string {
  const e = metaError(body);
  if (!e?.message) return "";
  return `: ${e.message}${e.code != null ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""})` : ""}`;
}

/* Click id for a server event, best source first: the browser's own _fbc
   cookie, then the one kept with the lead at survey time (a deposit paid
   later from the text link, in another browser, has no cookie), then one
   rebuilt from an fbclid in the page URL. `src` is logged so the share of
   events reaching Meta with a click id can be measured. */
export function pickFbc(cookieFbc: string | null | undefined, leadFbc: string | null | undefined, pageUrl?: string | null): { fbc: string; src: "cookie" | "lead" | "url" | "none" } {
  const c = String(cookieFbc ?? "").trim();
  if (c) return { fbc: c, src: "cookie" };
  const l = String(leadFbc ?? "").trim();
  if (l) return { fbc: l, src: "lead" };
  const id = fbclidOf(pageUrl);
  if (id) return { fbc: `fb.1.${Date.now()}.${id}`, src: "url" };
  return { fbc: "", src: "none" };
}

/* The exact external_id value the server sends (sha256 of the trimmed,
   lowercased visitor id) — handed to the pay-link page so its browser
   events carry the same one; the pixel passes a 64-hex value through. */
export function externalIdHash(v: string | null | undefined): string {
  return hash(norm(v)) ?? "";
}

export function fbclidOf(url: string | null | undefined): string {
  try { return (new URL(String(url ?? "")).searchParams.get("fbclid") ?? "").trim().slice(0, 500); } catch { return ""; }
}

// Which token to use for a funnel: its own if the dataset lives in the
// client's Business Manager, otherwise the agency-wide one.
export function capiToken(extras: { capiToken?: string } | null | undefined): string {
  return capiTokens(extras)[0] ?? "";
}

/* Every token that may reach a dataset, in order: the funnel's own, then
   one per agency Business Manager — META_CAPI_TOKEN (PMU Bookings On
   Demand), META_CAPI_TOKEN_2, _3 … (the other portfolios). The agency's
   datasets live in three portfolios and Meta won't let the newest one
   share datasets yet (owner, 11/11/2026), so each portfolio has its own
   system-user token instead of one shared one. */
export function capiTokens(extras: { capiToken?: string } | null | undefined): string[] {
  const out: string[] = [];
  const add = (v: string | undefined) => { const t = (v ?? "").trim(); if (t && !out.includes(t)) out.push(t); };
  add(extras?.capiToken);
  add(process.env.META_CAPI_TOKEN);
  for (let i = 2; i <= 9; i++) add(process.env[`META_CAPI_TOKEN_${i}`]);
  return out;
}

/* Which token last worked for a pixel (per server instance), so a dataset
   in the 2nd or 3rd portfolio isn't refused by the 1st token every time. */
const tokenForPixel = new Map<string, string>();

/* A refusal that another portfolio's token may not get: the dataset is
   unknown/unreachable for this token (100/33), no permission (10, 200),
   or the token itself is dead (190). */
function wrongToken(r: CapiResult): boolean {
  if (r.ok || !r.status || r.status >= 500 || r.status === 429) return false;
  return (r.code === 100 && r.subcode === 33) || r.code === 10 || r.code === 200 || r.code === 190;
}

/* sendCapiEvent across the portfolio tokens: the one that last worked for
   this pixel first, then the rest until one is accepted. Returns the
   accepted result, or the first refusal when none can reach the dataset. */
export async function sendCapiWithTokens(ev: Omit<CapiEvent, "token">, tokens: string[]): Promise<CapiResult> {
  if (!tokens.length) return { ok: false, error: "no META_CAPI_TOKEN" };
  const known = tokenForPixel.get(ev.pixelId);
  const order = known && tokens.includes(known) ? [known, ...tokens.filter((t) => t !== known)] : tokens;
  let first: CapiResult | null = null;
  for (const token of order) {
    const r = await sendCapiEvent({ ...ev, token });
    if (r.ok) { tokenForPixel.set(ev.pixelId, token); return r; }
    first ??= r;
    if (!wrongToken(r)) return r;
  }
  /* Count first: capi_events.error keeps 200 characters and Meta's message
     is long, so a suffix was cut off (11/11). */
  return first ? { ...first, error: `[no token reaches this dataset, tried ${order.length}] ${first.error ?? "refused"}` } : { ok: false, error: "refused" };
}

/* Every server-side send (or skip) lands in capi_events so the Funnels tab
   can prove Purchase tracking is flowing per funnel and name the reason
   when it isn't (no token, no pixel, Meta rejected). Owner, 2026-10-13:
   "so we know exactly from which ad we get the clients that pay". Logging
   never blocks the request that triggered it. */
type Insertable = { from: (table: string) => { insert: (row: Record<string, unknown>) => PromiseLike<{ error?: { message?: string } | null }> } };
export async function recordCapi(
  svc: Insertable,
  row: { slug: string; eventName: CapiEvent["eventName"]; eventId?: string; pixelId?: string; ok: boolean; error?: string; phone?: string; fbcSrc?: string },
): Promise<void> {
  try {
    /* supabase-js resolves DB errors instead of throwing — read them, or a
       dead log would make the Funnels card read "0 sent ✓" (review, Oct 13). */
    const clean = (v?: string) => (v ?? "").replace(/\0/g, "").slice(0, 200) || null;
    const base = {
      slug: row.slug,
      event_name: row.eventName,
      event_id: clean(row.eventId),
      pixel_id: clean(row.pixelId),
      ok: row.ok,
      error: clean(row.error),
      lead_phone: clean(row.phone),
    };
    let { error } = await svc.from("capi_events").insert(row.fbcSrc ? { ...base, fbc_src: row.fbcSrc } : base);
    /* fbc_src arrived with supabase/purchase-attribution.sql — if that
       column isn't there yet, keep the log row without it. */
    if (error && row.fbcSrc && /fbc_src/.test(error.message ?? "")) ({ error } = await svc.from("capi_events").insert(base));
    if (error) console.error("[capi_events] insert failed:", error.message);
  } catch (e) { console.error("[capi_events] insert threw:", e); /* never costs the lead */ }
}
