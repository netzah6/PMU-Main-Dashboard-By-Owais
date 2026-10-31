import { createHmac, timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { clientNameList, createTaskCard, findTaskClient } from "@/lib/agent-task";
import { proposalLink } from "@/lib/agent-notify";
import { getLessons, lessonsBlock } from "@/lib/agent-lessons";

/* "Send to AI Agent" — a Slack message shortcut (owner, 10/31/2026: team
   members ask me for things in Slack DMs; let the Mac Mini take care of
   them). Owner only: SLACK_OWNER_USER_ID is the one Slack user it answers.
   The owner clicks it on a message → a small form (client, note) → the
   message, the ones before it and their screenshots become a task card on
   the AI tab. Nothing runs until Approve, and nothing is ever posted to
   anyone else in Slack: the only replies are ephemeral, to the owner.

   Env: SLACK_SIGNING_SECRET (verifies Slack), SLACK_BOT_TOKEN (opens the
   form), SLACK_USER_TOKEN (the owner's token: reads the DM and its files —
   a bot can't see a DM it isn't in), SLACK_OWNER_USER_ID. */

const SLACK = "https://slack.com/api";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const BUCKET = "agent-proofs";
export const SHORTCUT_ID = "send_to_ai_agent";
export const MODAL_ID = "ai_agent_task";

export function verifySlack(raw: string, ts: string | null, sig: string | null): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replayed
  const mine = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`;
  return mine.length === sig.length && timingSafeEqual(Buffer.from(mine), Buffer.from(sig));
}

export function isOwner(userId: string | undefined): boolean {
  const owner = process.env.SLACK_OWNER_USER_ID;
  return !!owner && userId === owner;
}

async function slack(method: string, token: string | undefined, params: Record<string, unknown>, post = false): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!token) throw new Error(`Slack token for ${method} is not set`);
  const r = post
    ? await fetch(`${SLACK}/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(params) })
    : await fetch(`${SLACK}/${method}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}`);
  return j;
}

/** Ephemeral note to the owner where they clicked (response_url lives 30 min). */
export async function tellOwner(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }) }).catch(() => {});
}

export type ModalMeta = { c: string; ts: string; th: string; ru: string };

export async function openTaskModal(triggerId: string, meta: ModalMeta): Promise<void> {
  await slack("views.open", process.env.SLACK_BOT_TOKEN, {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: MODAL_ID,
      private_metadata: JSON.stringify(meta),
      title: { type: "plain_text", text: "Send to AI Agent" },
      submit: { type: "plain_text", text: "Create task" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        { type: "context", elements: [{ type: "mrkdwn", text: "The AI reads this message, the ones before it and their screenshots, and makes a task card. Nothing runs until you Approve it on the dashboard." }] },
        { type: "input", block_id: "client", optional: true, label: { type: "plain_text", text: "Client (leave empty and the AI picks it from the messages)" },
          element: { type: "plain_text_input", action_id: "v", placeholder: { type: "plain_text", text: "Owner or business name" } } },
        { type: "input", block_id: "note", optional: true, label: { type: "plain_text", text: "Your note for the AI" },
          element: { type: "plain_text_input", action_id: "v", multiline: true, placeholder: { type: "plain_text", text: "e.g. go ahead and fix the calendar hours" } } },
      ],
    },
  }, true);
}

type SlackFile = { id: string; name?: string; mimetype?: string; size?: number; url_private?: string };
type SlackMsg = { ts: string; user?: string; text?: string; files?: SlackFile[]; bot_id?: string };

// The clicked message plus up to 14 before it (the thread when it's in one), oldest first.
async function readContext(meta: ModalMeta): Promise<SlackMsg[]> {
  const tok = process.env.SLACK_USER_TOKEN;
  const j = meta.th && meta.th !== meta.ts
    ? await slack("conversations.replies", tok, { channel: meta.c, ts: meta.th, latest: meta.ts, inclusive: true, limit: 15 })
    : await slack("conversations.history", tok, { channel: meta.c, latest: meta.ts, inclusive: true, limit: 15 });
  const msgs = ((j.messages ?? []) as SlackMsg[]).filter((m) => Number(m.ts) <= Number(meta.ts));
  return msgs.sort((a, b) => Number(a.ts) - Number(b.ts)).slice(-15);
}

async function nameOf(cache: Map<string, string>, id: string | undefined): Promise<string> {
  if (!id) return "Bot";
  if (!cache.has(id)) {
    const u = await slack("users.info", process.env.SLACK_USER_TOKEN, { user: id }).catch(() => null);
    cache.set(id, u?.user?.profile?.real_name || u?.user?.real_name || u?.user?.name || id);
  }
  return cache.get(id)!;
}

type Img = { media: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: Buffer; name: string };

// The newest 4 images in the conversation (≤5 MB each — the model's limit).
async function readImages(msgs: SlackMsg[]): Promise<Img[]> {
  const files = msgs.flatMap((m) => m.files ?? [])
    .filter((f) => /^image\/(jpeg|png|gif|webp)$/.test(f.mimetype ?? "") && (f.size ?? 0) <= 5 * 1024 * 1024 && f.url_private)
    .slice(-4);
  const out: Img[] = [];
  for (const f of files) {
    try {
      const r = await fetch(f.url_private!, { headers: { Authorization: `Bearer ${process.env.SLACK_USER_TOKEN}` }, signal: AbortSignal.timeout(10_000) });
      const type = r.headers.get("content-type") ?? "";
      if (!r.ok || !type.startsWith("image/")) continue; // an HTML login page = missing files:read
      out.push({ media: f.mimetype as Img["media"], data: Buffer.from(await r.arrayBuffer()), name: f.name || `${f.id}.png` });
    } catch { /* skip that one */ }
  }
  return out;
}

type Plan = { client: string; task: string; summary: string };

async function planTask(convo: string, imgs: Img[], note: string, clientHint: string, clients: string[], rules: string): Promise<Plan | null> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `You turn a request that came in on Slack into a task for the AI Agent, which works by hand in a browser for ONE client (a PMU artist the agency serves): in their GoHighLevel sub-account, or in CloseBot (app.closebot.com) — the AI that texts their leads. What the AI texts leads (its wording, replies to photos, scripts, follow-ups) lives in CloseBot, not GoHighLevel. The people on Slack are the agency's team (coaches, media buyers) and the owner, Netzah.
${rules}${note ? `\nNETZAH'S NOTE (authoritative — it overrides your own reading):\n"""\n${note}\n"""\n` : ""}${clientHint ? `\nNetzah says the client is: ${clientHint}\n` : ""}
Slack conversation, oldest first (the message Netzah clicked is marked <- THIS ONE):
"""
${convo}
"""
${imgs.length ? `\nThe ${imgs.length} screenshot(s) from the conversation follow — read them as part of the request.\n` : ""}
Client list (owner name, then business):
${clients.join("\n")}

Reply with ONLY JSON:
{"client": "<the owner name exactly as in the list, before the bracket; \\"\\" if you can't tell>", "summary": "<at most 12 words: the ask itself>", "task": "<first line: 'In GoHighLevel:' or 'In CloseBot (app.closebot.com):'; then numbered steps, one per line: what to open and exactly what to change, with the values from the messages/screenshots; end with what to check so it's done>"}`;
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: prompt }];
  for (const i of imgs) content.push({ type: "image", source: { type: "base64", media_type: i.media, data: i.data.toString("base64") } });
  const res = await anthropic.messages.create({ model: MODEL, max_tokens: 900, messages: [{ role: "user", content }] });
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Plan; } catch { return null; }
}

/** The form was sent: read the conversation, plan, file the card, tell the owner. */
export async function handleSubmission(meta: ModalMeta, clientHint: string, note: string, ownerName: string): Promise<void> {
  try {
    const svc = createServiceClient();
    const msgs = await readContext(meta);
    const names = new Map<string, string>();
    const lines: string[] = [];
    for (const m of msgs) {
      const who = await nameOf(names, m.user);
      const when = new Date(Number(m.ts) * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" });
      const files = (m.files ?? []).length ? ` [${(m.files ?? []).length} file(s)]` : "";
      lines.push(`[${when}] ${who}: ${(m.text ?? "").trim()}${files}${m.ts === meta.ts ? "   <- THIS ONE" : ""}`);
    }
    const convo = lines.join("\n") || "(no readable messages)";
    const [imgs, clients, lessons] = await Promise.all([readImages(msgs), clientNameList(svc), getLessons(svc)]);
    const plan = await planTask(convo, imgs, note, clientHint, clients, lessonsBlock(lessons));
    if (!plan?.task) { await tellOwner(meta.ru, "🤖 The AI couldn't make a task from that message — try again with a note."); return; }
    const found = await findTaskClient(svc, clientHint || plan.client || "");
    if (!found.client) {
      await tellOwner(meta.ru, `🤖 ${found.error ?? "I couldn't tell which client this is"}. Click *Send to AI Agent* again and type the client's name.`);
      return;
    }
    // The screenshots go with the card so the Mac Mini can open them too.
    const urls: string[] = [];
    const folder = `slack/${Date.now()}`;
    for (const [i, img] of imgs.entries()) {
      const path = `${folder}/${i + 1}-${img.name.replace(/[^\w.-]+/g, "_")}`;
      const up = await svc.storage.from(BUCKET).upload(path, img.data, { contentType: img.media, upsert: true });
      if (!up.error) urls.push(svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl);
    }
    const task = `${plan.task.trim()}${urls.length ? `\n\nScreenshots from Slack (open them):\n${urls.join("\n")}` : ""}`;
    const made = await createTaskCard(svc, {
      client: found.client,
      task,
      summary: plan.summary,
      from: `${ownerName} via Slack`,
      context: `${note ? `Netzah's note: ${note}\n\n` : ""}Slack conversation:\n${convo}`,
    });
    if (!made.id) { await tellOwner(meta.ru, `🤖 Couldn't save the task: ${made.error}`); return; }
    const c = found.client;
    await tellOwner(meta.ru, `🤖 Task ready for *${c.name}${c.businessName ? ` (${c.businessName})` : ""}*: ${plan.summary}\nNothing runs until you approve it → ${proposalLink(made.id)}`);
  } catch (e) {
    await tellOwner(meta.ru, `🤖 Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
  }
}
