import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

/* The 🗓️ Upcoming tab (owner, 11/03/2026: "where can I track all the future
   builds — what you're going to do on which date?"). Rows live in
   planned_items; Claude keeps them current. Admins only.
     GET                          → every item (done ones from the last 30 days)
     POST { id, done: boolean }   → tick an item done / reopen it */
async function admin() {
  const auth = await getAuth();
  return auth && auth.role === "admin" ? auth : null;
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const { data, error } = await createServiceClient().from("planned_items")
    .select("id, due_date, due_label, title, detail, who, status, area, sort, done_at, done_by, updated_at")
    .or(`done_at.is.null,done_at.gte.${new Date(Date.now() - 30 * 86400_000).toISOString()}`)
    .order("due_date", { ascending: true, nullsFirst: false }).order("sort").order("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const auth = await admin();
  if (!auth) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { id?: number; done?: boolean };
  const id = Number(body.id);
  if (!Number.isInteger(id) || typeof body.done !== "boolean") return NextResponse.json({ error: "id and done required" }, { status: 400 });
  const now = new Date().toISOString();
  // Done = done_at set; the item keeps its status, so reopening restores it as it was.
  const patch = body.done
    ? { done_at: now, done_by: auth.email ?? auth.userId, updated_at: now }
    : { done_at: null, done_by: null, updated_at: now };
  const { error } = await createServiceClient().from("planned_items").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
