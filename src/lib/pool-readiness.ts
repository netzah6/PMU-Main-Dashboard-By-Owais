// Is a "Clean New Account N" actually safe to hand to a new client?
// Pure — shared by the server (pool route, setup run) and the Cleanup tab.
//
// Until 10/15/2026 "ready" meant EMPTY: no custom values, fields, calendars,
// automations. That was backwards. The wipe empties the account, but the
// New Client Setup fills EXISTING custom values and never creates them —
// so an empty account fails every fill step (Sally Nails And Spa, Clean New
// Account 78). Ready then meant "snapshot loaded".
//
// Owner 10/25/2026: a clean account is EMPTY — no contacts, calendars,
// automations, funnels, custom values or fields — and A2P verified. The
// snapshot keeps changing, so it is loaded only when a setup takes the
// account (setup step 0), never ahead of time. Ready now means:
//   • nothing on the account (`dirty` = every leftover, template included)
//   • A2P approved

export type PoolReadiness = "ready" | "snapshot" | "partial" | "dirty" | "unknown";

export type PoolReadinessInput = {
  dirty: number | null;              // everything left on the account (contacts, template, funnels…)
  a2p: string;                       // "approved" | "pending"
  clean_checked_at: string | null;   // last Re-check
  snapshot_loaded_at: string | null; // snapshot confirmed on the account
  snapshot_task_id?: string | null;  // latest AI Agent task
  snapshot_note?: string | null;     // what the task / Re-check said
};

export function poolReadiness(r: PoolReadinessInput): PoolReadiness {
  if (r.clean_checked_at == null || r.dirty == null) return "unknown";
  if (r.dirty > 0) return "dirty";
  return r.a2p === "approved" ? "ready" : "partial";
}

// Why this account isn't offered, in the words the team would use. null = ready.
export function poolBlocker(r: PoolReadinessInput & { clean_note?: string | null }): string | null {
  switch (poolReadiness(r)) {
    case "ready": return null;
    case "unknown": return "not checked yet";
    case "dirty": return `not empty — ${r.clean_note ?? ""}`.trim();
    case "snapshot":
      return r.snapshot_note?.startsWith("✗")
        ? `snapshot load failed — ${r.snapshot_note.slice(1).trim()}`
        : r.snapshot_task_id ? "waiting for snapshot (AI Agent)" : "no snapshot loaded — the AI Agent loads it when a setup takes the account (or press Load snapshot)";
    default: return "A2P not confirmed";
  }
}

export const READINESS_LABEL: Record<PoolReadiness, string> = {
  ready: "Ready to use",
  snapshot: "Waiting for snapshot",
  partial: "Needs A2P",
  dirty: "Not clean",
  unknown: "Not checked",
};
