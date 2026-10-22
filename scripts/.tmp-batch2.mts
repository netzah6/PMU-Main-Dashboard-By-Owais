import { readFileSync } from "node:fs";
for (const l of readFileSync(".env.local", "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const { startBatch } = await import("../src/lib/winback-sequence.ts");
const { getReplyAccount } = await import("../src/lib/ghl-conversations.ts");
const { createServiceClient } = await import("../src/lib/supabase/server.ts");
const acct = (await getReplyAccount())!;
const r: any = await startBatch(acct, { size: 50, dryRun: true });
const svc = createServiceClient();
const { data: wb } = await svc.from("winback_contacts").select("sheet_row, review_verdict, review_note").in("sheet_row", r.picked.map((p: any) => p.sheetRow));
const v = new Map((wb ?? []).map((x: any) => [x.sheet_row, x]));
console.log("picked", r.picked.length, "skipped", r.skipped.length);
r.picked.forEach((p: any, i: number) => console.log(`${i + 1}|#${p.sheetRow}|${p.name}|${p.business ?? ""}|${p.lastPaid}|${(v.get(p.sheetRow)?.review_note ?? "").slice(0, 140)}`));
console.log("SKIPPED"); for (const s of r.skipped) console.log(`#${s.sheetRow} ${s.name}: ${s.why}`);
