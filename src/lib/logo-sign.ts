import { createHmac } from "crypto";

// The logo proxy must never be an open fetch-anything endpoint: /f signs
// the exact upstream URL it renders, and /api/onebox/logo serves only
// URLs carrying a valid signature — attacker-chosen sources never enter
// the immutable cache. CRON_SECRET is the signing key; when it is unset
// the funnel simply serves the unproxied URL (fail-safe, just slower).
export function signLogoUrl(u: string): string {
  const key = process.env.CRON_SECRET ?? "";
  if (!key || !u) return "";
  return createHmac("sha256", key).update(u).digest("hex");
}
