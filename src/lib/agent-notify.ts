import type { SupabaseClient } from "@supabase/supabase-js";
import { getReplyAccount, sendConversationMessage } from "@/lib/ghl-conversations";

// ── Tell the owner when the agent files a request ────────────────────────────
// The inbox sat unread for a month because nothing announced new cards. Now
// each scan that files something sends ONE text to the owner (batched, so a
// client firing off five emails is one message, not five) with a link that
// opens the Agent inbox on that card. The owner's phone lives in
// app_settings under `agent_notify`, set from the Agent panel.

const SETTINGS_KEY = "agent_notify";
type Svc = SupabaseClient;

// newCards: also text when a NEW request is filed (off unless switched on —
// the owner only wanted the after-the-fix confirmation, 2026-10-10).
export type NotifySettings = { enabled: boolean; phone: string; contactId: string; email?: string; updatedAt?: string; newCards?: boolean };

export async function getNotifySettings(svc: Svc): Promise<NotifySettings | null> {
  const { data } = await svc.from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  const v = (data as { value?: NotifySettings } | null)?.value;
  return v && v.contactId ? v : null;
}

export async function saveNotifySettings(svc: Svc, s: NotifySettings, by: string): Promise<void> {
  await svc.from("app_settings").upsert({ key: SETTINGS_KEY, value: { ...s, updatedAt: new Date().toISOString() }, updated_by: by, updated_at: new Date().toISOString() });
}

// Where the approve link points. Vercel's production URL is the custom
// domain on this project (which is why the cron guard once broke — see
// pmu-pr-workflow-pitfall); DASHBOARD_URL wins when set.
export function dashboardUrl(): string {
  const explicit = process.env.DASHBOARD_URL?.replace(/\/$/, "");
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : "https://pmu-main-dashboard-by-owais1.vercel.app";
}

export function proposalLink(id: string): string {
  return `${dashboardUrl()}/ask?view=agent&p=${encodeURIComponent(id)}`;
}

export type NotifyItem = { id: string; contact_name: string; business?: string | null; summary: string; action_type: "reply" | "account_change" };

// One text for everything this scan filed. Returns what was sent so the
// caller can log it; never throws — a failed text must not fail the scan.
export async function notifyOwner(svc: Svc, items: NotifyItem[]): Promise<{ sent: boolean; note: string }> {
  if (!items.length) return { sent: false, note: "nothing to announce" };
  const s = await getNotifySettings(svc);
  if (!s || !s.enabled) return { sent: false, note: "owner notifications not set up" };
  if (!s.newCards) return { sent: false, note: "new-request texts are off (confirmations only)" };
  const acct = await getReplyAccount();
  if (!acct) return { sent: false, note: "main account token unavailable" };

  const who = (i: NotifyItem) => `${i.contact_name}${i.business ? ` (${i.business})` : ""}`;
  let message: string;
  if (items.length === 1) {
    const i = items[0];
    message = `${i.action_type === "account_change" ? "🔧" : "💬"} Client request — ${who(i)}: ${i.summary.slice(0, 160)}\n\nApprove or deny: ${proposalLink(i.id)}`;
  } else {
    const lines = items.slice(0, 3).map((i) => `• ${who(i)}: ${i.summary.slice(0, 90)}`);
    const more = items.length > 3 ? `\n…and ${items.length - 3} more` : "";
    message = `${items.length} new client requests:\n${lines.join("\n")}${more}\n\nReview: ${proposalLink(items[0].id)}`;
  }
  const r = await sendConversationMessage(acct, { contactId: s.contactId, message, channel: "SMS" });
  if (r.ok) {
    await svc.from("agent_proposals").update({ notified_at: new Date().toISOString() }).in("id", items.map((i) => i.id));
    return { sent: true, note: `texted ${s.phone}` };
  }
  return { sent: false, note: `text failed: ${r.error}` };
}

// ── After Approve: tell the owner what was done ──────────────────────────────
// Owner, 2026-10-10: "go to her calendar, fix the settings and send me a
// confirmation". One text per approved card with the outcome per step.
export async function confirmToOwner(
  svc: Svc,
  p: { contact_name: string; summary: string; status: string; result: string },
  screenshots: string[] = [], // public image URLs, sent as MMS
): Promise<{ sent: boolean; note: string }> {
  const s = await getNotifySettings(svc);
  if (!s || !s.enabled) return { sent: false, note: "owner notifications not set up" };
  const acct = await getReplyAccount();
  if (!acct) return { sent: false, note: "main account token unavailable" };
  const head = p.status === "done" ? "✅ Done" : p.status === "needs_teammate" ? "👤 Needs a teammate" : "❌ Failed";
  // The proof lines, without the long before → after brackets.
  const lines = p.result.split("\n").map((l) => l.replace(/\s*\[[^\]]*\]\s*$/, "").trim()).filter(Boolean).slice(0, 6);
  const message = `${head} — ${p.contact_name}: ${p.summary.slice(0, 120)}\n${lines.join("\n")}`.slice(0, 900);
  const r = await sendConversationMessage(acct, { contactId: s.contactId, message, channel: "SMS", ...(screenshots.length ? { attachments: screenshots } : {}) });
  return r.ok ? { sent: true, note: `texted ${s.phone}` } : { sent: false, note: `text failed: ${r.error}` };
}
