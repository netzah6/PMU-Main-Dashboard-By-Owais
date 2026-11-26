import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { defaultFields, renderAgreement, validateFields } from "@/lib/esign";
import { loadTemplate, newToken, contentHash, cleanText, EMAIL_RE, clientIp, rateLimited, noStoreHeaders } from "@/lib/esign-server";

export const dynamic = "force-dynamic";

/* Public "start signing" for the Pay Per Appointment onboarding (owner,
   11/26/2026). Step 2 of the onboarding funnel links here instead of the old
   Go High Level document (which still said $65 + $50 and $300-600/month).
   The client types name + email; we give them a signing link with the
   standard PPA numbers ($80 fee + $50 deposit, $20/day ad spend).
   If sales already made an unsigned PPA link for this email (maybe with
   other numbers), that link is used instead — sales numbers always win.
   The client never chooses numbers. */

const PROGRAMS = new Set(["ppa"]);
const ONBOARDING_CREATOR = "onboarding:ppa";

export async function POST(req: NextRequest) {
  const ip = clientIp(req) || "unknown";
  if (rateLimited(`start:${ip}`, 6, 10 * 60_000)) {
    return NextResponse.json({ error: "Too many tries. Please wait a few minutes." }, { status: 429, headers: noStoreHeaders() });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const program = String(body.program ?? "");
  if (!PROGRAMS.has(program)) return NextResponse.json({ error: "Unknown program" }, { status: 400, headers: noStoreHeaders() });
  const name = cleanText(body.name, 120);
  const email = cleanText(body.email, 200).toLowerCase();
  if (name.length < 2) return NextResponse.json({ error: "Please type your full name" }, { status: 400, headers: noStoreHeaders() });
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Please type a valid email" }, { status: 400, headers: noStoreHeaders() });

  const svc = createServiceClient();

  // 1) An unsigned PPA link already made for this email in the last 30 days
  //    (by sales, or by an earlier visit to this page) → reuse it.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: open } = await svc.from("agreement_signatures")
    .select("token, created_by, created_at")
    .eq("template", "ppa").ilike("partner_email", email).in("status", ["sent", "viewed"])
    .gte("created_at", since).order("created_at", { ascending: false }).limit(5);
  const rows = (open ?? []) as Array<{ token: string; created_by: string | null }>;
  const pick = rows.find((r) => r.created_by !== ONBOARDING_CREATOR) ?? rows[0];
  if (pick) return NextResponse.json({ token: pick.token }, { headers: noStoreHeaders() });

  // 2) A safety cap so a bot can't fill the table.
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await svc.from("agreement_signatures").select("id", { count: "exact", head: true })
    .eq("created_by", ONBOARDING_CREATOR).gte("created_at", dayAgo);
  if ((count ?? 0) >= 150) return NextResponse.json({ error: "Please contact your coach to get your Scope of Service." }, { status: 429, headers: noStoreHeaders() });

  // 3) New link with the standard PPA numbers.
  const { values, errors } = validateFields("ppa", defaultFields("ppa"));
  if (Object.keys(errors).length) return NextResponse.json({ error: "Setup problem. Please contact your coach." }, { status: 500, headers: noStoreHeaders() });
  const { template } = await loadTemplate(svc, "ppa");
  const content = renderAgreement(template, "ppa", values);
  const token = newToken();
  const { error } = await svc.from("agreement_signatures").insert({
    token, template: "ppa", fields: values, content, content_sha256: contentHash(content),
    partner_name: name, partner_email: email, partner_phone: null,
    created_by: ONBOARDING_CREATOR, status: "sent",
  });
  if (error) return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500, headers: noStoreHeaders() });
  return NextResponse.json({ token }, { headers: noStoreHeaders() });
}
