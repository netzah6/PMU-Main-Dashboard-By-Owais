import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
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
// ?users=1 → roster only (the Add-task forms need the assignee list, not every task).
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rosterOnly = req.nextUrl.searchParams.get("users") === "1";
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
  if (rosterOnly) return NextResponse.json({ users, locationId: acct.locationId });

  // Everyone sees their own tasks only; admins see everyone's.
  const myEmail = (user.email ?? "").trim().toLowerCase();
  let scopedTo: string | null = null;
  if (!isAdmin) scopedTo = [...emails.entries()].find(([, e]) => e === myEmail)?.[0] ?? "__no_ghl_user__";
  // Some team members have no user in THIS sub-account (Marie, 2026-09-06), so
  // nothing can be assigned to them and their list came back empty. Tasks made
  // from the dashboard record the author in the body ("… by <email>"), so they
  // still see their own work without needing a seat here.
  const mineByAuthor = (t: GhlTask) =>
    !!myEmail && String(t.body ?? "").toLowerCase().includes(myEmail);

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

  const visible = scopedTo ? raw.filter((t) => t.assignedTo === scopedTo || mineByAuthor(t)) : raw;
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

/* Create a task in GHL (owner, 10/19/2026: "Add task" on the Tasks tab and
   "Create this as a task" in the AI tab). Any team member. The task hangs
   off a contact in the PMU Bookings On Demand account: either the contact
   id the AI tab already has, or the client's name resolved through Clients
   Master ("Contact ID" column). The author is written into the body so a
   coach with no GHL seat still sees it as theirs (same rule as GET). */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: roleRow } = await supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if (!(roleRow as { role?: string } | null)?.role) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const b = (await req.json().catch(() => ({}))) as { contactId?: string; client?: string; title?: string; body?: string; dueDate?: string | null; assignedTo?: string | null };
  const title = String(b.title ?? "").trim().slice(0, 200);
  if (title.length < 3) return NextResponse.json({ error: "Give the task a title" }, { status: 400 });

  let contactId = String(b.contactId ?? "").trim();
  let contactName = "";
  if (!contactId) {
    const q = String(b.client ?? "").trim().toLowerCase();
    if (q.length < 3) return NextResponse.json({ error: "Name the client (owner or business)" }, { status: 400 });
    const svc = createServiceClient();
    const { data: cm } = await svc.from("clients_master").select("data");
    const rows = (cm ?? []).map((r) => r.data as Record<string, unknown>);
    const owner = (d: Record<string, unknown>) => String(d["Owner Full Name"] ?? "").trim();
    const biz = (d: Record<string, unknown>) => String(d["Business Name"] ?? "").trim();
    const exact = rows.filter((d) => owner(d).toLowerCase() === q || biz(d).toLowerCase() === q);
    const hits = exact.length ? exact : rows.filter((d) => owner(d).toLowerCase().includes(q) || biz(d).toLowerCase().includes(q));
    const names = [...new Set(hits.map(owner).filter(Boolean))];
    if (!names.length) return NextResponse.json({ error: `No client matches "${b.client}"` }, { status: 404 });
    if (names.length > 1) return NextResponse.json({ error: `Several clients match: ${names.slice(0, 5).join(", ")} — type the full name` }, { status: 409 });
    const row = hits.find((d) => owner(d) === names[0])!;
    contactId = String(row["Contact ID"] ?? "").trim();
    contactName = names[0];
    if (!contactId) return NextResponse.json({ error: `${names[0]} has no Contact ID in Clients Master — open their chat in the AI tab and create the task from there` }, { status: 404 });
  }

  const acct = await getPmuTasksAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 });
  const H = { Authorization: `Bearer ${acct.token}`, Version: GHL_VERSION, Accept: "application/json", "Content-Type": "application/json" };
  const by = (user.email ?? "").trim();
  const due = b.dueDate ? new Date(b.dueDate) : new Date(Date.now() + 86400_000);
  const body = `${String(b.body ?? "").trim()}${by ? `\n\n— by ${by}` : ""}`.trim();
  const payload: Record<string, unknown> = { title, body, dueDate: due.toISOString(), completed: false };
  if (b.assignedTo) payload.assignedTo = b.assignedTo;
  const r = await fetch(`${GHL_BASE}/contacts/${contactId}/tasks`, { method: "POST", headers: H, body: JSON.stringify(payload) });
  const text = await r.text();
  if (!r.ok) return NextResponse.json({ error: text.slice(0, 200) || "GHL create failed" }, { status: r.status });
  let id = "";
  try { id = String((JSON.parse(text) as { task?: { _id?: string; id?: string } }).task?._id ?? (JSON.parse(text) as { task?: { id?: string } }).task?.id ?? ""); } catch { /* id optional */ }
  return NextResponse.json({ success: true, id, contactId, contactName });
}

