/* Name / business keys shared by the LTV + worth code and the Performance
   page (safe to import in the browser). Same rules as client_health_base. */
export const nk = (t: unknown) => String(t ?? "").replace(/\(.*?\)/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Name with the words in any order ("Williams Tabea" = "Tabea Williams").
export const sortedKey = (t: unknown) => nk(t).split(" ").filter(Boolean).sort().join(" ");
export const bizKey = (t: unknown) => String(t ?? "").replace(/\s*-\s*ad\s*account.*$/i, "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Month number = year*12 + month index; label "MM/YYYY".
export const monthLabel = (m: number) => `${String((m % 12) + 1).padStart(2, "0")}/${Math.floor(m / 12)}`;
export const monthNow = () => { const d = new Date(); return d.getFullYear() * 12 + d.getMonth(); };
