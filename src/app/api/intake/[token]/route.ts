import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { ONEBOX_EDITABLE_CVS, setOneboxCustomValues, refreshOneboxConfig } from "@/lib/onebox";
import { missingIntakeFields, clientIsV3, assignedCoach, INTAKE_FIELDS, missingPhotoAsks, PHOTO_ASKS, photoCount } from "@/lib/intake";
import { fileAlert } from "@/lib/alerts";

export const fetchCache = "force-no-store";

/* Public endpoints behind an unguessable per-client token
   (extras.intakeToken, minted from the Funnels tab). GET returns ONLY the
   fields still empty right now — a client with everything filled sees an
   all-done page, and a stale link can never overwrite an answer the team
   already has (POST re-checks emptiness at save time). */

async function findClient(token: string) {
  const svc = createServiceClient();
  if (!/^[a-f0-9]{32}$/.test(token)) return { svc, client: null };
  const { data } = await svc
    .from("onebox_clients")
    .select("slug, client_name, location_id, config, extras")
    .eq("extras->>intakeToken", token)
    .maybeSingle();
  return { svc, client: data };
}

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const { svc, client } = await findClient(params.token);
  if (!client) return NextResponse.json({ error: "Link not found" }, { status: 404 });
  const isV3 = await clientIsV3(svc, String(client.client_name));
  const missing = missingIntakeFields((client.config ?? {}) as Record<string, string>, isV3);
  const photos = missingPhotoAsks((client.config ?? {}) as Record<string, string>);
  return NextResponse.json({
    business: client.client_name,
    fields: [
      ...missing.map(({ k, label, hint, type }) => ({ k, label, hint, type })),
      ...photos.map((p) => ({ k: p.k, label: p.label, hint: p.hint, type: "photos" as const })),
    ],
  });
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const { svc, client } = await findClient(params.token);
  if (!client) return NextResponse.json({ error: "Link not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const cfg = (client.config ?? {}) as Record<string, string>;
  const isV3 = await clientIsV3(svc, String(client.client_name));
  const stillMissing = new Set(missingIntakeFields(cfg, isV3).map((f) => f.k));

  const entries: { name: string; value: string }[] = [];
  const answered: string[] = [];
  for (const f of INTAKE_FIELDS) {
    const v = typeof body[f.k] === "string" ? (body[f.k] as string).trim().slice(0, 2000) : "";
    if (!v || !stillMissing.has(f.k)) continue; // never overwrite existing values
    const cvName = ONEBOX_EDITABLE_CVS[f.k];
    if (!cvName) continue;
    entries.push({ name: cvName, value: v });
    answered.push(f.label);
  }
  /* Brows "had PMU before" prices default to the new-brows prices until the
     artist gives separate ones (owner, 2026-10-08). */
  for (const [hp, base] of [["originalPriceBrowsHadPmu", "originalPrice"], ["discountedPriceBrowsHadPmu", "discountedPrice"]] as const) {
    const hpName = ONEBOX_EDITABLE_CVS[hp];
    const baseVal = entries.find((e) => e.name === ONEBOX_EDITABLE_CVS[base])?.value ?? String(cfg[base] ?? "").trim();
    if (hpName && baseVal && stillMissing.has(hp) && !entries.some((e) => e.name === hpName)) entries.push({ name: hpName, value: baseVal });
  }
  /* Photo uploads: URLs from our own intake-uploads bucket only, appended
     to the dashboard-managed photo lists, capped so a prankster with the
     link can't flood the funnel. */
  const bucketPrefix = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/intake-uploads/`;
  for (const p of PHOTO_ASKS) {
    if (photoCount(cfg, p.countKeys) >= p.min) continue;
    const urls = Array.isArray(body[p.k]) ? (body[p.k] as unknown[]).filter((u): u is string => typeof u === "string" && u.startsWith(bucketPrefix)).slice(0, 6) : [];
    if (!urls.length) continue;
    const existing = String(cfg[p.cv] ?? "").split(",").map((u) => u.trim()).filter(Boolean);
    const cvName = ONEBOX_EDITABLE_CVS[p.cv];
    if (!cvName) continue;
    entries.push({ name: cvName, value: [...existing, ...urls].slice(0, 9).join(",") });
    answered.push(p.label);
  }
  if (!entries.length) return NextResponse.json({ ok: true, saved: 0 });

  const res = await setOneboxCustomValues(client.location_id as string, entries);
  if (res.error) return NextResponse.json({ error: "could not save — try again" }, { status: 502 });
  const justWritten = Object.fromEntries(entries.filter((e) => res.written.includes(e.name)).map((e) => [e.name, e.value]));
  await refreshOneboxConfig(svc, client.slug as string, client.location_id as string, justWritten).catch(() => null);

  // Tell the team: an Alerts-tab card for the owner + a Notifications row
  // for the assigned Client Success Coach.
  const coach = await assignedCoach(svc, String(client.client_name)).catch(() => null);
  await fileAlert(svc, {
    type: "onboarding",
    severity: "medium",
    title: `${client.client_name} filled in their missing info`,
    detail: `Submitted through their info-request link: ${answered.join(", ")}. The funnel updated automatically — nothing to copy by hand.`,
    source_key: `intake:${client.slug}:${new Date().toISOString().slice(0, 10)}`,
    meta: { slug: client.slug, fields: answered, coach },
  }).catch(() => false);
  await svc.from("notifications").insert({
    type: "intake",
    title: `${client.client_name} completed their info form`,
    body: `Filled in: ${answered.join(", ")}`,
    coach,
    meta: { slug: client.slug, fields: answered },
  });

  return NextResponse.json({ ok: true, saved: entries.length, failed: entries.length - res.written.length });
}
