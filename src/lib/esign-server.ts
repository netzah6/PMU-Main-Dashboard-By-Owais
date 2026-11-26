// Server-only side of e-signature agreements: tokens, hashes, the request's
// IP / location, a light rate limit, private storage, and the Go High Level
// note after signing. See src/lib/esign.ts for the templates.

import { createHash, randomBytes } from "crypto";
import type { NextRequest } from "next/server";
import type { createServiceClient } from "@/lib/supabase/server";
import { type Agreement } from "@/lib/agreement";
import { DEFAULT_TEMPLATES, checkTemplate, settingsKey, fingerprintText, type EsignTemplateId, TEMPLATE_LABELS, usDate } from "@/lib/esign";
import { token as ghlToken, BASE, LOC, enrollInWorkflow } from "@/lib/power-dialer";
import { dashboardUrl } from "@/lib/agent-notify";

type Svc = ReturnType<typeof createServiceClient>;

export const BUCKET = "agreement-signatures";
export const SELECT_LIST =
  "id, token, template, fields, partner_name, partner_email, partner_phone, created_by, created_at, status, viewed_at, signed_at, signer_name, signed_pdf_path, voided_at, voided_by, ghl_note";

/** Signed rows for the whole sales team: no token, no phone. */
export const SIGNED_LIST =
  "id, template, fields, partner_name, partner_email, created_by, created_at, status, signed_at, signer_name, signed_pdf_path";

export const ESIGN_ROLES = new Set(["admin", "sales", "closer", "setter"]);

/** 32 random bytes, URL-safe (43 chars). */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
export function contentHash(a: Agreement): string {
  return sha256(fingerprintText(a));
}

/** The wording in use: an admin override from app_settings when it is still
 *  valid (placeholders intact), otherwise the code default. */
export async function loadTemplate(svc: Svc, t: EsignTemplateId): Promise<{ template: Agreement; overridden: boolean }> {
  const { data } = await svc.from("app_settings").select("value").eq("key", settingsKey(t)).maybeSingle();
  if (data?.value) {
    const { template } = checkTemplate(t, data.value);
    if (template) return { template, overridden: true };
  }
  return { template: DEFAULT_TEMPLATES[t], overridden: false };
}

export function clientIp(req: NextRequest): string {
  return (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "").trim().slice(0, 64);
}

/** "City, Region, Country" from Vercel's geo headers ("" when absent, e.g. locally). */
export function clientLocation(req: NextRequest): string {
  const dec = (v: string | null) => { if (!v) return ""; try { return decodeURIComponent(v); } catch { return v; } };
  const parts = [dec(req.headers.get("x-vercel-ip-city")), dec(req.headers.get("x-vercel-ip-country-region")), dec(req.headers.get("x-vercel-ip-country"))]
    .map((p) => p.trim()).filter(Boolean);
  return parts.join(", ").slice(0, 160);
}

export function userAgent(req: NextRequest): string {
  return (req.headers.get("user-agent") || "").slice(0, 400);
}

/** Origin the link should use: the host the salesperson is on. */
export function requestOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const proto = req.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return host ? `${proto}://${host}` : dashboardUrl();
}

/** Branded link domain (owner, 11/26/2026): app_settings "esign_link_origin"
 *  — e.g. "https://book.pmubookingsondemand.com" — when set, every signing
 *  link uses it. The value may be the string itself or { origin: "…" }. */
export const LINK_ORIGIN_KEY = "esign_link_origin";

/** A bare https origin ("https://host[:port]", no path/query), or null. */
export function cleanOrigin(v: unknown): string | null {
  const raw = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { origin?: unknown }).origin === "string" ? (v as { origin: string }).origin : "";
  const s = raw.trim().replace(/\/+$/, "");
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.username || u.password || u.origin !== s) return null;
    return u.origin;
  } catch { return null; }
}

/** The origin for signing links: the setting when valid, else the request's host. */
export async function linkOrigin(svc: Svc, req: NextRequest): Promise<string> {
  try {
    const { data } = await svc.from("app_settings").select("value").eq("key", LINK_ORIGIN_KEY).maybeSingle();
    const o = cleanOrigin(data?.value);
    if (o) return o;
  } catch { /* fall back */ }
  return requestOrigin(req);
}

// Light per-instance rate limit (serverless instances each keep their own
// map, so this only slows a single abuser down — the token + status checks
// are the real protection).
const hits = new Map<string, number[]>();
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) { for (const k of hits.keys()) { hits.delete(k); if (hits.size < 2500) break; } }
  return list.length > max;
}

/** Upload to the private bucket, creating the bucket the first time. */
export async function putPrivate(svc: Svc, path: string, body: Buffer, contentType: string): Promise<string | null> {
  const up = () => svc.storage.from(BUCKET).upload(path, body, { contentType, upsert: false });
  let { error } = await up();
  if (error && /bucket.*not.*found|not found/i.test(error.message)) {
    await svc.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 10 * 1024 * 1024, allowedMimeTypes: ["image/png", "application/pdf"] }).catch(() => null);
    ({ error } = await up());
  }
  return error ? error.message : null;
}

export async function getPrivate(svc: Svc, path: string): Promise<Buffer | null> {
  const { data, error } = await svc.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/** Validate a signature image: PNG data URL, real PNG bytes, under 300 KB. */
export function parseSignaturePng(v: unknown): Buffer | null {
  const s = typeof v === "string" ? v : "";
  const prefix = "data:image/png;base64,";
  if (!s.startsWith(prefix) || s.length > 420_000) return null;
  const b64 = s.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 100 || buf.length > 300 * 1024) return null;
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!magic.every((m, i) => buf[i] === m)) return null;
  return buf;
}

export function cleanText(v: unknown, max: number): string {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function noStoreHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
}

/** Go High Level workflow "Agreement signed -> Slack Channel" (agency
 *  location, published, allows re-entry). It posts "<name> just signed the
 *  agreement!" to Slack #agreements-signed, adds a row to the "Signed
 *  Agreements" sheet and tags the contact "signed". It sends nothing to the
 *  client. */
export const SIGNED_SLACK_WORKFLOW_ID = "6504035d-832a-4924-857c-59f3bc2e4d32";

function e164(phone: string | null | undefined): string {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : d.length >= 8 && d.length <= 15 ? `+${d}` : "";
}

/** After signing, in the agency location: find the client's contact (email,
 *  then phone) or create it, add a note, and start the "Agreement signed ->
 *  Slack Channel" workflow so the sales team sees the signing in Slack.
 *  Never throws; returns what happened (kept on the row). Never texts or
 *  emails the client. */
export async function ghlAfterSigning(row: {
  id: string; template: string; partner_name: string; partner_email: string; partner_phone: string | null;
  signer_name: string; signer_email: string; signed_at: string;
}): Promise<{ contactId: string | null; note: string }> {
  const steps: string[] = [];
  let contactId: string | null = null;
  try {
    const H = await ghlToken();
    const find = async (key: "email" | "number", val: string): Promise<string | null> => {
      const r = await fetch(`${BASE}/contacts/search/duplicate?locationId=${LOC}&${key}=${encodeURIComponent(val)}`, { headers: H, cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const j = (await r.json().catch(() => ({}))) as { contact?: { id?: string } | null };
      return j.contact?.id ?? null;
    };
    // Search ONLY by what our team entered (partner email, then phone). The
    // email the client types on the public page is never searched: it could
    // match someone else's contact (wrong "signed" tag + Slack line).
    const partnerEmail = (row.partner_email || "").trim().toLowerCase();
    if (partnerEmail) contactId = await find("email", partnerEmail);
    const phone = e164(row.partner_phone);
    if (!contactId && phone) contactId = await find("number", phone);

    /* No contact: do NOT create one. A brand-new contact (or the "signed"
       tag on it) could start other agency automations that text the client,
       and those were not checked (owner rule: no client messages without
       approval). The team sees this note and can add the contact by hand. */
    if (!contactId) return { contactId: null, note: "No GHL contact with this email/phone - Slack line not sent" };

    // Note on the contact.
    try {
      const label = TEMPLATE_LABELS[row.template as EsignTemplateId] ?? row.template;
      const body = `Signed ${label} agreement on ${usDate(row.signed_at, "America/Los_Angeles")} - ${dashboardUrl()}/esign?id=${row.id}`;
      const r = await fetch(`${BASE}/contacts/${encodeURIComponent(contactId)}/notes`, {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(8000),
      });
      steps.push(r.ok ? "Note added" : `Note failed (${r.status})`);
    } catch (e) { steps.push(`Note failed: ${String(e instanceof Error ? e.message : e).slice(0, 80)}`); }

    // Slack line + sheet row + "signed" tag, via the existing workflow.
    try {
      const w = await enrollInWorkflow(SIGNED_SLACK_WORKFLOW_ID, [contactId], { timeoutMs: 8000, tries: 2 });
      steps.push(w.ok.length ? "Slack workflow started" : `Slack workflow failed (${w.failed[0]?.error ?? "unknown"})`);
    } catch (e) { steps.push(`Slack workflow failed: ${String(e instanceof Error ? e.message : e).slice(0, 80)}`); }

    return { contactId, note: steps.join(" · ").slice(0, 400) };
  } catch (e) {
    steps.push(`GHL failed: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    return { contactId, note: steps.join(" · ").slice(0, 400) };
  }
}
