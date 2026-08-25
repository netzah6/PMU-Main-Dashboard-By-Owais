import { readFileSync } from "node:fs";
const snap=JSON.parse(readFileSync("/private/tmp/claude-501/-Users-netzahmizrahi-Run-Claude-Code-Here/e722a9e0-59c7-49fc-a4e2-4330b895a49e/scratchpad/deposits-snapshot-final.json","utf8"));
const bySheet=new Map(snap.filter(r=>r.sheet_row!=null).map(r=>[r.sheet_row,r.data]));
const BLANKED=[61,123,129,175,195,212,227,244,252,254,264,272,281,292,312,335,345,351,357,458,473,606,616,624,648,664,668,672,674,698,699,700,783,786,807];
console.log("=== what USED to live at rows 61-75 (before cleanup) ===");
for(let n=61;n<=75;n++){const d=bySheet.get(n);
 console.log(`row ${n}${BLANKED.includes(n)?' [was blanked]':''}: ${d?`${String(d['Full Name']||'?').slice(0,20)} | ${String(d['Business Name']||'?').slice(0,25)} | ${d['Date']||'?'}`:'(nothing in snapshot)'}`);}
console.log("=== row 364 was: ===");
const d364=bySheet.get(364);console.log(d364?JSON.stringify(d364).slice(0,200):'(nothing)');
