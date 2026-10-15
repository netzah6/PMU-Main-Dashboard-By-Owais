import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { advanceSetup, approveSetup, liveCardStatuses, poolChoices, retryStep, skipStep } from "@/lib/setup-run";
import type { SetupState } from "@/lib/setup-runbook";

// The claim + the funnel creation + the Commas product run inside Approve.
export const maxDuration = 300;

// New Client Setup run for one Onboarding card.
//   GET  → the run state, live card statuses, and the clean accounts to pick from
//   POST {action:"approve", poolLocationId}   admin — nothing touches GHL before this
//   POST {action:"refresh"}                    re-run the engine (after a fix in GHL)
//   POST {action:"retry", key}                 admin — run a failed step again
//   POST {action:"skip", key, note?}           admin/coach — mark a step done by hand
//   POST {action:"password"}                   admin — the employee password (card only)

async function who(): Promise<{ email: string; role: string } | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const svc = createServiceClient();
  const { data } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  return { email: user.email ?? user.id, role: String((data as { role?: string } | null)?.role ?? "") };
}

// The password never leaves the server except through the explicit "password" action.
const redact = (s: SetupState | null): (Omit<SetupState, "password"> & { has_password: boolean }) | null =>
  s ? (({ password, ...rest }) => ({ ...rest, has_password: !!password }))(s) : null;

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const u = await who();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data: row, error } = await svc.from("onboardings").select("setup, claim").eq("id", params.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message.includes("setup") ? `${error.message} — run supabase/new-client-setup.sql` : error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const setup = (row.setup as SetupState | null) ?? null;
  const cards = await liveCardStatuses(svc, setup);
  // The pool is only needed before Approve (and the Claim button's account wins).
  const claimLoc = (row.claim as { location_id?: string; original_name?: string } | null)?.location_id ?? null;
  const pool = setup || claimLoc ? null : await poolChoices(svc);
  return NextResponse.json({ setup: redact(setup), cards, pool, claimedLocation: claimLoc, canApprove: u.role === "admin" });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const u = await who();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; poolLocationId?: string; key?: string; note?: string };
  const svc = createServiceClient();
  const admin = u.role === "admin";
  try {
    switch (String(body.action ?? "")) {
      case "approve": {
        if (!admin) return NextResponse.json({ error: "Only an admin can approve a setup" }, { status: 403 });
        const setup = await approveSetup(svc, params.id, String(body.poolLocationId ?? ""), u.email);
        return NextResponse.json({ setup: redact(setup) });
      }
      case "refresh": {
        const setup = await advanceSetup(svc, params.id);
        return NextResponse.json({ setup: redact(setup) });
      }
      case "retry": {
        if (!admin) return NextResponse.json({ error: "Only an admin can retry a step" }, { status: 403 });
        const setup = await retryStep(svc, params.id, String(body.key ?? ""), u.email);
        return NextResponse.json({ setup: redact(setup) });
      }
      case "skip": {
        if (!(admin || u.role === "editor")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        const setup = await skipStep(svc, params.id, String(body.key ?? ""), u.email, body.note);
        return NextResponse.json({ setup: redact(setup) });
      }
      case "password": {
        if (!admin) return NextResponse.json({ error: "Only an admin can see the password" }, { status: 403 });
        const { data } = await svc.from("onboardings").select("setup").eq("id", params.id).maybeSingle();
        const pw = ((data?.setup as SetupState | null) ?? null)?.password ?? null;
        return NextResponse.json({ password: pw });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
