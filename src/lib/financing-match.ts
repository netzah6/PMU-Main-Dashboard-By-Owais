import { normalizeOwnerKey } from "@/lib/normalizers";

/* Match a Clients Master owner to their row on the Financing sheet's latest
   month tab (client_payments). Shared by the pay-date alert and the Coach
   Report payment notes so both agree on who is "on the sheet".
   Names differ between the two sheets ("Ah Ra Cho (Estee Cho)", "Erin
   Heidecke 30%", "Martin Aba / Alise Herrera"), so every alias on either
   side is tried before a client counts as missing. */
export function nameAliases(raw: string): string[] {
  const s = String(raw ?? "");
  const outer = s.replace(/\([^)]*\)/g, " ");
  // Partners share a row: "Hong Tran (Jennifer & Natalie)" = Jennifer Tran and
  // Natalie Tran too (owner, 11/22/2026). A lone first name takes the row's last name.
  const last = outer.trim().split(/\s+/).pop() ?? "";
  const inner = Array.from(s.matchAll(/\(([^)]*)\)/g), (m) => m[1]).flatMap((x) => x.split(/\s*(?:&|\band\b|,)\s*/i));
  const parts = [outer, ...inner, ...inner.filter((x) => last && x.trim() && !/\s/.test(x.trim())).map((x) => `${x.trim()} ${last}`)]
    .flatMap((x) => x.split("/"));
  return [...new Set(parts.map((x) => normalizeOwnerKey(x.replace(/\d+\s*%/g, " "))).filter(Boolean))];
}

export function makeFinancingMatcher<T extends { client_name: string }>(rows: T[]) {
  const fins = rows.map((f) => ({ row: f, aliases: nameAliases(f.client_name) }));
  const tok = (k: string) => k.split(" ").filter((t) => t.length >= 2);
  return (owner: string, business: string): T | null => {
    const mine = nameAliases(owner);
    const exact = fins.find((f) => f.aliases.some((a) => mine.includes(a)));
    if (exact) return exact.row;
    // Two shared words with one alias, or every word of a sheet alias found
    // among all the owner's names ("Xuan Luong" ↔ "Annie Luong (Xuan)").
    const ownerWords = new Set(mine.flatMap(tok));
    const two = fins.filter((f) => f.aliases.some((a) => {
      const at = tok(a);
      if (at.length >= 2 && at.every((t) => ownerWords.has(t))) return true;
      return mine.some((m) => { const mt = tok(m); return Math.min(at.length, mt.length) >= 2 && at.filter((t) => mt.includes(t)).length >= 2; });
    }));
    if (two.length === 1) return two[0].row;
    // One-word sheet names ("Lei") match the owner's or business's words, if unambiguous.
    const words = new Set([...ownerWords, ...tok(normalizeOwnerKey(business))]);
    const one = fins.filter((f) => f.aliases.some((a) => tok(a).length === 1 && words.has(a)));
    return one.length === 1 ? one[0].row : null;
  };
}
