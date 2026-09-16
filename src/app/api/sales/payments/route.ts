import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { buildCloserPayments, nameKey } from "@/lib/closer-payments";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Closer payment tracker. Admins see every closer; a closer / setter+closer
// seat sees only the deals under their own sales-sheet name.
async function scope() {
  const auth = await getAuth();
  if (!auth) return { error: "Sign in", status: 401 } as const;
  if (auth.role === "admin") return { auth, closer: null as string | null, isAdmin: true } as const;
  if (auth.role !== "closer" && auth.role !== "sales") return { error: "Admins and closers only", status: 403 } as const;
  const svc = createServiceClient();
  const { data } = await svc.from("user_roles").select("sales_name").eq("user_id", auth.userId).maybeSingle();
  const name = (data?.sales_name ?? "").trim();
  if (!name) return { error: "Your login isn't linked to a name in the sales sheet yet — ask an admin to set it in Settings.", status: 403 } as const;
  return { auth, closer: name, isAdmin: false } as const;
}

export async function GET() {
  const s = await scope();
  if ("error" in s) return NextResponse.json({ error: s.error }, { status: s.status });
  try {
    return NextResponse.json({ ...(await buildCloserPayments(createServiceClient(), s.closer)), isAdmin: s.isAdmin, me: s.closer });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

// action "request": the closer asks for the commission on one installment.
// action "paid" / "unpaid": admin marks it paid (or undoes that).
export async function POST(req: Request) {
  const s = await scope();
  if ("error" in s) return NextResponse.json({ error: s.error }, { status: s.status });
  const body = await req.json().catch(() => ({}));
  const svc0 = createServiceClient();
  const now0 = new Date().toISOString();
  const who0 = s.auth.email ?? s.auth.userId;
  // Admin baseline: mark many installments paid in one go (used once at
  // launch so old, already-paid commissions don't all show as open).
  if ((body as { action?: string }).action === "paid_bulk") {
    if (!s.isAdmin) return NextResponse.json({ error: "Admins only" }, { status: 403 });
    const items = ((body as { items?: { clientName: string; closer: string; ym: string; amount?: number }[] }).items ?? []).slice(0, 500);
    const rows = items.filter((i) => i.clientName && i.ym).map((i) => ({ client_key: nameKey(i.clientName), ym: i.ym, closer: i.closer ?? "", client_name: i.clientName, amount: i.amount ?? null, paid_at: now0, paid_by: who0, updated_at: now0 }));
    if (!rows.length) return NextResponse.json({ ok: true, n: 0 });
    const { error } = await svc0.from("closer_commissions").upsert(rows, { onConflict: "client_key,ym" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, n: rows.length });
  }
  const { clientName, closer, ym, amount, action } = body as { clientName?: string; closer?: string; ym?: string; amount?: number; action?: string };
  if (!clientName || !ym || !action) return NextResponse.json({ error: "clientName, ym and action required" }, { status: 400 });
  if (!s.isAdmin && (action !== "request" || (closer ?? "").toLowerCase() !== s.closer!.toLowerCase())) {
    return NextResponse.json({ error: "Closers can only request their own commission" }, { status: 403 });
  }
  const svc = svc0, now = now0, who = who0;
  const base = { client_key: nameKey(clientName), ym, closer: closer ?? "", client_name: clientName, amount: amount ?? null, updated_at: now };
  const patch = action === "request" ? { requested_at: now, requested_by: who }
    : action === "paid" ? { paid_at: now, paid_by: who }
    : action === "unpaid" ? { paid_at: null, paid_by: null }
    : null;
  if (!patch) return NextResponse.json({ error: "unknown action" }, { status: 400 });
  const { error } = await svc.from("closer_commissions").upsert({ ...base, ...patch }, { onConflict: "client_key,ym" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
