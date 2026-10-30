import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { advanceSetup, approveSetup, confirmStep, liveCardStatuses, poolChoices, retryStep, skipStep } from "@/lib/setup-run";
import { missingFields, normVersion, type SetupState } from "@/lib/setup-runbook";
import { answersFromMainContact } from "@/lib/survey-answers";

// The claim + the funnel creation + the Commas product run inside Approve.
export const maxDuration = 300;

// New Client Setup run for one Onboarding card.
//   GET  → the run state, live card statuses, and the clean accounts to pick from
//   POST {action:"approve", poolLocationId}   admin/coach — nothing touches GHL before this
//   POST {action:"refresh"}                    re-run the engine (after a fix in GHL)
//   POST {action:"retry", key}                 admin — run a failed step again
//   POST {action:"skip", key, note?}           admin/coach — mark a step done by hand
//   POST {action:"password"}                   admin/coach — the employee password (card only)

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

// The Meta pixels the agency reuses across clients (owner 10/26/2026: "a lot
// of pixels we usually use — make it easy to choose them"). A pixel counts as
// one of ours when 2+ one-boxes already carry it; one-offs are the client's own.
type SharedPixel = { id: string; clients: number; sample: string[] };
async function sharedPixels(svc: ReturnType<typeof createServiceClient>): Promise<SharedPixel[]> {
  const { data } = await svc.from("onebox_clients").select("slug, extras").order("slug");
  const by = new Map<string, string[]>();
  for (const r of (data ?? []) as Array<{ slug: string; extras: Record<string, unknown> | null }>) {
    const id = String(r.extras?.metaPixelId ?? "").replace(/\D/g, "");
    if (id.length < 10) continue;
    by.set(id, [...(by.get(id) ?? []), r.slug]);
  }
  return [...by.entries()]
    .filter(([, slugs]) => slugs.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([id, slugs]) => ({ id, clients: slugs.length, sample: slugs.filter((s) => s !== "demo-v3").slice(0, 2) }));
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const u = await who();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data: row, error } = await svc.from("onboardings").select("setup, claim, form").eq("id", params.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message.includes("setup") ? `${error.message} — run supabase/new-client-setup.sql` : error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const setup = (row.setup as SetupState | null) ?? null;
  const cards = await liveCardStatuses(svc, setup);
  // The pool is only needed before Approve (and the Claim button's account wins).
  const claimLoc = (row.claim as { location_id?: string; original_name?: string } | null)?.location_id ?? null;
  const pool = setup || claimLoc ? null : await poolChoices(svc);
  // Same window: the pixel picker only shows before Approve.
  const pixels = setup ? [] : await sharedPixels(svc).catch(() => [] as SharedPixel[]);
  // Before Approve: what the Clients tab already knows (business hours, years
  // in business on the client's main contact) is filled in by itself — owner
  // 10/20/2026: "it has the data, don't make us type it again".
  const autofilled: string[] = [];
  if (!setup) {
    let form = (row.form ?? {}) as Record<string, string>;
    // Before Approve the Clients tab owns the version (owner 10/28/2026: a
    // card opened as V3 must follow the client when she is changed to V1).
    if (form.master_row) {
      const { data: cm } = await svc.from("clients_master").select("data").eq("sheet_row", Number(form.master_row)).maybeSingle();
      const d = ((cm as { data?: Record<string, unknown> } | null)?.data ?? {});
      const sameClient = !form.business_name || String(d["Business Name"] ?? "").trim().toLowerCase() === form.business_name.trim().toLowerCase();
      const v = sameClient ? normVersion(d["Version"]) : "";
      if (v && v !== form.version) {
        form = { ...form, version: v };
        await svc.from("onboardings").update({ form }).eq("id", params.id);
        autofilled.push("version");
      }
    }
    const missing = missingFields(form).map((f) => f.key);
    if (missing.includes("business_hours") || missing.includes("years_in_business")) {
      const extra = await answersFromMainContact(String(form.master_contact_id ?? ""), form).catch(() => ({}));
      const add = Object.fromEntries(Object.entries(extra).filter(([k]) => missing.includes(k)));
      if (Object.keys(add).length) {
        await svc.from("onboardings").update({ form: { ...form, ...add } }).eq("id", params.id);
        autofilled.push(...Object.keys(add));
      }
    }
  }
  return NextResponse.json({ setup: redact(setup), cards, pool, pixels, claimedLocation: claimLoc, canApprove: u.role === "admin" || u.role === "editor", autofilled });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const u = await who();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; poolLocationId?: string; key?: string; note?: string; preapproved?: string[] };
  const svc = createServiceClient();
  const admin = u.role === "admin";
  try {
    switch (String(body.action ?? "")) {
      case "approve": {
        // Client Success Coaches start their own clients' setups too (owner 10/28/2026).
        if (!(admin || u.role === "editor")) return NextResponse.json({ error: "Only an admin or a Client Success Coach can start a setup" }, { status: 403 });
        const setup = await approveSetup(svc, params.id, String(body.poolLocationId ?? ""), u.email, Array.isArray(body.preapproved) ? body.preapproved.map(String) : []);
        return NextResponse.json({ setup: redact(setup) });
      }
      case "refresh": {
        const setup = await advanceSetup(svc, params.id);
        return NextResponse.json({ setup: redact(setup) });
      }
      case "confirm": {
        if (!(admin || u.role === "editor")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        const setup = await confirmStep(svc, params.id, String(body.key ?? ""), u.email);
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
        // Coaches send the welcome message too (owner 10/30/2026).
        if (!(admin || u.role === "editor")) return NextResponse.json({ error: "Only an admin or a Client Success Coach can see the password" }, { status: 403 });
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
