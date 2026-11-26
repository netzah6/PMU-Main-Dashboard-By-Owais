import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import type { Agreement } from "@/lib/agreement";

// The agreement as a PDF, laid out to read like the Canva original: teal
// header bar with the logo, body text, and a "Page X/N" footer strip. Blocks
// flow and wrap across pages on their own; the signature block is kept
// together and never split.

const TEAL = "#2EC4C6";
const INK = "#171717";

const s = StyleSheet.create({
  page: { paddingTop: 102, paddingBottom: 64, paddingHorizontal: 54, fontFamily: "Helvetica", fontSize: 9.5, color: INK, lineHeight: 1.45 },
  bar: { position: "absolute", top: 34, left: 0, right: 0, height: 24, backgroundColor: TEAL },
  // Logo made bigger 11/26/2026 (owner: "look like a professional agreement").
  logoBox: { position: "absolute", top: 8, left: 50, width: 132, height: 86, backgroundColor: "#ffffff", alignItems: "center", justifyContent: "center" },
  logo: { width: 82, height: 64, objectFit: "contain" },
  wordmark: { fontFamily: "Helvetica-Bold", fontSize: 7.5, marginTop: 3 },
  title: { fontFamily: "Helvetica-Bold", fontSize: 11, marginBottom: 10 },
  heading: { fontFamily: "Helvetica-Bold", fontSize: 10, marginTop: 12, marginBottom: 5 },
  para: { marginBottom: 7 },
  item: { flexDirection: "row", marginBottom: 3, paddingRight: 10 },
  marker: { width: 14 },
  itemText: { flex: 1 },
  sig: { marginTop: 36 },
  sigLine: { marginTop: 26, width: 150, borderBottomWidth: 1, borderBottomColor: INK, borderStyle: "dashed" },
  sigLabel: { marginTop: 3 },
  sigValue: { marginTop: 26, fontFamily: "Helvetica-Bold", fontSize: 10.5 },
  sigImage: { marginTop: 10, width: 170, height: 57, objectFit: "contain", objectPositionX: 0 },
  certIntro: { color: "#555555", marginBottom: 10 },
  certRow: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: "#dddddd" },
  certLabel: { width: 165, fontFamily: "Helvetica-Bold", fontSize: 8.5, color: "#444444", paddingRight: 8 },
  certValue: { flex: 1, fontSize: 8.5 },
  mono: { fontFamily: "Courier", fontSize: 8 },
  certSig: { width: 170, height: 57, objectFit: "contain", objectPositionX: 0 },
  certDone: { marginTop: 16, fontFamily: "Helvetica-Bold", fontSize: 9.5 },
  certNote: { marginTop: 8, fontSize: 7.5, color: "#666666" },
  footer: { position: "absolute", bottom: 0, left: 0, right: 0, height: 34, backgroundColor: "#2b2b2b" },
  footerWedge: { position: "absolute", top: 0, bottom: 0, right: 0, width: 110, backgroundColor: TEAL },
  // Two fixed-width lines rather than one "\n" string: the render-prop Text
  // only lays out reliably when it has explicit bounds.
  footerLine1: { position: "absolute", top: 7, left: 0, width: 485, color: "#ffffff", fontSize: 7.5, textAlign: "center", fontFamily: "Helvetica-Bold" },
  footerLine2: { position: "absolute", top: 18, left: 0, width: 485, color: "#ffffff", fontSize: 7.5, textAlign: "center" },
});

/** Filled-in signature block (e-signed copy). */
export type PdfSignature = { name: string; imageSrc: string; dateText: string };

/** The "Signature Certificate" page of an e-signed copy — the audit trail
 *  Go High Level puts on its signed documents, plus a little more. */
export type PdfCertificate = {
  reference: string;
  templateLabel: string;
  sentOn: string;        // UTC text
  sentBy?: string | null;
  sentTo: string;        // name + email the link was made for
  signerName: string;
  signerEmail: string;
  viewedOn: string;
  signedOn: string;
  ip: string;
  location: string;
  device: string;
  signatureSrc: string;
  signatureMethod: string;
  fingerprint: string;   // SHA-256 of the agreement text
  consent: string;
  completedOn: string;
};

function Chrome({ footer, docRef }: { footer: string; docRef?: string }) {
  return (
    <View style={s.footer} fixed>
      <View style={s.footerWedge} />
      <Text style={s.footerLine1} fixed>{footer}</Text>
      <Text style={s.footerLine2} fixed render={({ pageNumber, totalPages }) => `${docRef ? `Document Ref: ${docRef}    ` : ""}Page ${pageNumber}/${totalPages}`} />
    </View>
  );
}

function Header({ logoSrc }: { logoSrc: string }) {
  return (
    <>
      <View style={s.bar} fixed />
      <View style={s.logoBox} fixed>
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <Image src={logoSrc} style={s.logo} />
        <Text style={s.wordmark}>PMU Bookings On Demand</Text>
      </View>
    </>
  );
}

function CertRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={s.certRow} wrap={false}>
      <Text style={s.certLabel}>{label}</Text>
      <Text style={mono ? [s.certValue, s.mono] : s.certValue}>{value || "—"}</Text>
    </View>
  );
}

export function AgreementPdf({ agreement, partnerName, logoSrc, signature, docRef, certificate }: {
  agreement: Agreement; partnerName?: string; logoSrc: string;
  signature?: PdfSignature; docRef?: string; certificate?: PdfCertificate;
}) {
  return (
    <Document title={agreement.title} author="PMU Bookings On Demand" subject={docRef ? `Document Ref: ${docRef}` : undefined}>
      <Page size="A4" style={s.page} wrap>
        <Header logoSrc={logoSrc} />

        <Text style={s.title}>{agreement.title}</Text>
        {agreement.blocks.map((b, i) => {
          if (b.type === "heading") return <Text key={i} style={s.heading}>{b.text}</Text>;
          if (b.type === "paragraph") return <Text key={i} style={s.para}>{b.text}</Text>;
          if (b.type === "bullets" || b.type === "numbered") {
            return (
              <View key={i} style={{ marginBottom: 6 }}>
                {b.items.map((it, n) => (
                  <View key={n} style={s.item} wrap={false}>
                    <Text style={s.marker}>{b.type === "bullets" ? "•" : `${n + 1})`}</Text>
                    <Text style={s.itemText}>{it}</Text>
                  </View>
                ))}
              </View>
            );
          }
          if (signature) {
            return (
              <View key={i} style={s.sig} wrap={false}>
                <Text style={s.sigValue}>{signature.name}</Text>
                <View style={[s.sigLine, { marginTop: 2 }]} />
                <Text style={s.sigLabel}>Partner Full Name</Text>
                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                <Image src={signature.imageSrc} style={s.sigImage} />
                <View style={[s.sigLine, { marginTop: 2 }]} />
                <Text style={s.sigLabel}>Partner Signature</Text>
                <Text style={[s.sigValue, { marginTop: 20 }]}>{signature.dateText}</Text>
                <View style={[s.sigLine, { marginTop: 2 }]} />
                <Text style={s.sigLabel}>Date</Text>
              </View>
            );
          }
          return (
            <View key={i} style={s.sig} wrap={false}>
              <View style={s.sigLine} />
              <Text style={s.sigLabel}>Partner Full Name{partnerName ? `: ${partnerName}` : ""}</Text>
              <View style={s.sigLine} />
              <Text style={s.sigLabel}>Partner Signature</Text>
              <View style={s.sigLine} />
              <Text style={s.sigLabel}>Date</Text>
            </View>
          );
        })}

        <Chrome footer={agreement.footer} docRef={docRef} />
      </Page>

      {certificate && (
        <Page size="A4" style={s.page}>
          <Header logoSrc={logoSrc} />
          <Text style={s.title}>Signature Certificate</Text>
          <Text style={s.certIntro}>{`${certificate.templateLabel} · ${agreement.title}`}</Text>
          <CertRow label="Reference number" value={certificate.reference} mono />
          <CertRow label="Sent on (UTC)" value={certificate.sentOn} />
          {certificate.sentBy ? <CertRow label="Sent by" value={certificate.sentBy} /> : null}
          <CertRow label="Sent to" value={certificate.sentTo} />
          <Text style={s.heading}>Signer</Text>
          <CertRow label="Name" value={certificate.signerName} />
          <CertRow label="Email" value={certificate.signerEmail} />
          <CertRow label="Viewed on (UTC)" value={certificate.viewedOn} />
          <CertRow label="Signed on (UTC)" value={certificate.signedOn} />
          <CertRow label="IP address" value={certificate.ip} mono />
          <CertRow label="Location" value={certificate.location} />
          <CertRow label="Device / browser" value={certificate.device} />
          <View style={s.certRow} wrap={false}>
            <Text style={s.certLabel}>{`Signature (${certificate.signatureMethod})`}</Text>
            <View style={s.certValue}>
              {/* eslint-disable-next-line jsx-a11y/alt-text */}
              <Image src={certificate.signatureSrc} style={s.certSig} />
            </View>
          </View>
          <Text style={s.heading}>Document</Text>
          <CertRow label="Fingerprint (SHA-256 of the document text)" value={certificate.fingerprint} mono />
          <CertRow label="Consent" value={`"${certificate.consent}" (ticked by the signer before signing)`} />
          <Text style={s.certDone}>{`Document completed by all parties on ${certificate.completedOn} (UTC)`}</Text>
          <Text style={s.certNote}>{"Signed electronically on PMU Bookings On Demand's own signing page. The fingerprint above is taken over the full document text frozen when the signing link was created; any change to that text gives a different fingerprint."}</Text>
          <Chrome footer={agreement.footer} docRef={docRef} />
        </Page>
      )}
    </Document>
  );
}
