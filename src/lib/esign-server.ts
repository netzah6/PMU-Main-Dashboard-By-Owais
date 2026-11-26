// Server-only side of e-signature agreements: tokens, hashes, the request's
// IP / location, a light rate limit, private storage, and the Go High Level
// note after signing. See src/lib/esign.ts for the templates.

import { createHash, randomBytes } from "crypto";
import type { NextRequest } from "next/server";
import type { createServiceClient } from "@/lib/supabase/server";
import { type Agreement } from "@/lib/agreement";
import { DEFAULT_TEMPLATES, checkTemplate, settingsKey, fingerprintText, type EsignTemplateId, TEMPLATE_LABELS, usDate } from "@/lib/esign";
import { token as ghlToken, BASE, LOC } from "@/lib/power-dialer";
import { dashboardUrl } from "@/lib/agent-notify";

type Svc = ReturnType<typeof createServiceClient>;

export const BUCKET = "agreement-signatures";
export const SELECT_LIST =
  "id, token, template, fields, partner_name, partner_email, partner_phone, created_by, created_at, status, viewed_at, signed_at, signer_name, signed_pdf_path, voided_at, voided_by, ghl_note";

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

/** After signing: a note on the matching contact in the agency location.
 *  Searched by email, then phone. Never throws; returns what happened (kept
 *  on the row). Never texts or emails the client. */
export async function addGhlNote(row: { id: string; template: string; partner_email: string; partner_phone: string | null; signed_at: string }): Promise<{ contactId: string | null; note: string }> {
  try {
    const H = await ghlToken();
    const find = async (key: "email" | "number", val: string): Promise<string | null> => {
      const r = await fetch(`${BASE}/contacts/search/duplicate?locationId=${LOC}&${key}=${encodeURIComponent(val)}`, { headers: H, cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const j = (await r.json().catch(() => ({}))) as { contact?: { id?: string } | null };
      return j.contact?.id ?? null;
    };
    let contactId = row.partner_email ? await find("email", row.partner_email.toLowerCase()) : null;
    if (!contactId && row.partner_phone) {
      const d = row.partner_phone.replace(/\D/g, "");
      const e164 = d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : d.length >= 8 ? `+${d}` : "";
      if (e164) contactId = await find("number", e164);
    }
    if (!contactId) return { contactId: null, note: "No GHL contact found by email or phone — note skipped" };
    const label = TEMPLATE_LABELS[row.template as EsignTemplateId] ?? row.template;
    const body = `Signed ${label} agreement on ${usDate(row.signed_at, "America/Los_Angeles")} - ${dashboardUrl()}/esign?id=${row.id}`;
    const r = await fetch(`${BASE}/contacts/${encodeURIComponent(contactId)}/notes`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(8000),
    });
    return { contactId, note: r.ok ? "Note added in GHL" : `GHL note failed (${r.status})` };
  } catch (e) {
    return { contactId: null, note: `GHL note failed: ${String(e instanceof Error ? e.message : e).slice(0, 160)}` };
  }
}
