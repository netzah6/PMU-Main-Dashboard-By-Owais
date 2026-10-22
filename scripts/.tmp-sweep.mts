import { readFileSync } from "node:fs";
for (const l of readFileSync(".env.local", "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const { runSequence } = await import("../src/lib/winback-sequence.ts");
const { getReplyAccount } = await import("../src/lib/ghl-conversations.ts");
const acct = (await getReplyAccount())!;
const r: any = await runSequence(acct, { dryRun: true });
console.log(JSON.stringify({ checked: r.checked, unchecked: r.unchecked, due: r.due, sent: r.sent.length, replied: r.replied, stopped: r.stopped, skipped: r.skipped }, null, 1));
