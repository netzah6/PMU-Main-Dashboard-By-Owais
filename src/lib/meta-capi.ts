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
};

export async function sendCapiEvent(ev: CapiEvent): Promise<{ ok: boolean; error?: string }> {
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
  };
  for (const k of Object.keys(user_data)) if (user_data[k] === undefined) delete user_data[k];

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: ev.eventName,
        event_time: Math.floor(Date.now() / 1000),
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

  try {
    const r = await fetch(`${GRAPH}/${encodeURIComponent(ev.pixelId)}/events?access_token=${encodeURIComponent(ev.token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const t = (await r.text()).slice(0, 300);
      console.error("[capi]", ev.eventName, r.status, t);
      return { ok: false, error: `capi ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error("[capi] send failed:", e);
    return { ok: false, error: "network" };
  }
}

// Which token to use for a funnel: its own if the dataset lives in the
// client's Business Manager, otherwise the agency-wide one.
export function capiToken(extras: { capiToken?: string } | null | undefined): string {
  return (extras?.capiToken ?? "").trim() || (process.env.META_CAPI_TOKEN ?? "").trim();
}
