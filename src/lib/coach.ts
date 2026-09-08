import { createServiceClient } from "@/lib/supabase/server";
import type { AuthInfo } from "@/lib/ppa";

// Which clients a Client Success Coach may see. Stephanie sees Stephanie's
// book, Dana sees Dana's, an admin sees everyone. The link is the Clients
// Master sheet's "Assigned" column (first names: Stephanie / Dana / Francisco /
// Nicolas) matched against the local part of the signed-in email.
//
// Clients Master rather than performance_overview on purpose: the view drops
// paused clients, and a paused client still belongs to a coach's book.

type Svc = ReturnType<typeof createServiceClient>;

/** "Stephanie@pmu-bookings.com" → "stephanie" — letters only, lowercased. */
export function coachNameFromEmail(email: string | null | undefined): string {
  return String(email ?? "").split("@")[0].replace(/[^a-z]/gi, "").toLowerCase();
}

const norm = (v: unknown) => String(v ?? "").replace(/[^a-z]/gi, "").toLowerCase();

export interface CoachScope {
  /** The coach whose book is being shown ("" when the viewer has no book). */
  coach: string;
  /** Every coach name that appears in the sheet, for an admin's picker. */
  coaches: string[];
  /** owner_key → coach name, for labelling rows. */
  coachByOwner: Map<string, string>;
  /**
   * The owner_keys this viewer may see, or null for "everything" (admins).
   * A coach whose name matches nothing gets an EMPTY set, never null — an
   * unmatched name must show zero clients, not the whole roster.
   */
  ownerKeys: Set<string> | null;
}

export async function getCoachScope(svc: Svc, auth: AuthInfo, requested?: string): Promise<CoachScope> {
  const { data } = await svc.from("clients_master").select("data");

  const coachByOwner = new Map<string, string>();
  const names = new Set<string>();
  for (const r of data ?? []) {
    const d = (r as { data: Record<string, unknown> }).data ?? {};
    const status = String(d["col_1"] ?? "").toLowerCase();
    if (status !== "live" && status !== "paused") continue;
    const ownerKey = String(d["Owner Full Name"] ?? "").trim().toLowerCase();
    const assigned = String(d["Assigned"] ?? "").trim();
    if (!ownerKey || !assigned) continue;
    coachByOwner.set(ownerKey, assigned);
    names.add(assigned);
  }
  const coaches = [...names].sort();

  const isAdmin = auth.role === "admin";
  const mine = coachNameFromEmail(auth.email);
  const own = coaches.find((c) => norm(c) === mine) ?? "";
  // An admin may look at one coach's book via ?coach=; everyone else is pinned
  // to their own regardless of what the query string says.
  const coach = isAdmin ? (requested ?? "") : own;

  let ownerKeys: Set<string> | null = null;
  if (!isAdmin || coach) {
    ownerKeys = new Set<string>();
    for (const [ownerKey, assigned] of coachByOwner) {
      if (norm(assigned) === norm(coach)) ownerKeys.add(ownerKey);
    }
  }

  return { coach: isAdmin ? coach : own, coaches, coachByOwner, ownerKeys };
}
