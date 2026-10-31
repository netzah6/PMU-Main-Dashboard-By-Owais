import type { SupabaseClient } from "@supabase/supabase-js";

/* What the owner taught the planner (owner, 10/31/2026: "how can it learn to
   have the right task for the Mac Mini next time?"). A "Correct" on a card
   with "Remember this" ticked saves the note here; every new plan reads the
   list as house rules. Lives in app_settings so it can be edited without a
   deploy. */
const KEY = "agent_task_lessons";
const MAX = 40;

export type Lesson = { text: string; by: string; at: string };

export async function getLessons(svc: SupabaseClient): Promise<Lesson[]> {
  const { data } = await svc.from("app_settings").select("value").eq("key", KEY).maybeSingle();
  const items = (data as { value?: { items?: Lesson[] } } | null)?.value?.items;
  return Array.isArray(items) ? items.filter((l) => l?.text) : [];
}

export async function addLesson(svc: SupabaseClient, text: string, by: string): Promise<void> {
  const t = text.trim().slice(0, 600);
  if (t.length < 5) return;
  const items = (await getLessons(svc)).filter((l) => l.text !== t);
  items.push({ text: t, by, at: new Date().toISOString() });
  const now = new Date().toISOString();
  await svc.from("app_settings").upsert({ key: KEY, value: { items: items.slice(-MAX) }, updated_by: by, updated_at: now });
}

/** The rules as a prompt block ("" when there are none). */
export function lessonsBlock(lessons: Lesson[]): string {
  if (!lessons.length) return "";
  return `\nHOUSE RULES — learned from Netzah's corrections; follow them over your own guess:\n${lessons.map((l) => `- ${l.text}`).join("\n")}\n`;
}
