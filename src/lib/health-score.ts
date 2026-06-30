// Client Health Score (0–100), results-first weighting. Pure functions so the
// weights/scales are easy to tune. Each sub-score is 0–100; total is weighted.

export interface HealthInputs {
  // results
  d30: number; bookingPct: number | null; conv30: number | null;
  // lead flow
  l30: number; cpl30: number | null; campaignPaused: boolean;
  // engagement (ghl_lead_status aggregate for the owner)
  engTotal: number; engCold: number; engPrice: number;
  // relationship
  daysSinceStrategy: number | null; paymentStatus: string | null;
  // setup
  stepsDone: number; stepsTotal: number; gmb: boolean;
}

export interface HealthResult {
  total: number;
  subs: { conversion: number; leadFlow: number; engagement: number; relationship: number; setup: number };
  flags: { label: string; sev: "red" | "amber" }[];
}

const WEIGHTS = { conversion: 0.35, leadFlow: 0.20, engagement: 0.20, relationship: 0.15, setup: 0.10 };

const band = (v: number, bands: [number, number][]): number => {
  for (const [threshold, score] of bands) if (v >= threshold) return score;
  return bands[bands.length - 1][1];
};
const clamp = (v: number) => Math.max(0, Math.min(100, v));
const pctVal = (p: number | null) => (p == null ? null : p < 1 ? p * 100 : p); // 0.05 → 5

export function computeHealth(i: HealthInputs): HealthResult {
  // Conversion (deposits weighted most)
  const dep = band(i.d30, [[5, 100], [3, 80], [2, 62], [1, 45], [0, 15]]);
  const bp = pctVal(i.bookingPct);
  const book = bp == null ? 25 : band(bp, [[15, 100], [10, 85], [7, 70], [4, 50], [0.001, 32], [0, 20]]);
  const cv = i.conv30;
  const conv = cv == null ? 25 : band(cv, [[8, 100], [5, 82], [3, 62], [1, 42], [0.001, 28], [0, 20]]);
  const conversion = Math.round(0.5 * dep + 0.25 * book + 0.25 * conv);

  // Lead flow
  const lead = band(i.l30, [[80, 100], [50, 82], [30, 62], [15, 45], [1, 30], [0, 10]]);
  const cpl = i.cpl30 == null ? 55 : band(-i.cpl30, [[-6, 100], [-8, 82], [-10, 62], [-15, 42], [-1e9, 22]]);
  const camp = i.campaignPaused ? 30 : 100;
  const leadFlow = Math.round(0.45 * lead + 0.3 * cpl + 0.25 * camp);

  // Engagement
  let engagement: number;
  if (i.engTotal === 0) engagement = 35;
  else {
    const engagedPct = ((i.engTotal - i.engCold) / i.engTotal) * 100;
    const penalty = Math.min(20, (i.engPrice / i.engTotal) * 60);
    engagement = Math.round(clamp(engagedPct - penalty));
  }

  // Relationship
  const strat = i.daysSinceStrategy == null ? 22 : band(-i.daysSinceStrategy, [[-14, 100], [-30, 78], [-45, 55], [-60, 35], [-1e9, 20]]);
  const ps = (i.paymentStatus ?? "").toLowerCase();
  const pay = ps.includes("paid") ? 100 : ps.includes("pend") || ps.includes("grace") ? 70 : ps.includes("over") || ps.includes("late") || ps.includes("attention") ? 20 : 60;
  const relationship = Math.round(0.6 * strat + 0.4 * pay);

  // Setup
  const setup = i.stepsTotal > 0 ? Math.round((i.stepsDone / i.stepsTotal) * 100) : 0;

  const subs = { conversion, leadFlow, engagement, relationship, setup };
  const total = Math.round(
    conversion * WEIGHTS.conversion + leadFlow * WEIGHTS.leadFlow + engagement * WEIGHTS.engagement +
    relationship * WEIGHTS.relationship + setup * WEIGHTS.setup
  );

  const flags: { label: string; sev: "red" | "amber" }[] = [];
  if (i.campaignPaused) flags.push({ label: "Campaign paused", sev: "red" });
  if (pay === 20) flags.push({ label: "Payment overdue", sev: "red" });
  if (i.d30 === 0) flags.push({ label: "No deposits 30d", sev: "red" });
  if (i.daysSinceStrategy == null || i.daysSinceStrategy > 30) flags.push({ label: "No strategy 30d+", sev: "amber" });
  if (!i.gmb) flags.push({ label: "GMB off", sev: "amber" });
  if (i.engTotal > 0 && i.engPrice >= 3) flags.push({ label: "Price pushback", sev: "amber" });
  if (i.stepsDone < i.stepsTotal) flags.push({ label: `Setup ${i.stepsDone}/${i.stepsTotal}`, sev: "amber" });

  return { total, subs, flags };
}

export function scoreColor(score: number): { bg: string; fg: string } {
  if (score >= 75) return { bg: "#dcfce7", fg: "#15803d" };
  if (score >= 55) return { bg: "#fef9c3", fg: "#a16207" };
  if (score >= 40) return { bg: "#ffedd5", fg: "#c2410c" };
  return { bg: "#fde8ee", fg: "#e11d48" };
}
