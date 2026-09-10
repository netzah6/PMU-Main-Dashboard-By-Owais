import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { chargeSubscription, type Subscription } from "@/lib/subscriptions";

export const maxDuration = 60;

// Charge one subscription right now, on purpose. Admin only, and the admin's
// email goes on the ledger row — this is the deliberate "run it now" button,
// separate from the scheduled run, so the first charge of any subscription can
// be made by hand and checked before the cron is ever trusted with it.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const svc = createServiceClient();
  const { data } = await svc.from("client_subscriptions").select("*").eq("id", id).maybeSingle();
  if (!data) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });

  const sub = data as Subscription;
  const today = new Date().toISOString().slice(0, 10);
  const res = await chargeSubscription(svc, sub, today, auth.email ?? "admin");
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ success: true, ...res });
}
