import type { SupabaseClient } from "@supabase/supabase-js";

/* 🩹 Leaks tab (owner, 11/23/2026): the lead-leak checklist moves from the
   separate tracker page into the dashboard, so a nightly check can add the
   leaks it finds by itself. One app_settings row per leak (key "leak:<id>"),
   so two writers never overwrite each other's leak. Plain English, no lead
   names in the short fields. */

export const LEAK_PREFIX = "leak:";

export const LEAK_STATUSES = ["owner", "progress", "batch", "todo", "live", "done", "new"] as const;
export type LeakStatus = (typeof LEAK_STATUSES)[number];

export type Leak = {
  id: string;
  order: number;
  status: LeakStatus;
  area: string;
  title: string;
  short: string;
  problem?: string;
  change?: string;
  checked?: string;
  examples?: string;
  next?: string;
  where?: string;
  updated: string;        // MM/DD
  found_by?: string;      // "Claude" (by hand) or "nightly check"
  seen?: string;          // the nightly check's count, e.g. "Last night (11/23): 4 unpaid chats in 3 accounts …"
  updated_at?: string;    // ISO, set on every write
};

export async function listLeaks(svc: SupabaseClient): Promise<Leak[]> {
  const { data, error } = await svc.from("app_settings").select("key, value").like("key", `${LEAK_PREFIX}%`);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { key: string; value: Leak }[])
    .map((r) => ({ ...r.value, id: r.key.slice(LEAK_PREFIX.length) }))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

export async function saveLeak(svc: SupabaseClient, leak: Leak, by: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await svc.from("app_settings").upsert({
    key: `${LEAK_PREFIX}${leak.id}`, value: { ...leak, updated_at: now }, updated_by: by, updated_at: now,
  });
  if (error) throw new Error(error.message);
}

export const mmdd = (d = new Date()) => d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", timeZone: "America/Los_Angeles" });
