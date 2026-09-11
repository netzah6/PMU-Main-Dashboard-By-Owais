import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getPmuTasksAccount, ghlUserIdForEmail, GHL_BASE, GHL_VERSION } from "@/lib/ghl-tasks";
import { normalizeOwnerKey } from "@/lib/normalizers";

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

// Client → contact in the main account, most reliable source first.
//
// 1. The Contact ID on the client's Clients Master row. It is the link the
//    sheet keeps on purpose, and it survives everything a name search cannot:
//    Jessica Lee is filed in GHL under her legal name, "Oyunchimeg
//    Erdenetsogt", so the name search found nothing and the Task button
//    refused her (2026-09-11). Verified with a GET first — a stale id must
//    not be trusted.
// 2. The Email on that row — GHL's email search is exact.
// 3. The name search below, as before, for rows with neither.
async function resolveContact(
  acct: { locationId: string; token: string }, name: string
): Promise<{ id: string; name: string; via: "contact_id" | "email" | "name" } | null> {
  const key = normalizeOwnerKey(name.replace(/\([^)]*\)/g, " ").split("/")[0]);
  if (key) {
    const svc = createServiceClient();
    const { data } = await svc.from("clients_master").select("data");
    const row = (data ?? []).find(
      (r) => normalizeOwnerKey((r as { data: Record<string, unknown> }).data?.["Owner Full Name"]) === key
    ) as { data: Record<string, string> } | undefined;
    const contactId = String(row?.data?.["Contact ID"] ?? "").trim();
    const email = String(row?.data?.["Email"] ?? "").trim();

    if (/^[A-Za-z0-9_-]{15,}$/.test(contactId)) {
      const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: headers(acct.token), cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { contact?: { id: string; contactName?: string; firstName?: string; lastName?: string; locationId?: string } };
        const c = j.contact;
        // The id must belong to THIS account — a client's id from their own
        // sub-account would otherwise attach the task to the wrong location.
        if (c?.id && (!c.locationId || c.locationId === acct.locationId)) {
          return { id: c.id, name: (c.contactName || `${c.firstName ?? ""} ${c.lastName ?? ""}`).trim(), via: "contact_id" };
        }
      }
    }
    if (email.includes("@")) {
      const r = await fetch(
        `${GHL_BASE}/contacts/?locationId=${acct.locationId}&query=${encodeURIComponent(email)}&limit=5`,
        { headers: headers(acct.token), cache: "no-store" }
      );
      if (r.ok) {
        const j = (await r.json()) as { contacts?: Array<{ id: string; email?: string; contactName?: string; firstName?: string; lastName?: string }> };
        const hit = (j.contacts ?? []).find((c) => String(c.email ?? "").toLowerCase() === email.toLowerCase());
        if (hit) return { id: hit.id, name: (hit.contactName || `${hit.firstName ?? ""} ${hit.lastName ?? ""}`).trim(), via: "email" };
      }
    }
  }
  const byName = await findContact(acct, name);
  return byName ? { ...byName, via: "name" } : null;
}

// Client name → contact in the main account. GHL's query match is LITERAL —
// "Lucinda S Brooks" finds nothing while "Lucinda Brooks" does — so try
// progressively looser variants: full name, first+last word (drops middle
// initials), then last and first name alone. Among hits, an exact normalized
// match wins, then one containing both first and last name, then GHL's top hit.
async function findContact(acct: { locationId: string; token: string }, name: string): Promise<{ id: string; name: string } | null> {
  // Dashboard labels carry decorations the contact never has: "(Dez)" style
  // nicknames and "A / B" alternates. Strip them for tokenizing, but keep the
  // nickname as an alternate first name for scoring and as its own query.
  const nick = (name.match(/\(([^)]+)\)/)?.[1] ?? "").trim();
  const clean = name.replace(/\([^)]*\)/g, " ").split("/")[0].replace(/\s+/g, " ").trim();
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0], last = tokens[tokens.length - 1];
  const queries = [...new Set([
    clean,
    tokens.length > 2 ? `${first} ${last}` : "",
    nick && tokens.length > 1 ? `${nick} ${last}` : "",
    tokens.length > 1 ? last : "",
    first,
    nick,
  ].filter(Boolean))];

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const want = norm(clean);

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
      // The nickname counts as an alternate first name ("Desirie Crowe (Dez)"
      // may live in GHL as "Dez Crowe").
      return n.includes(norm(last)) && (n.includes(norm(first)) || (nick && n.includes(norm(nick))));
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

  const contact = await resolveContact(acct, name);
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

  const contact = await resolveContact(acct, name);
  if (!contact) {
    return NextResponse.json({
      error: `No GHL contact found for "${name}" in PMU Bookings On Demand — add their Contact ID or Email to the Clients Master sheet and try again`,
    }, { status: 404 });
  }

  // Self-assignment is the point of the button, but a login with no matching
  // GHL user must not lose the work: the task is still created (unassigned)
  // and the reply says it will not show on their own Tasks tab until an admin
  // adds them as a GHL user. Refusing outright blocked Marie entirely
  // (user report 2026-09-05).
  const myGhlId = await ghlUserIdForEmail(acct, user.email);

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
      ...(myGhlId ? { assignedTo: myGhlId } : {}),
    }),
  });
  const text = await r.text();
  if (!r.ok) return NextResponse.json({ error: text.slice(0, 300) || "GHL create failed" }, { status: r.status });
  return NextResponse.json({
    success: true,
    contactId: contact.id,
    assigned: !!myGhlId,
    ...(myGhlId ? {} : {
      warning: `Task created, but ${user.email} isn't a user in PMU Bookings On Demand, so it can't be assigned to you and won't appear on your Tasks tab. Ask an admin to add you as a GHL user.`,
    }),
  });
}
