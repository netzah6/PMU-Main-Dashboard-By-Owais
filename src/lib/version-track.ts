import { createServiceClient } from "@/lib/supabase/server";

// Auto-log version switches (→ V3 / V2.3) into the Activity & Changes Log.
//
// The Clients Master sheet's "Version" column is the source of truth for a
// client's plan; the team edits it by hand. client_version_state remembers the
// last Version we saw per client, and every sync cron diffs against it — when
// a client's version BECOMES V3 or V2.3, a system entry lands in
// client_activity ("🔁 Switched to V3 (was V2)"), which also pins 📌 on the
// Cost/Deposit conversion timeline. No one has to log switches manually.
//
// First ever run seeds the state silently (no entries for 100+ existing
// clients); every change — v3-related or not — updates the state so a later
// switch reports the right "was".

export interface VersionTrackResult {
  seeded: boolean;
  changed: number;
  logged: number;
  error?: string;
}

const isV3ish = (v: string) => {
  const n = v.toLowerCase().replace(/\s+/g, "");
  return n.includes("v3") || n.includes("v2.3");
};

export async function trackVersionChanges(): Promise<VersionTrackResult> {
  const svc = createServiceClient();
  try {
    const { data: cm, error: cmErr } = await svc.from("clients_master").select("data");
    if (cmErr) return { seeded: false, changed: 0, logged: 0, error: cmErr.message };

    // owner_key → { version, label } from the freshly-synced master mirror.
    const current = new Map<string, { version: string; label: string }>();
    for (const r of (cm ?? []) as Array<{ data: Record<string, unknown> }>) {
      const label = String(r.data?.["Owner Full Name"] ?? "").trim();
      const key = label.toLowerCase();
      if (!key || current.has(key)) continue;
      current.set(key, { version: String(r.data?.["Version"] ?? "").trim(), label });
    }
    if (current.size === 0) return { seeded: false, changed: 0, logged: 0, error: "clients_master empty — skipped" };

    const { data: prevRows, error: stErr } = await svc.from("client_version_state").select("owner_key, version");
    if (stErr) return { seeded: false, changed: 0, logged: 0, error: stErr.message };
    const prev = new Map(((prevRows ?? []) as Array<{ owner_key: string; version: string }>).map((r) => [r.owner_key, r.version]));
    const seeded = prev.size === 0;

    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const stateUpserts: Array<{ owner_key: string; version: string; updated_at: string }> = [];
    const activities: Array<{ client_key: string; client_label: string; action_date: string; note: string; created_by_email: null }> = [];

    for (const [key, cur] of current) {
      const old = prev.get(key);
      if (old === cur.version) continue;
      stateUpserts.push({ owner_key: key, version: cur.version, updated_at: now });
      // Log only real transitions INTO V3/V2.3 (not the initial seeding, not a
      // client's very first appearance, and not e.g. V3 → V1 downgrades).
      if (!seeded && old !== undefined && isV3ish(cur.version) && !isV3ish(old)) {
        activities.push({
          client_key: key,
          client_label: cur.label,
          action_date: today,
          note: `🔁 Switched to ${cur.version}${old ? ` (was ${old})` : ""} — auto-detected from the Master sheet`,
          created_by_email: null,
        });
      }
    }

    if (stateUpserts.length) {
      const { error } = await svc.from("client_version_state").upsert(stateUpserts, { onConflict: "owner_key" });
      if (error) return { seeded, changed: stateUpserts.length, logged: 0, error: error.message };
    }
    if (activities.length) {
      const { error } = await svc.from("client_activity").insert(activities);
      if (error) return { seeded, changed: stateUpserts.length, logged: 0, error: error.message };
    }
    return { seeded, changed: stateUpserts.length, logged: activities.length };
  } catch (e) {
    return { seeded: false, changed: 0, logged: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
