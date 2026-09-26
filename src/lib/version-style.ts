// The one palette for a client's program mark (V3 / V2.3 / V1). These are
// the exact colours the Clients main-menu tab paints its Version chip with —
// blue for V3, purple for V2.3 — so the same program reads the same wherever
// it is marked (owner, 2026-09-26: "wherever there is the V3 or V2.3 mark it
// with the same blue / purple color that we have on the clients main menu tab").
//
// This is a copy, not yet the single source: src/components/clients/
// ClientProfile.tsx keeps its own identical versionStyle() because an
// unrelated PR (#581) owns that file, and reports/page.tsx has a third copy
// that can switch over to this one later. Keep the hexes identical in all
// three until they can be folded into this module.

export function versionStyle(v: string): { bg: string; text: string; border: string } {
  const u = v.toLowerCase();
  if (u.includes("not interested")) return { bg: "#fde8ee", text: "#e11d48", border: "#f5c2cf" };
  if (u.includes("v2.3") || u.includes("v2.2")) return { bg: "#f3e8ff", text: "#7e22ce", border: "#e3cffb" }; // purple
  if (u.includes("v3")) return { bg: "#1d4ed8", text: "#ffffff", border: "#1d4ed8" }; // blue
  if (u.includes("v2")) return { bg: "#dcf5e0", text: "#15803d", border: "#bce6c8" }; // green
  return { bg: "#f1f5f9", text: "#64748b", border: "#d7e0ea" }; // V1 / other / empty
}
