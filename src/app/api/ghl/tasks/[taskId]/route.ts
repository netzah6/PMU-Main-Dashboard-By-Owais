import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPmuTasksAccount, GHL_BASE, GHL_VERSION } from "@/lib/ghl-tasks";

export const maxDuration = 30;

// Update one task in GHL (title / body / dueDate / completed / assignedTo).
// GHL updates tasks under their contact: PUT /contacts/{contactId}/tasks/{taskId}.
export async function PATCH(req: NextRequest, { params }: { params: { taskId: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const acct = await getPmuTasksAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 });

  const body = (await req.json()) as {
    contactId?: string;
    title?: string;
    body?: string;
    dueDate?: string | null;
    completed?: boolean;
    assignedTo?: string | null;
  };
  const { contactId, ...rest } = body;
  if (!contactId) return NextResponse.json({ error: "contactId required" }, { status: 400 });

  const H = { Authorization: `Bearer ${acct.token}`, Version: GHL_VERSION, Accept: "application/json", "Content-Type": "application/json" };

  // Marking done (or re-opening) with no other edits → use GHL's dedicated
  // task-complete endpoint. It only needs { completed }, so we don't have to
  // resend title/dueDate (which the full-update endpoint requires).
  const onlyCompletion =
    rest.completed !== undefined &&
    rest.title === undefined && rest.body === undefined &&
    rest.dueDate === undefined && rest.assignedTo === undefined;

  const url = onlyCompletion
    ? `${GHL_BASE}/contacts/${contactId}/tasks/${params.taskId}/completed`
    : `${GHL_BASE}/contacts/${contactId}/tasks/${params.taskId}`;
  const payload = onlyCompletion ? { completed: rest.completed } : rest;

  const r = await fetch(url, { method: "PUT", headers: H, body: JSON.stringify(payload) });

  if (!r.ok) {
    const text = await r.text();
    return NextResponse.json({ error: text || "GHL update failed" }, { status: r.status });
  }
  return NextResponse.json({ success: true });
}
