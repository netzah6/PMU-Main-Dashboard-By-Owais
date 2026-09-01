import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPmuTasksAccount, ghlUserIdForEmail, GHL_BASE, GHL_VERSION } from "@/lib/ghl-tasks";

export const maxDuration = 30;

// Tasks for ONE client of the agency, looked up by the client's name in the
// PMU Bookings On Demand account (clients are contacts there; GHL tasks hang
// off contacts). Powers the tasks box next to the Activity & Changes Log and
// its "Task" quick-add button.
//   GET  ?name=<client label>       → { contactId, tasks: [...] } (open + done)
//   POST { name, title }            → create a task on that contact, assigned
//                                     to the caller's own GHL user, due tomorrow.

type GhlTask = {
  _id?: string; id?: string;
  title?: string; body?: string;
  dueDate?: string | null;
  completed?: boolean;
  assignedTo?: string | null;
};

async function requireUser() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const acct = await getPmuTasksAccount();
  if (!acct) return { error: NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 }) };
  return { user, acct };
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json", "Content-Type": "application/json" };
}

// Client name → contact in the main account. GHL's query match is LITERAL —
// "Lucinda S Brooks" finds nothing while "Lucinda Brooks" does — so try
// progressively looser variants: full name, first+last word (drops middle
// initials), then last and first name alone. Among hits, an exact normalized
// match wins, then one containing both first and last name, then GHL's top hit.
async function findContact(acct: { locationId: string; token: string }, name: string): Promise<{ id: string; name: string } | null> {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0], last = tokens[tokens.length - 1];
  const queries = [...new Set([
    name.trim(),
    tokens.length > 2 ? `${first} ${last}` : "",
    tokens.length > 1 ? last : "",
    first,
  ].filter(Boolean))];

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const want = norm(name);

  for (const q of queries) {
    const r = await fetch(
      `${GHL_BASE}/contacts/?locationId=${acct.locationId}&query=${encodeURIComponent(q)}&limit=10`,
      { headers: headers(acct.token), cache: "no-store" }
    );
    if (!r.ok) continue;
    const j = (await r.json()) as { contacts?: Array<{ id: string; contactName?: string; firstName?: string; lastName?: string }> };
    const list = (j.contacts ?? []).map((c) => ({
      id: c.id,
      name: (c.contactName || `${c.firstName ?? ""} ${c.lastName ?? ""}`).trim(),
    }));
    if (!list.length) continue;
    const exact = list.find((c) => norm(c.name) === want);
    if (exact) return exact;
    const both = list.find((c) => {
      const n = norm(c.name);
      return n.includes(norm(first)) && n.includes(norm(last));
    });
    if (both) return both;
    // A loose single-token query easily hits the wrong person — only trust
    // GHL's top hit when the query still carried the (near-)full name.
    if (q === queries[0] || (tokens.length > 2 && q === `${first} ${last}`)) return list[0];
  }
  return null;
}

export async function GET(req: NextRequest) {
  const gate = await requireUser();
  if ("error" in gate) return gate.error;
  const { acct } = gate;
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const contact = await findContact(acct, name);
  if (!contact) return NextResponse.json({ contactId: null, contactName: null, tasks: [] });

  // User roster for assignee names on the cards.
  const userNames = new Map<string, string>();
  try {
    const ur = await fetch(`${GHL_BASE}/users/?locationId=${acct.locationId}`, { headers: headers(acct.token), cache: "no-store" });
    if (ur.ok) {
      const uj = (await ur.json()) as { users?: Array<{ id: string; name?: string; firstName?: string; lastName?: string }> };
      (uj.users ?? []).forEach((u) => {
        userNames.set(String(u.id), String(u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`).trim());
      });
    }
  } catch { /* names are cosmetic */ }

  const tr = await fetch(`${GHL_BASE}/contacts/${contact.id}/tasks`, { headers: headers(acct.token), cache: "no-store" });
  if (!tr.ok) return NextResponse.json({ error: `GHL tasks HTTP ${tr.status}` }, { status: 502 });
  const tj = (await tr.json()) as { tasks?: GhlTask[] };
  const tasks = (tj.tasks ?? []).map((t) => ({
    id: String(t._id ?? t.id ?? ""),
    title: t.title ?? "",
    body: t.body ?? "",
    dueDate: t.dueDate ?? null,
    completed: !!t.completed,
    assignedToName: t.assignedTo ? (userNames.get(String(t.assignedTo)) ?? "") : "",
  })).filter((t) => t.id);
  // Open tasks first (soonest due on top), completed after.
  tasks.sort((a, b) =>
    Number(a.completed) - Number(b.completed) || String(a.dueDate ?? "9999").localeCompare(String(b.dueDate ?? "9999"))
  );
  return NextResponse.json({ contactId: contact.id, contactName: contact.name, tasks });
}

export async function POST(req: NextRequest) {
  const gate = await requireUser();
  if ("error" in gate) return gate.error;
  const { user, acct } = gate;
  const body = (await req.json().catch(() => ({}))) as { name?: string; title?: string };
  const name = (body.name ?? "").trim();
  const title = (body.title ?? "").trim();
  if (!name || !title) return NextResponse.json({ error: "name and title required" }, { status: 400 });

  const contact = await findContact(acct, name);
  if (!contact) {
    return NextResponse.json({ error: `No GHL contact found for "${name}" in PMU Bookings On Demand` }, { status: 404 });
  }

  // Self-assignment is the point of the button ("a task for herself") — a
  // login with no matching GHL user gets a clear error instead of a task
  // they'd never see on their scoped Tasks tab.
  const myGhlId = await ghlUserIdForEmail(acct, user.email);
  if (!myGhlId) {
    return NextResponse.json(
      { error: `Your login (${user.email}) has no matching GHL user in PMU Bookings On Demand — ask an admin to add one` },
      { status: 409 }
    );
  }

  // GHL requires a due date; tomorrow noon UTC keeps it near the top of today's list.
  const due = new Date();
  due.setUTCDate(due.getUTCDate() + 1);
  due.setUTCHours(12, 0, 0, 0);

  const r = await fetch(`${GHL_BASE}/contacts/${contact.id}/tasks`, {
    method: "POST",
    headers: headers(acct.token),
    body: JSON.stringify({
      title,
      body: `Added from the ${contact.name} activity log by ${user.email}`,
      dueDate: due.toISOString(),
      completed: false,
      assignedTo: myGhlId,
    }),
  });
  const text = await r.text();
  if (!r.ok) return NextResponse.json({ error: text.slice(0, 300) || "GHL create failed" }, { status: r.status });
  return NextResponse.json({ success: true, contactId: contact.id });
}
