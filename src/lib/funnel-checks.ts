/* Funnel-setup checks shared by the Cost/Deposit "Funnel setup" card
   (/api/onebox/funnel-review) and the client brief (src/lib/cpd-brief.ts).

   Grades a one-box funnel's config against the 2026-10-01 fleet research
   (97 live funnels, 56 with ≥20 leads). Ordered by what moves conversion
   most, so the FIRST card is the thing to change first:
     1. the deposit page can't charge at all (product id / webhook missing)
     2. funnel younger than 3 weeks — payment data not judgeable yet
     3. price above the $450 cliff, or price block empty (V3 pages quote it)
     4. offer wording (dollar-off beats free-consult; $150 OFF is enough)
     5. bare funnel — services menu / IG feed / photos / hours missing */

export const FLEET = {
  pickedToPaidMedian: 7.5, // % — median pay-through, funnels ≥20 leads
  leadToPicked: 60, // % — fleet lead→picked-a-time
  priceCliff: 450, // pay-through collapses 11.6% → 2.9% above this
  bandLo: 375,
  bandHi: 449,
  winnerPrice: 397, // modal winner price (8 clients, 12.4%)
};

export type FunnelCheck = {
  emoji: string;
  severity: "fix" | "watch" | "good";
  title: string;
  body: string;
  code: string;
};

export type FunnelConfigSummary = {
  price: number | null;
  offer: string;
  servicesCount: number;
  photoCount: number;
  igWidget: boolean;
  businessHours: boolean;
  canCharge: boolean;
};

export const money = (v: unknown): number | null => {
  const m = String(v ?? "").replace(/[,$]/g, "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

type IgReview = { quality?: number; workShare?: number | null; note?: string; followers?: number | null };

export function reviewFunnelConfig(opts: {
  cfg: Record<string, string>;
  extras: Record<string, unknown> | null;
  ageDays: number | null;
  /** The in-house Instagram grid has ≥3 tiles and is not switched off. */
  hasIgFeed: boolean;
  /** V2.3 pages don't quote a price — the price rules are V3-only. */
  priceApplies?: boolean;
}): { checks: FunnelCheck[]; config: FunnelConfigSummary } {
  const { cfg, extras, ageDays, hasIgFeed } = opts;
  const priceApplies = opts.priceApplies ?? true;
  const price = money(cfg.discountedPrice);
  const offer = String(cfg.offer ?? "").trim();
  const isDollarOff = /\$?\s*\d+\s*off/i.test(offer);
  const isFreeConsult = /free\s*consult/i.test(offer);
  const servicesCount = String(cfg.services ?? "").split(",").filter((s) => s.trim()).length;
  /* Count PICTURES, not config fields: the before/after and studio photos
     live as comma-separated URL lists in aggregated fields (resultCvImgs
     carries the 9 CV slots). Counting keys undercounted everyone to 1
     (caught by the owner on Alluring, 2026-10-03). */
  const photoCount = new Set(
    ["resultImgs", "resultCvImgs", "studioImgs", "studioCvImgs"]
      .flatMap((k) => String(cfg[k] ?? "").split(","))
      .map((u) => u.trim())
      .filter(Boolean),
  ).size;
  // Elfsight is gone (10/26/2026): the Instagram asset is our own grid, built
  // from the client's Instagram link. An old elf.site value still counts as
  // "they gave us Instagram" while the grid is being fetched.
  const hasIg = hasIgFeed || !!String(cfg.igLink ?? "").trim() || !!String(cfg.igWidget ?? "").trim();
  const hasHours = !!String(cfg.businessHours ?? "").trim();
  const canCharge = !!String(cfg.fanbasisProductId ?? "").trim() || !!String(cfg.fanbasisCode ?? "").trim();

  const checks: FunnelCheck[] = [];

  if (!canCharge) {
    checks.push({
      code: "cant_charge",
      emoji: "🚫",
      severity: "fix",
      title: "Deposit page can't charge — fix this before anything else",
      body: "No Fanbasis product is configured, so every lead who picks a time hits a dead checkout. Add the product ID on the Funnels tab.",
    });
  }

  if (ageDays != null && ageDays < 21) {
    checks.push({
      code: "young_funnel",
      emoji: "🐣",
      severity: "watch",
      title: `Funnel is ${ageDays} days old — too early to judge payments`,
      body: "Every funnel in the fleet took 2–3 weeks before deposits ramped. Don't change price or offer yet; just make sure the setup below is complete.",
    });
  }

  if (priceApplies && price != null && price > FLEET.priceCliff) {
    checks.push({
      code: "price_cliff",
      emoji: "💰",
      severity: "fix",
      title: `Price $${price} is above the $450 cliff`,
      body: `Funnels showing over $450 close 2.9% of booked leads vs 11.6% in the $350–449 band. The fleet's winner price is $${FLEET.winnerPrice}.`,
    });
  } else if (priceApplies && price == null) {
    checks.push({
      code: "no_price",
      emoji: "💰",
      severity: "fix",
      title: "No price configured",
      body: "Funnels that show the strike-through price close 2.2× more deposits (9.8% vs 4.4%). Fill Original + Discounted Price on the Funnels tab.",
    });
  }

  if (isFreeConsult && price == null && priceApplies) {
    checks.push({
      code: "free_consult_no_price",
      emoji: "🏷️",
      severity: "fix",
      title: "Free-consult offer with no price — the losing combo",
      body: "Free-consult funnels with a blank price close 4.8% (most of the fleet's 0% funnels). Either fill the price block or switch to \"$150 OFF\".",
    });
  } else if (!isDollarOff && !isFreeConsult && offer) {
    checks.push({
      code: "offer_wording",
      emoji: "🏷️",
      severity: "watch",
      title: "Non-standard offer wording",
      body: `Current offer: “${offer.slice(0, 60)}”. Dollar-off offers close best fleet-wide ($150 OFF: 11.4% vs free-consult 6.9%).`,
    });
  } else if (isDollarOff && /\$?\s*(2[5-9]\d|[3-9]\d\d)\s*off/i.test(offer)) {
    checks.push({
      code: "discount_too_big",
      emoji: "🏷️",
      severity: "watch",
      title: "Discount bigger than it needs to be",
      body: "\"$150 OFF\" closes at least as well as larger discounts (11.4% vs 9.5% for $200 OFF) — a bigger number buys nothing.",
    });
  }

  const missing: string[] = [];
  if (servicesCount < 4) missing.push(`services menu (${servicesCount} listed, want 4–5)`);
  if (!hasIg) missing.push("Instagram feed (no Instagram link)");
  if (photoCount < 3) missing.push(`photos (${photoCount} set, want 3+)`);
  if (!hasHours) missing.push("business hours");
  if (missing.length) {
    checks.push({
      code: "bare_funnel",
      emoji: "🧰",
      severity: missing.length >= 2 ? "fix" : "watch",
      title: `Bare funnel — missing: ${missing.join(", ")}`,
      body: "Dressed funnels (services menu, Instagram feed, photos, hours) get 65% of leads to pick a time vs 52% for bare ones. The services menu is the strongest single asset.",
    });
  }

  /* Legacy one-time vision review of the OLD Elfsight widget (extras.igReview,
     2026-10-01). Kept only for clients whose in-house grid has not been built
     yet; once the grid exists its own first-row rule applies instead. */
  const ig = (extras ?? {}).igReview as IgReview | undefined;
  if (!hasIgFeed && ig && typeof ig.quality === "number" && (ig.quality <= 2 || (ig.workShare != null && ig.workShare < 0.5))) {
    checks.push({
      code: "ig_not_work",
      emoji: "📸",
      severity: "watch",
      title: "Instagram feed isn't showing the artist's work",
      body: `${ig.workShare != null ? Math.round(ig.workShare * 100) + "% of the visible feed is actual PMU results" : "Little PMU work visible"} — the rest is selfies/promos/off-topic. Feeds like this cluster at the bottom of the fleet.${ig.note ? ` Review note: ${ig.note}` : ""}`,
    });
  }

  if (!checks.some((c) => c.severity === "fix")) {
    checks.push({
      code: "setup_ok",
      emoji: "✅",
      severity: "good",
      title: "Funnel setup matches the winner profile",
      body: "Price in band, offer solid, page dressed. If conversion still lags, the lever is the AI follow-up and the calendar, not the funnel page.",
    });
  }

  return {
    checks,
    config: { price, offer: offer.slice(0, 80), servicesCount, photoCount, igWidget: hasIg, businessHours: hasHours, canCharge },
  };
}
