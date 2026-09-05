import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import type { CreditRow } from "@/lib/credits";

// Every signed-in team member can see the credit list (their own requests and
// where they stand); the caller's role rides along so the page knows whether to
// show the approval queue.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("client_credits")
    .select("*")
    .order("requested_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ credits: (data ?? []) as CreditRow[], role: auth.role, email: auth.email });
}
