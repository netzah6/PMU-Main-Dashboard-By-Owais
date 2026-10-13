// Pure helpers for the blast message template — no server imports, so the
// Blast page can run the same checks live that the API enforces.

export const BLAST_TAGS = ["{{contact.first_name}}", "{{user.first_name}}", "{{service}}"] as const;

/** Plain-English problem with a template, or null when it is fine. A tag
 *  typed with a brace missing ("{{contact.first_name}") is not replaced by
 *  us and GHL then rejects EVERY message as a bad template — the Violet
 *  Zherka blast, 2026-10-12: 250/250 failed. */
export function templateProblem(tpl: string): string | null {
  let rest = tpl;
  for (const t of BLAST_TAGS) rest = rest.replaceAll(t, "");
  const i = rest.search(/[{}]/);
  if (i < 0) return null;
  const near = rest.slice(Math.max(0, i - 10), i + 24).replace(/\s+/g, " ").trim();
  return `Broken tag near "${near}" — tags must be typed exactly ${BLAST_TAGS.join(", ")} (two braces each side).`;
}

/** Repair the common slip: a known tag with one brace missing or stray spaces. */
export function autoFixTemplate(tpl: string): string {
  return tpl.replace(/\{{1,2}\s*(contact\.first_name|user\.first_name|service)\s*\}{1,2}/g, (_, k: string) => `{{${k}}}`);
}

/** Group a recipient's send error into a short reason the team can act on. */
export function blastErrorReason(err: string | null | undefined): string {
  const e = String(err ?? "");
  if (/Parse error|CLOSE_RAW_BLOCK|Expecting '/.test(e)) return "broken tag in message";
  if (/DND/i.test(e)) return "do-not-disturb (DND) on";
  if (/unsubscribed/i.test(e)) return "unsubscribed";
  if (/phone/i.test(e)) return "no valid phone";
  if (/token/i.test(e)) return "GHL connection";
  return "other";
}

/** Failures that will repeat no matter what we change — never re-queued. */
export function isPermanentBlastError(err: string | null | undefined): boolean {
  const r = blastErrorReason(err);
  return r === "do-not-disturb (DND) on" || r === "unsubscribed" || r === "no valid phone";
}
