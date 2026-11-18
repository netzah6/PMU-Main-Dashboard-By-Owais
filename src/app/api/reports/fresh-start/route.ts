import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// Reports tab "fresh start" dates (owner 11/18/2026): a returning client on a
// new sub-account, or one who moved to Pay Per Appointment, should only show
// numbers from that day on. Stored in app_settings as
// { "<owner name, lowercase>": "YYYY-MM-DD" }. Anyone signed in reads; admins set.
const KEY = "report_fresh_start";

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data } = await svc.from("app_settings").select("value").eq("key", KEY).maybeSingle();
  return NextResponse.json({ starts: (data?.value ?? {}) as Record<string, unknown>, isAdmin: auth.role === "admin" });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { name?: string; date?: string | null; label?: string | null };
  const name = String(body.name ?? "").trim().toLowerCase();
  const date = body.date ? String(body.date).trim() : null;
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  const svc = createServiceClient();
  const { data } = await svc.from("app_settings").select("value").eq("key", KEY).maybeSingle();
  // Value: "YYYY-MM-DD" or { date, label } — label is the divider text ("Started Pay Per Appointment").
  const starts = { ...((data?.value ?? {}) as Record<string, string | { date: string; label?: string }>) };
  const label = body.label ? String(body.label).trim().slice(0, 60) : "";
  if (date) starts[name] = label ? { date, label } : date; else delete starts[name];
  const { error } = await svc.from("app_settings").upsert({ key: KEY, value: starts }, { onConflict: "key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, starts });
}
