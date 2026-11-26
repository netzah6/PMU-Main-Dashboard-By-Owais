// Builds the signed copy on the server: the agreement pages in the same
// layout as the dashboard PDF (teal bar, logo, dark footer), the signature
// block filled in, "Document Ref: <id>  Page X/N" on every page, and a final
// Signature Certificate page with the audit trail.

import { readFile } from "fs/promises";
import path from "path";
import { renderToBuffer } from "@react-pdf/renderer";
import { AgreementPdf } from "@/components/agreement/AgreementPdf";
import type { Agreement } from "@/lib/agreement";
import { CONSENT_TEXT, TEMPLATE_LABELS, usDate, usDateTime, type EsignTemplateId } from "@/lib/esign";

let logoCache: string | null = null;
async function logo(): Promise<string> {
  if (logoCache) return logoCache;
  const buf = await readFile(path.join(process.cwd(), "public", "brand-logo.png"));
  logoCache = `data:image/png;base64,${buf.toString("base64")}`;
  return logoCache;
}

export type SignedPdfInput = {
  id: string;
  template: EsignTemplateId;
  content: Agreement;
  contentSha256: string;
  createdAt: string;
  createdBy: string | null;
  partnerName: string;
  partnerEmail: string;
  viewedAt: string | null;
  signedAt: string;
  signerName: string;
  signerEmail: string;
  signerIp: string;
  signerLocation: string;
  signerUserAgent: string;
  signerTimezone: string;
  signatureMethod: "drawn" | "typed";
  signaturePng: Buffer;
};

export async function buildSignedPdf(x: SignedPdfInput): Promise<Buffer> {
  const sig = `data:image/png;base64,${x.signaturePng.toString("base64")}`;
  const ref = x.id.toUpperCase();
  return renderToBuffer(
    <AgreementPdf
      agreement={x.content}
      logoSrc={await logo()}
      docRef={ref}
      signature={{ name: x.signerName, imageSrc: sig, dateText: `${usDate(x.signedAt)} (UTC)` }}
      certificate={{
        reference: ref,
        templateLabel: TEMPLATE_LABELS[x.template],
        sentOn: usDateTime(x.createdAt),
        sentBy: x.createdBy,
        sentTo: `${x.partnerName} <${x.partnerEmail}>`,
        signerName: x.signerName,
        signerEmail: x.signerEmail,
        viewedOn: usDateTime(x.viewedAt ?? x.signedAt),
        signedOn: usDateTime(x.signedAt),
        ip: x.signerIp || "unknown",
        location: x.signerLocation || "unknown",
        device: x.signerUserAgent || "unknown",
        signatureSrc: sig,
        signatureMethod: x.signatureMethod === "typed" ? "typed by the signer" : "drawn by the signer",
        fingerprint: x.contentSha256,
        consent: CONSENT_TEXT,
        completedOn: usDateTime(x.signedAt),
      }}
    />,
  );
}
