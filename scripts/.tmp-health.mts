import { readFileSync, writeFileSync } from "fs";
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  if (!l.includes("=") || l.startsWith("#")) continue;
  const k = l.slice(0, l.indexOf("=")), v = l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "");
  if (!(k in process.env)) process.env[k] = v;
}
const { getClientHealth } = await import("../src/lib/client-health.ts");
const t0 = Date.now();
const r = await getClientHealth(null);
console.log("ms", Date.now() - t0, "financeError", r.financeError, "ambiguousPayers", r.unmatchedPayers);
const c = r.clients;
const by = (l: string) => c.filter((x) => x.light === l).length;
console.log("green", by("green"), "orange", by("orange"), "red", by("red"));
const reasonCount: Record<string, number> = {};
for (const x of c) for (const re of x.reasons) reasonCount[`${re.light}:${re.key}`] = (reasonCount[`${re.light}:${re.key}`] ?? 0) + 1;
console.log(reasonCount);
const roi = c.filter((x) => x.roi != null).map((x) => x.roi!).sort((a, b) => a - b);
console.log("roi n", roi.length, "p10", roi[Math.floor(roi.length * 0.1)]?.toFixed(2), "p50", roi[Math.floor(roi.length * 0.5)]?.toFixed(2), "p90", roi[Math.floor(roi.length * 0.9)]?.toFixed(2));
writeFileSync("/private/tmp/claude-501/-Users-netzahmizrahi-Run-Claude-Code-Here/e722a9e0-59c7-49fc-a4e2-4330b895a49e/scratchpad/health/out.json", JSON.stringify(c, null, 1));
