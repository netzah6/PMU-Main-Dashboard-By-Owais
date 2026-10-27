import type { SupabaseClient } from "@supabase/supabase-js";

/* ── Instagram post count via the Mac Mini (owner, 10/27/2026) ─────────────
   The in-house feed header shows "N posts · followers · following". Both
   paid scrapers and Elfsight's profile endpoint stopped returning the post
   count (10/2026), so 10 of 123 live funnels showed no "posts" stat — "it
   doesn't look real". Instagram's public profile page still carries it in
   <meta name="description"> ("1,899 Followers, 2,806 Following, 2,315 Posts
   - …"), readable in a browser without logging in. So a funnel whose feed
   has no count gets ONE AI Agent task: open the profile, read that line,
   report "POSTS: <number>". The answer lands in extras.igFeed.profile.posts
   and the newest ig_snapshots row; later fetches keep it (prev.posts).
   Task: agent_proposals row, conversation_id = 'ig:<slug>:posts_count'. */

type Svc = SupabaseClient;
const now = () => new Date().toISOString();
const usDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

export const IGP_PREFIX = "ig:";
export const IGP_KEY = "posts_count";
// Cards need a sub-account to run under; the agency account is the home of
// every non-client task (CloseBot checks do the same).
const AGENCY_LOC = process.env.GHL_LOCATION_ID || "SfpNMJ5YU9lBkxss47lK";
export const igPostsConvId = (slug: string) => `${IGP_PREFIX}${slug}:${IGP_KEY}`;
export function parseIgPostsConvId(conversationId: string | null | undefined): { slug: string } | null {
  if (!conversationId?.startsWith(IGP_PREFIX)) return null;
  const rest = conversationId.slice(IGP_PREFIX.length);
  const i = rest.lastIndexOf(":");
  if (i < 0 || rest.slice(i + 1) !== IGP_KEY) return null;
  const slug = rest.slice(0, i);
  return slug ? { slug } : null;
}

export function igPostsPlan(username: string): string[] {
  return [
    `Open https://www.instagram.com/${username}/ in the browser. No login is needed and do not log in — if a login wall covers the page, the numbers are still in the page's <meta name="description"> tag and in the tab title.`,
    `Read the line that looks like "1,899 Followers, 2,806 Following, 2,315 Posts - …" (page description). Take the Posts number. Change nothing, click nothing else.`,
    `Report. The LAST line of your report must be exactly "POSTS: <number>" (digits only, e.g. "POSTS: 2315") — or "POSTS: UNKNOWN — <what you saw>" if the profile does not exist, is private with no counts, or the page would not load.`,
  ];
}

export type QueueResult = { taskId: string; reused: boolean };

export async function queueIgPostsCheck(svc: Svc, args: { slug: string; username: string; by: string }): Promise<QueueResult> {
  const conversationId = igPostsConvId(args.slug);
  const { data: existing } = await svc.from("agent_proposals").select("id")
    .eq("conversation_id", conversationId).in("status", ["queued_browser", "running"]).limit(1).maybeSingle();
  if (existing) return { taskId: (existing as { id: string }).id, reused: true };
  const { count } = await svc.from("agent_proposals").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId);
  const attempt = (count ?? 0) + 1;
  const { data: ins, error } = await svc.from("agent_proposals").insert({
    conversation_id: conversationId,
    message_id: `${IGP_KEY}#${attempt}`,
    contact_id: null,
    contact_name: `@${args.username}`,
    channel: null,
    client_message: `Funnel ${args.slug}: the Instagram header has no post count. Read it from instagram.com/${args.username} (public page, no login). Queued by ${args.by} on ${usDate(now())}.`,
    summary: `Instagram: read @${args.username}'s post count for the ${args.slug} funnel`.slice(0, 500),
    action_type: "account_change",
    proposed_reply: null,
    action_detail: `Open the public Instagram profile @${args.username}, read the "N Posts" number from the page description and report it. Change nothing. The funnel's "posts" stat is filled from this answer.`.slice(0, 1500),
    action_plan: igPostsPlan(args.username).map((what) => ({ type: "manual", what })),
    location_id: AGENCY_LOC,
    status: "queued_browser",
    decided_by: `${args.by} (IG post count)`,
    decided_at: now(),
    executed_at: now(),
    result: "⏳ Waiting for the AI Agent (Instagram post count)",
  }).select("id").maybeSingle();
  if (error || !ins) throw new Error(`could not queue the post-count check: ${error?.message ?? "insert failed"}`);
  return { taskId: (ins as { id: string }).id, reused: false };
}

/* Every live funnel whose feed header has no post count. */
export async function queueIgPostsSweep(svc: Svc, by: string, limit = 20): Promise<{ queued: number; reused: number }> {
  const { data } = await svc.from("onebox_clients").select("slug, extras").eq("status", "live");
  type Row = { slug: string; extras: { igWidgetOff?: boolean; igFeed?: { profile?: { username?: string; posts?: number | null } } } | null };
  let queued = 0, reused = 0;
  for (const r of ((data ?? []) as Row[]).slice()) {
    const f = r.extras?.igFeed;
    if (!f?.profile?.username || r.extras?.igWidgetOff) continue;
    if (typeof f.profile.posts === "number") continue;
    if (queued + reused >= limit) break;
    const q = await queueIgPostsCheck(svc, { slug: r.slug, username: f.profile.username, by });
    if (q.reused) reused++; else queued++;
  }
  return { queued, reused };
}

/* The report's "POSTS: N" line → the feed header + newest snapshot. */
export async function onIgPostsClosed(svc: Svc, p: { id: string; conversation_id: string; status: string; result: string | null }): Promise<void> {
  const ref = parseIgPostsConvId(p.conversation_id);
  if (!ref) return;
  const text = String(p.result ?? "");
  const hits = [...text.matchAll(/POSTS:\s*([\d,]+)\b/gi)];
  const last = hits[hits.length - 1];
  if (!last) return; // UNKNOWN / died: the next ig-fetch run queues it again
  const n = Number(last[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return;
  const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", ref.slug).maybeSingle();
  const extras = { ...((row?.extras ?? {}) as Record<string, unknown>) } as Record<string, unknown> & { igFeed?: { profile?: Record<string, unknown> } };
  if (!extras.igFeed?.profile) return;
  extras.igFeed = { ...extras.igFeed, profile: { ...extras.igFeed.profile, posts: n } };
  await svc.from("onebox_clients").update({ extras }).eq("slug", ref.slug);
  const { data: snap } = await svc.from("ig_snapshots").select("id, profile").eq("slug", ref.slug).order("taken_at", { ascending: false }).limit(1).maybeSingle();
  if (snap) {
    const prof = (snap.profile ?? null) as Record<string, unknown> | null;
    await svc.from("ig_snapshots").update({ posts_count: n, ...(prof ? { profile: { ...prof, posts: n } } : {}) }).eq("id", snap.id);
  }
}
