import { readFileSync } from "node:fs";
for (const l of readFileSync(".env.local", "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const { startBatch, runSequence, TEMPLATES } = await import("../src/lib/winback-sequence.ts");
const { getReplyAccount } = await import("../src/lib/ghl-conversations.ts");
const acct = (await getReplyAccount())!;
const r: any = await startBatch(acct, { size: 20, dryRun: true });
console.log("dryRun", r.dryRun, "| eligible", r.eligible, "| picked", r.picked.length, "| skipped", r.skipped.length);
r.picked.forEach((p: any, i: number) => console.log(`  ${i + 1}. #${p.sheetRow} ${p.name}${p.business ? " (" + p.business + ")" : ""} · last paid ${p.lastPaid} · offer ${p.offer ?? "none"} · tz ${p.timezone ?? "?"} · first "${p.firstName ?? ""}"`));
console.log("skipped:"); r.skipped.forEach((s: any) => console.log(`  #${s.sheetRow} ${s.name}: ${s.why}`));
console.log("\nDay-0 text:", TEMPLATES.step1);
const seq: any = await runSequence(acct, { dryRun: true });
console.log("runSequence dry:", JSON.stringify({ checked: seq.checked, due: seq.due, sent: seq.sent?.length, replied: seq.replied?.length, stopped: seq.stopped?.length }));
