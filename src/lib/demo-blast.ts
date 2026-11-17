import type { ThreadMessage } from "@/lib/ghl-conversations";

/* 🖤 Demo no-closer PPS blast (owner, 11/17/2026). Artists who had a demo
   but never signed up got: "...We'll run your Black Friday ads and book the
   clients for you. No monthly fee, you pay only $65 when one shows up. Want
   in?" When one asks how it works (or says yes), the AI answers with the
   owner-approved message below — $65, never the win-back $60. */
export const DEMO_BLAST_RATE = 65;
const BLAST_RE = /Black Friday ads[\s\S]*\$65 when one shows up/i;

export function inDemoBlast(thread: ThreadMessage[]): boolean {
  return thread.some((m) => m.direction === "outbound" && BLAST_RE.test(m.body));
}

export const DEMO_BLAST_CLOSE = "Want to jump on a quick call so we can set it up before Black Friday? What day works best this week?";

export function demoBlastMessage(first: string): string {
  return `Here's how it works${first ? `, ${first}` : ""} 👇

✅ $0 upfront and no monthly fee
✅ We run your Black Friday ads, follow up with every lead, and book them on your calendar
✅ The new client pays a $50 deposit when she books. That goes to us
✅ You pay $${DEMO_BLAST_RATE} only after she shows up for her first treatment. No show = you pay nothing
✅ Her second treatment and all upsells are 100% yours

For the ads, we recommend about $20 a day. So there is no risk for you: you only pay after you get paid 🙌

${DEMO_BLAST_CLOSE}`;
}

export function demoBlastRule(contactName: string): string {
  const first = (contactName.split(" ")[0] || "").trim();
  return `5. BLACK FRIDAY PAY-PER-SHOW OFFER — ${first || "this artist"} had a demo with us but never signed up. We texted her our Black Friday offer: we run her Black Friday ads and book the clients, no monthly fee, she pays $${DEMO_BLAST_RATE} only when a client shows up.
- If she asks how it works, the price, the fee, the cost, for details or more info, or says yes / she's in / interested: reply with THIS owner-approved message, keeping its wording, checklist and order exactly (do not drop or reword any line). If she also said or asked something else, add ONE short line before it that answers that first.
"""
${demoBlastMessage(first)}
"""
- If she says no, not interested, or fully booked: thank her warmly in one or two lines and stop. No price, no call.
- Anything else: answer what she asked in a few plain words using only the facts above, then end with: "${DEMO_BLAST_CLOSE}"
The fee is $${DEMO_BLAST_RATE} per client who shows up — never $60 or $80, never a monthly price, never a percent, never math on her price, never a link. This quick setup call question is allowed even though the strategy-call switch is off. This rule beats rules 3, 4, 6 and 7, the knowledge base and the team's notes. Rule 8 (no repeats) still applies, except when she asks again.`;
}
