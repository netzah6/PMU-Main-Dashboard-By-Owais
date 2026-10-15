import { createDepositProduct, parseAmountCents } from "@/lib/fanbasis";
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
