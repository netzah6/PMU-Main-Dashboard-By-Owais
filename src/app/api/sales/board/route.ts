import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { buildSalesBoard, type SalesBoard } from "@/lib/sales-board";
import { SALES_ROLES, type UserRole } from "@/lib/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Sales tab data: setter + closer KPIs and their to-do lists, from the synced
// sales sheets. Admins get everything; a sales seat gets its own side only —
// setter: the discovery side (every setter), closer: their own demos (matched
// by user_roles.sales_name), "sales": both. Trimmed here, not in the page,
// so a closer can't read another closer's numbers from the API.
export async function GET() {
  const auth = await getAuth();
  const role = auth?.role ?? null;
  if (!auth || !role || !["admin", ...SALES_ROLES].includes(role as UserRole)) return NextResponse.json({ error: "Admins and sales seats only" }, { status: 403 });
  try {
    const svc = createServiceClient();
    const board = await buildSalesBoard(svc);
    if (role === "admin") return NextResponse.json(board);
    const { data: me } = await svc.from("user_roles").select("sales_name").eq("user_id", auth.userId).maybeSingle();
    const myName = (me?.sales_name ?? "").trim();
    const seesSetter = role === "setter" || role === "sales";
    const seesCloser = role === "closer" || role === "sales";
    // Closer side: only the seat that matches the login's sales name.
    const mine = board.closers.filter((n) => n.toLowerCase() === myName.toLowerCase());
    const out: SalesBoard & { scope: { setter: boolean; closer: boolean; myName: string } } = {
      ...board,
      scope: { setter: seesSetter, closer: seesCloser, myName },
      setters: seesSetter ? board.setters : [],
      setterStats: seesSetter ? board.setterStats : {},
      setterTodos: seesSetter ? board.setterTodos : [],
      formerSetters: seesSetter ? board.formerSetters : {},
      closers: seesCloser ? mine : [],
      closerStats: seesCloser ? Object.fromEntries(mine.map((n) => [n, board.closerStats[n]])) : {},
      closerTodos: seesCloser ? board.closerTodos.filter((t) => mine.includes(t.who)) : [],
      formerClosers: {},
    };
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
