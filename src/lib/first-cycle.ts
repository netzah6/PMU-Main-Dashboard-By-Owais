import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";
import { fileAlert } from "@/lib/alerts";

/* Moving a client to "First Cycle" in the agency pipeline fires the
   "Started stage -> Went live Notification" workflow, which texts the client
   her logins from three contact fields. Rosell Torres (10/27/2026) got
   "Email: / Password:" blank because her deal was dragged by hand in GHL with
   the fields empty — so the move now happens ONLY from the dashboard, after
   the fields are saved (owner rule, 2026-10-27). Shared by the setup run
   (step 34) and the Clients tab status change. */

export const MAIN_LOC = process.env.GHL_LOCATION_ID || "SfpNMJ5YU9lBkxss47lK";
const GHL = "https://services.leadconnectorhq.com";

export type LoginFields = { email: string; password: string; funnelUrl: string; businessName?: string };

export async function agencyHeaders(): Promise<{ H: Record<string, string> } | { error: string }> {
  const tok = await getAppLocationToken(MAIN_LOC);
  if (!tok.token) return { error: `agency token unavailable (${tok.error})` };
  return { H: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" } };
}

/* Writes CC - Login Email / Password / Funnel URL (+ company name) on the
   agency contact. Empty values are skipped — callers that need all three
   check first. Returns human notes. */
export async function saveLoginFieldsRaw(v: LoginFields, contactId: string, H: Record<string, string>): Promise<string[]> {
  const fieldNotes: string[] = [];
  const cfRes = (await fetch(`${GHL}/locations/${MAIN_LOC}/customFields?model=contact`, { headers: H }).then((r) => r.json())) as { customFields?: Array<{ id: string; name: string; fieldKey?: string }> };
  const fields = cfRes.customFields ?? [];
  const byKey = (k: string) => fields.find((f) => (f.fieldKey ?? "").toLowerCase() === k.toLowerCase());
  const ensure = async (name: string, key: string) => {
    const hit = byKey(key);
    if (hit) return hit.id;
    const r = await fetch(`${GHL}/locations/${MAIN_LOC}/customFields`, { method: "POST", headers: H, body: JSON.stringify({ name, dataType: "TEXT", model: "contact" }) });
    if (!r.ok) throw new Error(`could not create field "${name}": HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = (await r.json()) as { customField?: { id: string } };
    if (!j.customField?.id) throw new Error(`no id back for field "${name}"`);
    fieldNotes.push(`created contact field "${name}"`);
    return j.customField.id;
  };
  const values: Array<{ id: string; field_value: string }> = [];
  const pw = v.password.trim(), email = v.email.trim(), funnel = v.funnelUrl.trim();
  if (email) values.push({ id: await ensure("CC - Login Email", "contact.cc__login_email"), field_value: email });
  if (pw) values.push({ id: await ensure("CC - Login Password", "contact.cc__login_password"), field_value: pw });
  if (funnel) values.push({ id: await ensure("CC - Funnel URL", "contact.cc__funnel_url"), field_value: funnel });
  const body: Record<string, unknown> = { customFields: values };
  if (v.businessName) body.companyName = v.businessName;
  const r = await fetch(`${GHL}/contacts/${contactId}`, { method: "PUT", headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`contact update HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  fieldNotes.push(`login email${pw ? ", password" : " (no password on the run!)"}${funnel ? ", funnel URL" : " (no funnel URL!)"} saved on the agency contact → the Went-live workflow texts them`);
  return fieldNotes;
}

export type MoveResult =
  | { ok: true; already: boolean; deal: string; stage: string }
  | { ok: false; warn?: true; note: string };

/* Finds the client's deal in the agency pipeline and moves it to the stage
   named "First Cycle". warn = nothing moved, do it by hand. */
export async function moveDealToFirstCycle(contactId: string, H: Record<string, string>): Promise<MoveResult> {
  const pipes = (await fetch(`${GHL}/opportunities/pipelines?locationId=${MAIN_LOC}`, { headers: H }).then((r) => r.json()).catch(() => ({}))) as { pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> };
  let target: { pipelineId: string; stageId: string; stageName: string } | null = null;
  for (const p of pipes.pipelines ?? []) for (const s of p.stages ?? []) if (/first\s*cycle/i.test(s.name) && !target) target = { pipelineId: p.id, stageId: s.id, stageName: s.name };
  if (!target) return { ok: false, warn: true, note: "no pipeline stage named \"First Cycle\" in the agency account — move the deal by hand" };
  const opps = (await fetch(`${GHL}/opportunities/search?location_id=${MAIN_LOC}&contact_id=${contactId}&limit=20`, { headers: H }).then((r) => r.json()).catch(() => ({}))) as { opportunities?: Array<{ id: string; name?: string; pipelineId: string; pipelineStageId: string }> };
  const opp = (opps.opportunities ?? []).find((o) => o.pipelineId === target!.pipelineId) ?? (opps.opportunities ?? [])[0];
  if (!opp) return { ok: false, warn: true, note: "the client has no deal in the agency pipeline — move it to First Cycle by hand" };
  if (opp.pipelineStageId === target.stageId) return { ok: true, already: true, deal: opp.name ?? "", stage: target.stageName };
  const r = await fetch(`${GHL}/opportunities/${opp.id}`, { method: "PUT", headers: H, body: JSON.stringify({ pipelineId: target.pipelineId, pipelineStageId: target.stageId }) });
  if (!r.ok) return { ok: false, note: `could not move the deal: HTTP ${r.status} ${(await r.text()).slice(0, 150)}` };
  return { ok: true, already: false, deal: opp.name ?? "", stage: target.stageName };
}

/* Whatever the setup run and the funnels already know about this client. */
export async function knownLogins(svc: SupabaseClient, q: { contactId?: string; email?: string; business?: string }): Promise<{ email: string; password: string; funnelUrl: string; fromSetup: boolean }> {
  const { data } = await svc.from("onboardings").select("form, setup").order("created_at", { ascending: false }).limit(400);
  type Row = { form: Record<string, string>; setup: { password?: string; funnel_url?: string } | null };
  const rows = (data ?? []) as Row[];
  const email = (q.email ?? "").trim().toLowerCase();
  const hit = rows.find((r) => q.contactId && String(r.form?.master_contact_id ?? "") === q.contactId)
    ?? rows.find((r) => email && String(r.form?.email ?? "").trim().toLowerCase() === email);
  let funnelUrl = String(hit?.setup?.funnel_url ?? "");
  const business = (q.business ?? "").trim();
  if (!funnelUrl && business) {
    const { data: ob } = await svc.from("onebox_clients").select("slug, client_name").neq("slug", "demo-v3");
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
    const m = (ob ?? []).find((o) => norm(String(o.client_name ?? "")) === norm(business));
    if (m) funnelUrl = `https://book.pmu-care.com/f/${m.slug}`;
  }
  return { email: String(hit?.form?.email ?? email ?? ""), password: String(hit?.setup?.password ?? ""), funnelUrl, fromSetup: !!hit };
}

/* A deal landed in First Cycle, however it got there (Nancy Duarte, 11/04/2026:
   dragged by hand in GHL, so the welcome texts went out blank — same as Rosell
   Torres). The "Went live" workflow calls this first, waits, and texts only if
   all three fields are filled. Nothing here sends a text. Missing logins = no
   texts and an alert for the team. */
export async function prepareFirstCycle(svc: SupabaseClient, contactId: string): Promise<{ ok: boolean; skipped?: string; missing?: string[] }> {
  const a = await agencyHeaders();
  if ("error" in a) throw new Error(a.error);
  const H = a.H;
  // The route has no login, so it only acts on a deal really sitting in First Cycle.
  const pipes = (await fetch(`${GHL}/opportunities/pipelines?locationId=${MAIN_LOC}`, { headers: H }).then((r) => r.json())) as { pipelines?: Array<{ stages?: Array<{ id: string; name: string }> }> };
  const stageIds = new Set((pipes.pipelines ?? []).flatMap((p) => p.stages ?? []).filter((t) => /first\s*cycle/i.test(t.name)).map((t) => t.id));
  const opps = (await fetch(`${GHL}/opportunities/search?location_id=${MAIN_LOC}&contact_id=${encodeURIComponent(contactId)}&limit=20`, { headers: H }).then((r) => r.json())) as { opportunities?: Array<{ pipelineStageId?: string }> };
  if (!(opps.opportunities ?? []).some((o) => stageIds.has(String(o.pipelineStageId)))) return { ok: false, skipped: "no deal in First Cycle" };

  const cr = await fetch(`${GHL}/contacts/${encodeURIComponent(contactId)}`, { headers: H });
  if (!cr.ok) throw new Error(`contact read HTTP ${cr.status}`);
  const { contact } = (await cr.json()) as { contact: { email?: string; firstName?: string; lastName?: string; companyName?: string; customFields?: Array<{ id: string; value?: unknown }> } };
  const list = (await fetch(`${GHL}/locations/${MAIN_LOC}/customFields?model=contact`, { headers: H }).then((r) => r.json())) as { customFields?: Array<{ id: string; fieldKey?: string }> };
  const current = (key: string) => {
    const id = (list.customFields ?? []).find((f) => (f.fieldKey ?? "").toLowerCase() === key)?.id;
    return String((contact.customFields ?? []).find((f) => f.id === id)?.value ?? "").trim();
  };
  const have = { email: current("contact.cc__login_email"), password: current("contact.cc__login_password"), funnelUrl: current("contact.cc__funnel_url") };
  const run = await knownLogins(svc, { contactId, email: contact.email, business: contact.companyName });
  // The setup run is the newest truth (a returning client gets new logins).
  const want = {
    email: (run.fromSetup ? run.email : "").trim() || have.email || String(contact.email ?? "").trim(),
    password: run.password.trim() || have.password,
    funnelUrl: run.funnelUrl.trim() || have.funnelUrl,
  };
  if (want.email !== have.email || want.password !== have.password || want.funnelUrl !== have.funnelUrl) {
    await saveLoginFieldsRaw(want, contactId, H);
  }
  const missing = [!want.email && "login email", !want.password && "password", !want.funnelUrl && "funnel link"].filter(Boolean) as string[];
  if (missing.length) {
    const who = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.companyName || contactId;
    await fileAlert(svc, {
      type: "onboarding", severity: "high", source_key: `first_cycle_blank:${contactId}`, resurfaceAfterDays: 1,
      title: `${who} moved to First Cycle: welcome texts NOT sent`,
      detail: `The dashboard has no ${missing.join(", ")} for this client, so nothing went out. Fill the CC - Login fields on the agency contact, then move the deal out of First Cycle and back to send the texts.`,
    });
  }
  return { ok: missing.length === 0, missing };
}
