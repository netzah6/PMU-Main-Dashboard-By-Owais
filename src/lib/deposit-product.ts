import { createDepositProduct, parseAmountCents, listProducts } from "@/lib/fanbasis";
import type { ClaimAction } from "@/lib/ghl-claim";

// The Commas (Fanbasis) deposit product for a new client, from the New
// Client form. Team convention: "FULL NAME - BUSINESS NAME" (e.g. "Ivan
// Androsov - PMU by Ivan"). Shared by the Claim button and the New Client
// Setup run so the two can never name or price it differently.
export async function createDepositProductFromForm(
  form: Record<string, string>,
): Promise<{ action: ClaimAction; productId?: string; checkoutUrl?: string }> {
  const cents = parseAmountCents(form.deposit_amount ?? "");
  if (!cents) return { action: { action: "Commas product", ok: false, detail: "no valid deposit amount on the form" } };
  const title = [form.owner_name?.trim(), form.business_name?.trim()].filter(Boolean).join(" - ");
  try {
    /* Reuse: a returning client already has "FULL NAME - BUSINESS NAME" on
       Commas (Sally Nails And Spa got a duplicate, 10/16/2026). The list is
       oldest-first, so the FIRST exact match is the original. */
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const same = (await listProducts().catch(() => [])).filter((p) => p.id && norm(p.title) === norm(title));
    const existing = same[0];
    if (existing) {
      return {
        action: { action: `Commas product "${existing.title}" already exists → reused ID ${existing.id}${existing.checkout_url ? ` · ${existing.checkout_url}` : ""}${same.length > 1 ? ` (⚠ ${same.length} products with this name on Commas)` : ""}`, ok: true },
        productId: existing.id,
        checkoutUrl: existing.checkout_url,
      };
    }
    const p = await createDepositProduct(title, cents);
    return {
      action: {
        action: `Commas product "${title}" ($${(cents / 100).toFixed(2)})${p.productId ? ` → ID ${p.productId}` : ""}${p.checkoutUrl ? ` · ${p.checkoutUrl}` : ""}`,
        ok: true,
      },
      productId: p.productId ?? undefined,
      checkoutUrl: p.checkoutUrl ?? undefined,
    };
  } catch (e) {
    return { action: { action: "Commas product", ok: false, detail: e instanceof Error ? e.message : "failed" } };
  }
}
