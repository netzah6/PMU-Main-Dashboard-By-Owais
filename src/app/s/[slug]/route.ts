import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

// Split-test entry point: /s/<slug>. The ad URL points here (via the
// client's existing GHL redirect), we assign the visitor to a variant
// once — sticky by cookie, so a refresh never flips them — and then
// either serve our funnel or bounce them to the variant's own URL (the
// client's original GHL funnel, for the first test).
//
// With no running experiment this is just the funnel, so it is always
// safe for the redirect to point here.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const COOKIE = "ob_v";
const YEAR = 60 * 60 * 24 * 365;

type Variant = {
  vkey: string;
  label: string;
  kind: string;
  target: string | null;
  weight: number;
};

function pick(variants: Variant[]): Variant {
  const total = variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
  if (total <= 0) return variants[0];
  let n = Math.random() * total;
  for (const v of variants) {
    n -= Math.max(0, v.weight);
    if (n <= 0) return v;
  }
  return variants[variants.length - 1];
}

function visitorId(req: NextRequest, slug: string): { id: string; vkey: string | null } {
  const raw = req.cookies.get(`${COOKIE}_${slug}`)?.value ?? "";
  const [id, vkey] = raw.split(":");
  if (id) return { id, vkey: vkey || null };
  return { id: crypto.randomUUID(), vkey: null };
}

export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const { slug } = params;
  const svc = createServiceClient();

  const { data: exp } = await svc
    .from("onebox_experiments")
    .select("id, status")
    .eq("slug", slug)
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const search = req.nextUrl.search ?? "";
  const funnelUrl = `${req.nextUrl.origin}/f/${slug}${search}`;

  // No live test: behave exactly like the plain funnel URL.
  if (!exp) return NextResponse.redirect(funnelUrl, 307);

  const { data: variantRows } = await svc
    .from("onebox_variants")
    .select("vkey, label, kind, target, weight")
    .eq("experiment_id", exp.id)
    .order("vkey", { ascending: true });
  const variants = (variantRows ?? []) as Variant[];
  if (!variants.length) return NextResponse.redirect(funnelUrl, 307);

  // A returning visitor keeps their variant; a forced ?ob_v=a wins (for
  // the team to preview a side without waiting on the coin flip).
  const forced = req.nextUrl.searchParams.get("ob_v");
  const seen = visitorId(req, slug);
  let chosen =
    (forced && variants.find((v) => v.vkey === forced)) ||
    (seen.vkey && variants.find((v) => v.vkey === seen.vkey)) ||
    null;
  const isNew = !chosen;
  if (!chosen) chosen = pick(variants);

  if (isNew) {
    await svc
      .from("onebox_assignments")
      .upsert(
        { experiment_id: exp.id, vkey: chosen.vkey, visitor_id: seen.id },
        { onConflict: "experiment_id,visitor_id", ignoreDuplicates: true }
      )
      .then(() => {});
  }

  // External variant (e.g. the client's original GHL funnel) — hand the
  // visitor over, query string intact so ad tracking survives.
  let dest: string;
  if (chosen.kind === "external" && chosen.target) {
    const t = chosen.target;
    dest = search ? t + (t.includes("?") ? "&" : "?") + search.slice(1) : t;
  } else {
    const sep = search ? "&" : "?";
    dest = `${funnelUrl}${sep}ob_e=${exp.id}&ob_v=${encodeURIComponent(chosen.vkey)}`;
  }

  const res = NextResponse.redirect(dest, 307);
  res.cookies.set(`${COOKIE}_${slug}`, `${seen.id}:${chosen.vkey}`, {
    maxAge: YEAR,
    path: "/",
    sameSite: "lax",
  });
  return res;
}
