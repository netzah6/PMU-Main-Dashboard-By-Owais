import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { waitUntil } from "@vercel/functions";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { parseAgreement } from "@/lib/agreement";
import { CONSENT_TEXT, TEMPLATE_LABELS, type EsignTemplateId } from "@/lib/esign";
import {
  TOKEN_RE, rateLimited, clientIp, clientLocation, userAgent, contentHash, sha256, parseSignaturePng, cleanText, EMAIL_RE,
  putPrivate, noStoreHeaders, ghlAfterSigning,
} from "@/lib/esign-server";
import { buildSignedPdf } from "@/lib/esign-pdf";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Public signing endpoint (no login): the secret token in the path is the
// only key. GET shows the frozen agreement and records the first open;
// POST signs it once. Every check happens here, on the server.

const ROW = "id, token, template, content, content_sha256, partner_name, partner_email, partner_phone, created_by, created_at, status, viewed_at, signed_at, signer_name, signer_email, signed_pdf_path";

function deny(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status, headers: noStoreHeaders() });
}

function publicView(row: Record<string, unknown>) {
  return {
    template: row.template,
    templateLabel: TEMPLATE_LABELS[row.template as EsignTemplateId] ?? "",
    content: row.content,
    partnerName: row.partner_name,
    partnerEmail: row.partner_email,
    status: row.status === "viewed" ? "sent" : row.status,
    signedAt: row.signed_at,
    signerName: row.signer_name,
    consentText: CONSENT_TEXT,
    reference: String(row.id).toUpperCase(),
  };
}

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = clientIp(req);
  if (rateLimited(`view:${ip}`, 60, 60_000)) return deny("Too many requests — wait a minute and try again", 429);
  if (!TOKEN_RE.test(params.token)) return deny("This link is not valid", 404);
  const svc = createServiceClient();
  const { data: row } = await svc.from("agreement_signatures").select(ROW).eq("token", params.token).maybeSingle();
  if (!row) return deny("This link is not valid", 404);
  if (row.status === "void") return deny("This agreement was cancelled. Please ask your PMU Bookings On Demand contact for a new link.", 410);

  // First open by the client → viewed. A team member checking the link
  // while logged in to the dashboard is not counted.
  if (!row.viewed_at && row.status === "sent") {
    const team = await getAuth().catch(() => null);
    if (!team?.role) {
      await svc.from("agreement_signatures")
        .update({ status: "viewed", viewed_at: new Date().toISOString(), view_ip: ip || null, view_user_agent: userAgent(req) || null })
        .eq("id", row.id).is("viewed_at", null).eq("status", "sent");
    }
  }
  return NextResponse.json(publicView(row), { headers: noStoreHeaders() });
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = clientIp(req);
  if (rateLimited(`sign:${ip}`, 10, 10 * 60_000)) return deny("Too many tries — wait a few minutes and try again", 429);
  if (!TOKEN_RE.test(params.token)) return deny("This link is not valid", 404);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 600_000) return deny("Signature is too large", 413);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const signerName = cleanText(body.name, 120);
  const signerEmail = cleanText(body.email, 200).toLowerCase();
  const method = body.method === "typed" ? "typed" : "drawn";
  const tzRaw = cleanText(body.timezone, 64);
  let timezone = "UTC";
  try { if (tzRaw && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tzRaw)) { new Intl.DateTimeFormat("en-US", { timeZone: tzRaw }); timezone = tzRaw; } } catch { /* keep UTC */ }
  if (signerName.length < 2) return deny("Type your full legal name", 400);
  if (!EMAIL_RE.test(signerEmail)) return deny("Type a valid email", 400);
  if (body.consent !== true) return deny("Please tick the box to agree", 400);
  const png = parseSignaturePng(body.signature);
  if (!png) return deny("Please draw or type your signature again", 400);

  const svc = createServiceClient();
  const { data: row } = await svc.from("agreement_signatures").select(ROW).eq("token", params.token).maybeSingle();
  if (!row) return deny("This link is not valid", 404);
  if (row.status === "void") return deny("This agreement was cancelled", 410);
  if (row.status === "signed") return NextResponse.json(publicView(row), { status: 409, headers: noStoreHeaders() });

  // The text must be exactly what was sent.
  const content = parseAgreement(row.content);
  if (!content || contentHash(content) !== row.content_sha256) return deny("This agreement could not be checked. Please ask for a new link.", 409);

  const now = new Date().toISOString();
  const viewedAt = row.viewed_at ?? now;
  const location = clientLocation(req);
  const ua = userAgent(req);
  const nonce = randomBytes(6).toString("hex");

  // Signature image first, then the signed PDF — both in the private bucket,
  // under paths unique to this attempt (a lost race never overwrites the
  // winner's files).
  const sigPath = `signatures/${row.id}-${nonce}.png`;
  const sigErr = await putPrivate(svc, sigPath, png, "image/png");
  if (sigErr) return deny("Could not save your signature — please try again", 502);

  let pdf: Buffer;
  try {
    pdf = await buildSignedPdf({
      id: row.id, template: row.template as EsignTemplateId, content, contentSha256: row.content_sha256,
      createdAt: row.created_at, createdBy: row.created_by, partnerName: row.partner_name, partnerEmail: row.partner_email,
      viewedAt, signedAt: now, signerName, signerEmail, signerIp: ip, signerLocation: location, signerUserAgent: ua,
      signerTimezone: timezone, signatureMethod: method, signaturePng: png,
    });
  } catch (e) {
    console.error("esign pdf build failed", e);
    /* Vercel logs are not readable from here — leave a trace in the DB. */
    const err = e instanceof Error ? `${e.message}\n${(e.stack ?? "").slice(0, 1500)}` : String(e);
    await svc.from("app_settings").upsert({ key: "esign_last_error", value: { at: new Date().toISOString(), id: row.id, err }, updated_at: new Date().toISOString() }).then(() => null, () => null);
    return deny("Could not build the signed copy — please try again", 500);
  }
  const pdfPath = `signed/${row.id}-${nonce}.pdf`;
  const pdfErr = await putPrivate(svc, pdfPath, pdf, "application/pdf");
  if (pdfErr) return deny("Could not save the signed copy — please try again", 502);

  const { data: signed, error } = await svc.from("agreement_signatures").update({
    status: "signed", signed_at: now, viewed_at: viewedAt, view_ip: row.viewed_at ? undefined : ip || null,
    signer_name: signerName, signer_email: signerEmail, signer_ip: ip || null, signer_location: location || null,
    signer_user_agent: ua || null, signer_timezone: timezone, signature_method: method, signature_png: sigPath,
    consent_text: CONSENT_TEXT, signed_pdf_path: pdfPath, signed_pdf_sha256: sha256(pdf),
  }).eq("id", row.id).in("status", ["sent", "viewed"]).select(ROW).maybeSingle();
  if (error) return deny("Could not save — please try again", 500);
  if (!signed) {
    // Someone signed (or voided) a moment ago — show the current state.
    const { data: cur } = await svc.from("agreement_signatures").select(ROW).eq("id", row.id).maybeSingle();
    return NextResponse.json(cur ? publicView(cur) : { error: "Already handled" }, { status: 409, headers: noStoreHeaders() });
  }

  // Go High Level: note on the contact + the "Agreement signed -> Slack
  // Channel" workflow (Slack line for the sales team). Runs only after the
  // row is saved as signed, AFTER the reply (waitUntil, off the client's
  // clock), capped at 30 s so it ends well inside maxDuration. Never blocks
  // or fails the signing.
  const GHL_CAP_MS = 30_000;
  waitUntil((async () => {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const capped = new Promise<{ contactId: string | null; note: string }>((res) => {
        timer = setTimeout(() => res({ contactId: null, note: "GHL timed out (30 s) - check the Slack channel" }), GHL_CAP_MS);
      });
      const r = await Promise.race([
        ghlAfterSigning({
          id: row.id, template: row.template, partner_name: row.partner_name, partner_email: row.partner_email, partner_phone: row.partner_phone,
          signer_name: signerName, signer_email: signerEmail, signed_at: now,
        }),
        capped,
      ]);
      clearTimeout(timer);
      await svc.from("agreement_signatures").update({ ghl_contact_id: r.contactId, ghl_note: r.note }).eq("id", row.id);
    } catch { /* ignore */ }
  })());

  return NextResponse.json(publicView(signed), { headers: noStoreHeaders() });
}
