import { readFileSync } from "node:fs";
for (const l of readFileSync(".env.local", "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const { buildMonthPlan } = await import("../src/lib/ceo-plan.ts");
const p: any = await buildMonthPlan();
if (p.error) { console.log("ERROR", p.error); process.exit(1); }
console.log(p.label, "goal", p.profitGoal, "| last", p.lastLabel, p.lastProfit);
for (const s of p.sections) {
  console.log(`\n== ${s.title} | target: ${s.target} | last: ${s.last} | ok: ${s.ok}`);
  console.log("   why:", s.why);
  for (const it of s.items) console.log(`   - ${it.text}${it.detail ? "  [" + it.detail + "]" : ""}${it.done ? "  ✓done" : ""}`);
}
