import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

/* Funnel-setup review for the Cost/Deposit ✨ AI Recommendation box.

   Grades a client's one-box funnel config against the 2026-10-01 fleet
   research (97 live funnels, 56 with ≥20 leads; scratchpad research doc +
   PR description have the full numbers). The checks are ordered by what
   moves conversion most, so the FIRST card is the thing to change first:
     1. the deposit page can't charge at all (product id / webhook missing)
     2. funnel younger than 3 weeks — payment data not judgeable yet
     3. price above the $450 cliff, or price block empty (V3 pages quote it)
     4. offer wording (dollar-off beats free-consult; $150 OFF is enough)
     5. bare funnel — services menu / IG widget / photos / hours missing
   Only V3 clients appear on the Cost/Deposit tab, so the price/offer rules
   (which ride on the AI quoting the price) always apply here. */

const PAID = ["booked", "paid", "paid-not-booked", "paid-followup"];

// Fleet baselines from the 2026-10-01 research — update when it's rerun.
const FLEET = {
  pickedToPaidMedian: 7.5, // % — median pay-through, funnels ≥20 leads
  leadToPicked: 60, // % — fleet lead→picked-a-time
  priceCliff: 450, // pay-through collapses 11.6% → 2.9% above this
  bandLo: 375,
  bandHi: 449,
  winnerPrice: 397, // modal winner price (8 clients, 12.4%)
};

type Check = {
  emoji: string;
  severity: "fix" | "watch" | "good";
  title: string;
  body: string;
};

const money = (v: unknown): number | null => {
  const m = String(v ?? "").replace(/[,$]/g, "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const locationId = req.nextUrl.searchParams.get("locationId")?.trim();
  if (!locationId) return NextResponse.json({ error: "locationId required" }, { status: 400 });

  const sb = createServiceClient();
  const { data: client, error } = await sb
    .from("onebox_clients")
    .select("slug, client_name, status, config, extras, created_at")
    .eq("location_id", locationId)
    .eq("status", "live")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!client) return NextResponse.json({ found: false });

  const cfg = (client.config ?? {}) as Record<string, string>;

  // Last-30-day funnel numbers for this slug (counts only — cheap).
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const since = cutoff.toISOString();
  const count = async (kind: "leads" | "picked" | "paid") => {
    let q = sb
      .from("onebox_leads")
      .select("id", { count: "exact", head: true })
      .eq("slug", client.slug)
      .gte("created_at", since);
    if (kind === "picked") q = q.or(`picked_time_at.not.is.null,ghl_status.in.(${PAID.join(",")})`);
    if (kind === "paid") q = q.in("ghl_status", PAID);
    const { count: n } = await q;
    return n ?? 0;
  };
  const [leads, picked, paid] = await Promise.all([count("leads"), count("picked"), count("paid")]);

  const ageDays = client.created_at
    ? Math.floor((Date.now() - new Date(client.created_at).getTime()) / 86_400_000)
    : null;

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
  const hasIg = !!String(cfg.igWidget ?? "").trim();
  const hasHours = !!String(cfg.businessHours ?? "").trim();
  const canCharge = !!String(cfg.fanbasisProductId ?? "").trim() || !!String(cfg.fanbasisCode ?? "").trim();

  const checks: Check[] = [];

  if (!canCharge) {
    checks.push({
      emoji: "🚫",
      severity: "fix",
      title: "Deposit page can't charge — fix this before anything else",
      body: "No Fanbasis product is configured, so every lead who picks a time hits a dead checkout. Add the product ID on the Funnels tab.",
    });
  }

  if (ageDays != null && ageDays < 21) {
    checks.push({
      emoji: "🐣",
      severity: "watch",
      title: `Funnel is ${ageDays} days old — too early to judge payments`,
      body: "Every funnel in the fleet took 2–3 weeks before deposits ramped. Don't change price or offer yet; just make sure the setup below is complete.",
    });
  }

  if (price != null && price > FLEET.priceCliff) {
    checks.push({
      emoji: "💰",
      severity: "fix",
      title: `Price $${price} is above the $450 cliff`,
      body: `Funnels showing over $450 close ${"2.9"}% of booked leads vs 11.6% in the $350–449 band. The fleet's winner price is $${FLEET.winnerPrice}.`,
    });
  } else if (price == null) {
    checks.push({
      emoji: "💰",
      severity: "fix",
      title: "No price configured",
      body: "Funnels that show the strike-through price close 2.2× more deposits (9.8% vs 4.4%). Fill Original + Discounted Price on the Funnels tab.",
    });
  }

  if (isFreeConsult && price == null) {
    checks.push({
      emoji: "🏷️",
      severity: "fix",
      title: "Free-consult offer with no price — the losing combo",
      body: "Free-consult funnels with a blank price close 4.8% (most of the fleet's 0% funnels). Either fill the price block or switch to \"$150 OFF\".",
    });
  } else if (!isDollarOff && !isFreeConsult && offer) {
    checks.push({
      emoji: "🏷️",
      severity: "watch",
      title: "Non-standard offer wording",
      body: `Current offer: “${offer.slice(0, 60)}”. Dollar-off offers close best fleet-wide ($150 OFF: 11.4% vs free-consult 6.9%).`,
    });
  } else if (isDollarOff && /\$?\s*(2[5-9]\d|[3-9]\d\d)\s*off/i.test(offer)) {
    checks.push({
      emoji: "🏷️",
      severity: "watch",
      title: "Discount bigger than it needs to be",
      body: "\"$150 OFF\" closes at least as well as larger discounts (11.4% vs 9.5% for $200 OFF) — a bigger number buys nothing.",
    });
  }

  const missing: string[] = [];
  if (servicesCount < 4) missing.push(`services menu (${servicesCount} listed, want 4–5)`);
  if (!hasIg) missing.push("Instagram widget");
  if (photoCount < 3) missing.push(`photos (${photoCount} set, want 3+)`);
  if (!hasHours) missing.push("business hours");
  if (missing.length) {
    checks.push({
      emoji: "🧰",
      severity: missing.length >= 2 ? "fix" : "watch",
      title: `Bare funnel — missing: ${missing.join(", ")}`,
      body: "Dressed funnels (services menu, IG widget, photos, hours) get 65% of leads to pick a time vs 52% for bare ones. The services menu is the strongest single asset.",
    });
  }

  /* IG widget feed review — one-time vision snapshot of each widget's visible
     posts (extras.igReview, 2026-10-01). Fleet data says follower count and
     before/after share do NOT reliably move deposits, so the only card here is
     the one failure mode that clusters at the bottom: a feed that mostly shows
     selfies / promos / another business instead of the artist's work. */
  const ig = (client.extras as Record<string, unknown> | null)?.igReview as
    | { quality?: number; workShare?: number | null; note?: string; followers?: number | null }
    | undefined;
  if (ig && typeof ig.quality === "number" && (ig.quality <= 2 || (ig.workShare != null && ig.workShare < 0.5))) {
    checks.push({
      emoji: "📸",
      severity: "watch",
      title: "IG widget isn't showing the artist's work",
      body: `${ig.workShare != null ? Math.round(ig.workShare * 100) + "% of the visible feed is actual PMU results" : "Little PMU work visible"} — the rest is selfies/promos/off-topic. Feeds like this cluster at the bottom of the fleet. Point the widget at (or fill) an account that leads with her results.${ig.note ? ` Review note: ${ig.note}` : ""}`,
    });
  }

  if (!checks.some((c) => c.severity === "fix")) {
    checks.push({
      emoji: "✅",
      severity: "good",
      title: "Funnel setup matches the winner profile",
      body: "Price in band, offer solid, page dressed. If conversion still lags, the lever is the AI follow-up and the calendar, not the funnel page.",
    });
  }

  const ex = (client.extras ?? {}) as { igWidgetOff?: boolean; igFrozen?: boolean; igSnapshot?: { imgs?: string[] } };
  return NextResponse.json({
    found: true,
    slug: client.slug,
    name: client.client_name,
    // IG-widget controls state for the card's Off/Freeze buttons.
    igState: {
      hasWidget: hasIg,
      widgetOff: !!ex.igWidgetOff,
      frozen: !!ex.igFrozen,
      hasSnapshot: !!ex.igSnapshot?.imgs?.length,
    },
    ageDays,
    stats: {
      leads30: leads,
      picked30: picked,
      paid30: paid,
      leadToPicked: leads ? Math.round((picked / leads) * 100) : null,
      pickedToPaid: picked ? +((paid / picked) * 100).toFixed(1) : null,
      fleet: FLEET,
    },
    config: {
      price,
      offer: offer.slice(0, 80),
      servicesCount,
      photoCount,
      igWidget: hasIg,
      businessHours: hasHours,
      canCharge,
    },
    checks,
  });
}
