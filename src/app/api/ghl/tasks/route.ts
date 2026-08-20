import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPmuTasksAccount, GHL_BASE, GHL_VERSION } from "@/lib/ghl-tasks";

export const maxDuration = 60;

type GhlTask = {
  _id: string;
  title?: string;
  body?: string;
  dueDate?: string | null;
  completed?: boolean;
  assignedTo?: string | null;
  contactId?: string | null;
  searchAfter?: unknown;
  assignedToUserDetails?: { firstName?: string; lastName?: string; name?: string };
  contactDetails?: { firstName?: string; lastName?: string };
};

// All open tasks for the PMU Bookings On Demand account, plus the user roster.
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: roleRow } = await supabase.from("user_roles").select("role").eq("user_id", user.id).single();
  const isAdmin = roleRow?.role === "admin";

  const acct = await getPmuTasksAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found in the keys sheet" }, { status: 404 });

  const H = { Authorization: `Bearer ${acct.token}`, Version: GHL_VERSION, Accept: "application/json", "Content-Type": "application/json" };

  // User roster (for names + the reassign dropdown). Emails stay server-side —
  // they're only for matching the login to its GHL user, never sent to the page.
  const users: { id: string; name: string }[] = [];
  const emails = new Map<string, string>(); // GHL user id -> email (lowercased)
  try {
    const ur = await fetch(`${GHL_BASE}/users/?locationId=${acct.locationId}`, { headers: H });
    if (ur.ok) {
      const uj = (await ur.json()) as { users?: Array<Record<string, unknown>> };
      (uj.users ?? []).forEach((u) => {
        const name = String(u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`).trim() || String(u.email ?? "");
        users.push({ id: String(u.id), name });
        if (u.email) emails.set(String(u.id), String(u.email).trim().toLowerCase());
      });
    }
  } catch { /* roster is best-effort */ }

  // Everyone sees their own tasks only; admins see everyone's. A login with no
  // matching GHL user gets an empty list — no GHL user means no tasks can be
  // assigned to them in the first place.
  let scopedTo: string | null = null;
  if (!isAdmin) {
    const myEmail = (user.email ?? "").trim().toLowerCase();
    scopedTo = [...emails.entries()].find(([, e]) => e === myEmail)?.[0] ?? "__no_ghl_user__";
  }

  // All open tasks (cursor pagination via searchAfter)
  const raw: GhlTask[] = [];
  let searchAfter: unknown = undefined;
  for (let page = 0; page < 25; page++) {
    const body: Record<string, unknown> = { completed: false, limit: 100 };
    if (searchAfter) body.searchAfter = searchAfter;
    const r = await fetch(`${GHL_BASE}/locations/${acct.locationId}/tasks/search`, { method: "POST", headers: H, body: JSON.stringify(body) });
    if (!r.ok) break;
    const j = (await r.json()) as { tasks?: GhlTask[] };
    const batch = j.tasks ?? [];
    if (!batch.length) break;
    raw.push(...batch);
    searchAfter = batch[batch.length - 1].searchAfter;
    if (batch.length < 100 || !searchAfter) break;
  }

  const visible = scopedTo ? raw.filter((t) => t.assignedTo === scopedTo) : raw;
  const tasks = visible.map((t) => ({
    id: t._id,
    title: t.title ?? "",
    body: t.body ?? "",
    dueDate: t.dueDate ?? null,
    completed: !!t.completed,
    assignedTo: t.assignedTo ?? null,
    assignedToName: (t.assignedToUserDetails
      ? (t.assignedToUserDetails.name || `${t.assignedToUserDetails.firstName ?? ""} ${t.assignedToUserDetails.lastName ?? ""}`).trim()
      : "") || (users.find((u) => u.id === t.assignedTo)?.name ?? ""),
    contactId: t.contactId ?? null,
    contactName: t.contactDetails ? `${t.contactDetails.firstName ?? ""} ${t.contactDetails.lastName ?? ""}`.trim() : "",
  }));

  return NextResponse.json({ users, tasks, locationId: acct.locationId, scoped: !!scopedTo });
}
