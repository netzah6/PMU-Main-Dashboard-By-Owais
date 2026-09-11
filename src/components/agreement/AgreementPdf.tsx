import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import type { Agreement } from "@/lib/agreement";

// The agreement as a PDF, laid out to read like the Canva original: teal
// header bar with the logo, body text, and a "Page X/N" footer strip. Blocks
// flow and wrap across pages on their own; the signature block is kept
// together and never split.

const TEAL = "#2EC4C6";
const INK = "#171717";

const s = StyleSheet.create({
  page: { paddingTop: 92, paddingBottom: 64, paddingHorizontal: 54, fontFamily: "Helvetica", fontSize: 9.5, color: INK, lineHeight: 1.45 },
  bar: { position: "absolute", top: 34, left: 0, right: 0, height: 24, backgroundColor: TEAL },
  logoBox: { position: "absolute", top: 14, left: 54, width: 110, height: 68, backgroundColor: "#ffffff", alignItems: "center", justifyContent: "center" },
  logo: { width: 60, height: 44, objectFit: "contain" },
  wordmark: { fontFamily: "Helvetica-Bold", fontSize: 6.5, marginTop: 2 },
  title: { fontFamily: "Helvetica-Bold", fontSize: 11, marginBottom: 10 },
  heading: { fontFamily: "Helvetica-Bold", fontSize: 10, marginTop: 12, marginBottom: 5 },
  para: { marginBottom: 7 },
  item: { flexDirection: "row", marginBottom: 3, paddingRight: 10 },
  marker: { width: 14 },
  itemText: { flex: 1 },
  sig: { marginTop: 36 },
  sigLine: { marginTop: 26, width: 150, borderBottomWidth: 1, borderBottomColor: INK, borderStyle: "dashed" },
  sigLabel: { marginTop: 3 },
  footer: { position: "absolute", bottom: 0, left: 0, right: 0, height: 34, backgroundColor: "#2b2b2b" },
  footerWedge: { position: "absolute", top: 0, bottom: 0, right: 0, width: 110, backgroundColor: TEAL },
  // Two fixed-width lines rather than one "\n" string: the render-prop Text
  // only lays out reliably when it has explicit bounds.
  footerLine1: { position: "absolute", top: 7, left: 0, width: 485, color: "#ffffff", fontSize: 7.5, textAlign: "center", fontFamily: "Helvetica-Bold" },
  footerLine2: { position: "absolute", top: 18, left: 0, width: 485, color: "#ffffff", fontSize: 7.5, textAlign: "center" },
});

export function AgreementPdf({ agreement, partnerName, logoSrc }: { agreement: Agreement; partnerName?: string; logoSrc: string }) {
  return (
    <Document title={agreement.title} author="PMU Bookings On Demand">
      <Page size="A4" style={s.page} wrap>
        <View style={s.bar} fixed />
        <View style={s.logoBox} fixed>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={logoSrc} style={s.logo} />
          <Text style={s.wordmark}>PMU Bookings On Demand</Text>
        </View>

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

        <View style={s.footer} fixed>
          <View style={s.footerWedge} />
          <Text style={s.footerLine1} fixed>{agreement.footer}</Text>
          <Text style={s.footerLine2} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber}/${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
