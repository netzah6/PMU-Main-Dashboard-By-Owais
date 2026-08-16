import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";

// The lead journey for one funnel (admin only): every lead, which
// variant brought them in, and the exact step they reached —
// survey → picked a time → paid & booked.
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const slug = req.nextUrl.searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });

  const svc = createServiceClient();
  const [{ data: leads }, { data: exps }] = await Promise.all([
    svc
      .from("onebox_leads")
      .select("id, full_name, phone, created_at, ghl_status, picked_time_at, slot_iso, experiment_id, variant_key")
      .eq("slug", slug)
      .order("created_at", { ascending: false })
      .limit(300),
    svc.from("onebox_experiments").select("id, onebox_variants(vkey, label)").eq("slug", slug),
  ]);

  // experiment_id + vkey → human label ("One-box funnel", "Urgency test", …)
  const labels: Record<string, string> = {};
  for (const e of (exps ?? []) as { id: number; onebox_variants: { vkey: string; label: string }[] }[]) {
    for (const v of e.onebox_variants ?? []) labels[`${e.id}:${v.vkey}`] = v.label;
  }

  const rows = (leads ?? []).map((l) => {
    const s = l.ghl_status ?? "";
    const stage =
      s === "booked" || s === "paid"
        ? "paid_booked"
        : s === "paid-not-booked"
          ? "paid_no_slot"
          : l.picked_time_at
            ? "picked_no_deposit"
            : "lead_only";
    return {
      id: l.id,
      name: l.full_name,
      phone: l.phone,
      at: l.created_at,
      stage,
      slot: l.slot_iso ?? null,
      variant:
        l.experiment_id && l.variant_key
          ? (labels[`${l.experiment_id}:${l.variant_key}`] ?? `variant ${l.variant_key}`)
          : null,
    };
  });

  return NextResponse.json({ leads: rows });
}
