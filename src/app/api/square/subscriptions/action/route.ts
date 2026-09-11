import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { pauseSubscription, resumeSubscription, deleteSubscriptionAction } from "@/lib/square";

export const maxDuration = 60;

// Pause, resume, or cancel a scheduled pause on a Square subscription, from the
// dashboard. Admin only. Every attempt is logged with what Square answered, so
// the activity feed shows who did what to which client and when.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    id?: string; action?: string; customerName?: string; actionId?: string;
  };
  const id = String(body.id ?? "");
  const action = String(body.action ?? "");
  if (!id || !["pause", "resume", "cancel_pause"].includes(action)) {
    return NextResponse.json({ error: "id and a valid action are required" }, { status: 400 });
  }

  const svc = createServiceClient();
  const log = async (status: "succeeded" | "failed", detail: string | null, error: string | null) => {
    await svc.from("square_subscription_actions").insert({
      subscription_id: id, customer_name: body.customerName ?? null, action, status, detail, error, actor: auth.email,
    });
  };

  try {
    let detail: string;
    if (action === "pause") {
      const r = await pauseSubscription(id);
      detail = r.effectiveDate ? `pauses ${r.effectiveDate}` : `status ${r.status}`;
    } else if (action === "resume") {
      const r = await resumeSubscription(id);
      detail = r.effectiveDate ? `resumes ${r.effectiveDate}` : `status ${r.status}`;
    } else {
      if (!body.actionId) return NextResponse.json({ error: "No pending pause to cancel" }, { status: 400 });
      const r = await deleteSubscriptionAction(id, body.actionId);
      detail = `scheduled pause removed · status ${r.status}`;
    }
    await log("succeeded", detail, null);
    return NextResponse.json({ success: true, detail });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed";
    await log("failed", null, error);
    return NextResponse.json({ error }, { status: 502 });
  }
}
