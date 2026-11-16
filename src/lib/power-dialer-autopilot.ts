import { createHmac, timingSafeEqual } from "crypto";

/* Autopilot key: lets the helper that runs INSIDE GHL (no dashboard cookie
   there) tell us "this lead answered — stop their next call + text".
   It is the rep's GHL user id + a signature, so it only works for that rep's
   own Power Dialer workflow and can do nothing else. */
function secret(): string {
  const s = process.env.AGENT_WORKER_SECRET || process.env.CRON_SECRET;
  if (!s) throw new Error("AGENT_WORKER_SECRET / CRON_SECRET not set");
  return s;
}
const sig = (userId: string) => createHmac("sha256", secret()).update(`dialer-autopilot:${userId}`).digest("hex").slice(0, 40);
export const autopilotKey = (userId: string) => `${userId}.${sig(userId)}`;
export function autopilotUser(key: string): string | null {
  const [userId, got] = String(key ?? "").split(".");
  if (!userId || !got || !/^[A-Za-z0-9]{10,40}$/.test(userId)) return null;
  const a = Buffer.from(sig(userId)), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b) ? userId : null;
}
