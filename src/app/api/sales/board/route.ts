import { NextRequest, NextResponse } from "next/server";
import { effectiveSalesRole } from "@/lib/view-as";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { buildSalesBoard, type SalesBoard } from "@/lib/sales-board";
import { SALES_ROLES, type UserRole } from "@/lib/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Sales tab data: setter + closer KPIs and their to-do lists, from the synced
// sales sheets. Admins get everything; a sales seat gets its own side only —
// setter: the discovery side (every setter) PLUS every closer's demos (she
// tracks them), closer: their own demos only (matched by
// user_roles.sales_name), "sales": both sides, all closers. Trimmed here, not
// in the page, so a closer can't read another closer's numbers from the API.
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  const realRole = auth?.role ?? null;
  if (!auth || !realRole || !["admin", ...SALES_ROLES].includes(realRole as UserRole)) return NextResponse.json({ error: "Admins and sales seats only" }, { status: 403 });
  // An admin previewing a sales seat ("View as") gets that seat's data.
  const { role, previewName, previewing } = effectiveSalesRole(realRole, req.headers);
  try {
    const svc = createServiceClient();
    const board = await buildSalesBoard(svc);
    if (role === "admin") return NextResponse.json(board);
    const { data: me } = await svc.from("user_roles").select("sales_name").eq("user_id", auth.userId).maybeSingle();
    // Previewing admins have no sales name: they pick the closer to preview
    // (default = the first closer on the board).
    const myName = previewing ? (previewName ?? board.closers[0] ?? "") : (me?.sales_name ?? "").trim();
    const seesSetter = role === "setter" || role === "sales";
    const seesCloser = role === "closer" || role === "sales" || role === "setter";
    // Closer side: a closer sees only the seat matching their sales name; a
    // setter (and the setter+closer "sales" seat) sees EVERY closer — the
    // setter tracks the demos she booked through to the close (owner,
    // 2026-10-12: "Jennifer needs to track the demos of the closers").
    const mine = role === "closer"
      ? board.closers.filter((n) => n.toLowerCase() === myName.toLowerCase())
      : board.closers;
    const out: SalesBoard & { scope: { setter: boolean; closer: boolean; myName: string; previewNames?: string[] } } = {
      ...board,
      scope: { setter: seesSetter, closer: seesCloser, myName, ...(previewing && role === "closer" ? { previewNames: board.closers } : {}) },
      setters: seesSetter ? board.setters : [],
      setterStats: seesSetter ? board.setterStats : {},
      setterTodos: seesSetter ? board.setterTodos : [],
      formerSetters: seesSetter ? board.formerSetters : {},
      closers: seesCloser ? mine : [],
      closerStats: seesCloser ? Object.fromEntries(mine.map((n) => [n, board.closerStats[n]])) : {},
      closerTodos: seesCloser ? board.closerTodos.filter((t) => mine.includes(t.who)) : [],
      formerClosers: role === "closer" ? {} : board.formerClosers,
    };
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
