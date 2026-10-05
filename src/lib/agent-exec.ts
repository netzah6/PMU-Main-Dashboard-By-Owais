import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppAgencyToken, getAppLocationToken } from "@/lib/ghl-app";
import { getReplyAccount } from "@/lib/ghl-conversations";
import { isProtectedLocation } from "@/lib/ghl-cleanup";

// ── CEO Agent, phase 2: actually DO the approved account change ─────────────
// A proposal carries a typed `action_plan` (written by the classifier at scan
// time, or derived from the free-text action_detail at approve time for older
// cards). Approve runs the steps against the CLIENT's sub-account through the
// GHL API, reads the setting back, and stores a before → after line per step
// as the proof the owner asked for. Anything the API cannot reach (pipeline
// stages, workflows, funnel pages) becomes a `manual` step, which parks the
// card as "needs a teammate" instead of pretending.
//
// Guard rails: never the agency's own locations, never anything the plan does
// not spell out, and the owner has clicked Approve before any of this runs.

const GHL = "https://services.leadconnectorhq.com";
const V_LOC = "2021-07-28";
const V_CAL = "2021-04-15";
const MODEL = "claude-sonnet-4-5";
const AGENCY_LOCATION_ID = process.env.GHL_LOCATION_ID || "SfpNMJ5YU9lBkxss47lK";

type Svc = SupabaseClient;

export type PlanStep =
  | { type: "custom_value_set"; name: string; value: string }
  | { type: "calendar_block_dates"; dates: string[]; calendar?: string; reason?: string }
  | { type: "calendar_hours_set"; calendar?: string; hours: Array<{ days: number[]; open: string; close: string }> }
  | { type: "location_address_set"; address1?: string; city?: string; state?: string; postalCode?: string }
  | { type: "manual"; what: string }
  /* Square one-time payment links (owner, 2026-10-05: "generate links from
     the Square account as a one-time payment"). Created on Approve and
     texted in the reply — the client pays when they choose; nothing is
     charged. bill_* is what the Financing sheet says they owe, for the card. */
  | { type: "payment_links"; label: string; amounts_cents: number[];
      bill_cents?: number | null; bill_label?: string | null; bill_owner?: string | null; bill_status?: string | null;
      links?: Array<{ amount_cents: number; url: string; id: string }> };

export type StepResult = { step: PlanStep; ok: boolean; manual?: boolean; before?: string; after?: string; note: string };

// Shared with the classifier prompt so both places describe the same steps.
export const PLAN_SCHEMA_TEXT = `"action_plan": an array of typed steps that a program can run against the client's GoHighLevel sub-account. Use ONLY these shapes:
  {"type":"custom_value_set","name":"<exact or close custom-value name, e.g. 'CC - Offer', 'CC - Original Price', 'CC - Studio Address', 'CC - Directions'>","value":"<new value>"}
  {"type":"calendar_block_dates","dates":["YYYY-MM-DD", ...],"calendar":"<calendar name if the client named one, else omit>","reason":"<short>"}
  {"type":"calendar_hours_set","calendar":"<name or omit>","hours":[{"days":[1,2,3],"open":"09:00","close":"17:00"}]}   (days: 0=Sunday … 6=Saturday; list every day that should be OPEN — days left out become closed)
  {"type":"location_address_set","address1":"...","city":"...","state":"...","postalCode":"..."}   (only the fields that change)
  {"type":"manual","what":"<what a teammate must do by hand — pipeline stages, workflows, funnel pages, ads, anything not covered above>"}
  {"type":"payment_links","label":"<what it pays for, e.g. 'October service fee'>","amounts_cents":[10000,15000,15000]}   (Square one-time payment links texted to the client — use when they ask to pay, ask for a payment link, or ask to split a payment into parts)
Rules for payment_links: use EXACTLY the amounts the client asked for, in their order (cents). If they ask to split without giving amounts, split their bill evenly into the number of parts they asked for (the last part takes any odd cents). If they just ask for a link, one link for their bill. Never invent a bill you weren't given — if no amount is known, use a "manual" step instead.
Rules for action_plan: be literal — never invent values the client did not give; if a value is unknown (e.g. which year for "Oct 8th"), pick the next occurrence from today; if the request needs something the shapes above cannot express, use one "manual" step. When action_type is "reply" the only step allowed is payment_links (else an empty array).`;

// ── Payment links: limits and the reply lines ────────────────────────────────
export const PAY_LINK_MAX = 6;
export const PAY_LINK_MIN_CENTS = 100;        // $1
export const PAY_LINK_MAX_CENTS = 1_000_000;  // $10,000 per link
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const payLinkPlaceholder = (i: number) => `{{pay_link_${i + 1}}}`;
/* The lines under the reply — one per link, built from the final amounts
   at send time ("{{pay_link_N}}" where a URL isn't known yet). */
export function paymentLinkLines(step: Extract<PlanStep, { type: "payment_links" }>, urls?: string[]): string {
  const n = step.amounts_cents.length;
  return step.amounts_cents.map((c, i) => `${n > 1 ? `Payment ${i + 1} of ${n} — ` : ""}${usd(c)}: ${urls?.[i] ?? payLinkPlaceholder(i)}`).join("\n");
}
/* The message, minus any stray "{{pay_link_N}}" line, with the link lines
   under it. */
export function withPaymentLinks(reply: string, step: Extract<PlanStep, { type: "payment_links" }>, urls?: string[]): string {
  const kept = reply.split("\n").filter((l) => !/\{\{pay_link_\d+\}\}/.test(l)).join("\n").trimEnd();
  return `${kept}${kept ? "\n" : ""}${paymentLinkLines(step, urls)}`;
}
export const describeAmounts = (cents: number[]) => cents.map(usd).join(" · ");

// ── Where does this client live? ─────────────────────────────────────────────
// The proposal knows the contact who texted the MAIN account; the change has
// to land in that client's OWN sub-account. Clients Master maps the contact
// (by Contact ID, else by owner name) to an owner, and the ingest tables map
// the owner to a location.
export async function resolveClientLocation(
  svc: Svc,
  contactId: string | null,
  contactName: string,
): Promise<{ locationId: string; ownerName: string; businessName: string } | null> {
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  const { data: cm } = await svc.from("clients_master").select("data");
  const rows = (cm ?? []).map((r) => r.data as Record<string, unknown>);
  let row =
    (contactId && rows.find((d) => String(d["Contact ID"] ?? "").trim() === contactId)) ||
    rows.find((d) => norm(d["Owner Full Name"]) === norm(contactName)) ||
    null;
  if (!row) {
    // Loose: every token of the shorter name inside the longer one ("Tammy
    // Woolley" texted, the sheet says "Tamara Woolley" — last name wins).
    const toks = norm(contactName).split(" ").filter((t) => t.length >= 3);
    row = rows.find((d) => {
      const ot = norm(d["Owner Full Name"]).split(" ").filter((t) => t.length >= 3);
      const [small, big] = toks.length <= ot.length ? [toks, ot] : [ot, toks];
      return small.length >= 1 && big.length >= 1 && small.some((t) => big.includes(t)) && (small.length === 1 || small.filter((t) => big.includes(t)).length >= 2);
    }) ?? null;
    // A single shared token (a first name) is too weak on its own; the loop
    // above accepts it only when it is the whole short name, and we still
    // require a last-name match below.
    if (row) {
      const last = norm(contactName).split(" ").pop() ?? "";
      if (!norm(row["Owner Full Name"]).split(" ").includes(last)) row = null;
    }
  }
  if (!row) return null;
  const ownerName = String(row["Owner Full Name"] ?? "").trim();
  const businessName = String(row["Business Name"] ?? "").trim();

  const { data: conv } = await svc
    .from("ghl_conversations")
    .select("location_id, synced_at")
    .eq("owner_key", ownerName.toLowerCase())
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let locationId = (conv as { location_id?: string } | null)?.location_id ?? "";
  if (!locationId && businessName) {
    const { data: ob } = await svc
      .from("onebox_clients")
      .select("location_id, client_name")
      .ilike("client_name", businessName)
      .limit(1)
      .maybeSingle();
    locationId = (ob as { location_id?: string } | null)?.location_id ?? "";
  }
  if (!locationId) return null;
  return { locationId, ownerName, businessName };
}

// ── Plan from free text (older cards filed before plans existed) ─────────────
export async function planFromDetail(input: { summary: string; actionDetail: string | null; clientMessage: string }): Promise<PlanStep[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [{ type: "manual", what: input.actionDetail || input.summary }];
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `Turn this client request for a PMU marketing agency into a machine-runnable plan.

Client message: """${input.clientMessage}"""
Summary: ${input.summary}
Teammate notes: ${input.actionDetail ?? "(none)"}
Today: ${new Date().toISOString().slice(0, 10)}

Reply with ONLY a JSON object: {${PLAN_SCHEMA_TEXT}}`;
  const res = await anthropic.messages.create({ model: MODEL, max_tokens: 600, messages: [{ role: "user", content: prompt }] });
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [{ type: "manual", what: input.actionDetail || input.summary }];
  try {
    const j = JSON.parse(m[0]) as { action_plan?: unknown };
    const plan = sanitizePlan(j.action_plan);
    return plan.length ? plan : [{ type: "manual", what: input.actionDetail || input.summary }];
  } catch {
    return [{ type: "manual", what: input.actionDetail || input.summary }];
  }
}

// Keep only well-formed steps — the model's JSON is data, not code.
export function sanitizePlan(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStep[] = [];
  for (const s of raw as Array<Record<string, unknown>>) {
    if (!s || typeof s !== "object") continue;
    const t = String(s.type ?? "");
    if (t === "custom_value_set" && s.name && s.value !== undefined) out.push({ type: t, name: String(s.name), value: String(s.value) });
    else if (t === "calendar_block_dates" && Array.isArray(s.dates)) {
      const dates = (s.dates as unknown[]).map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
      if (dates.length) out.push({ type: t, dates, calendar: s.calendar ? String(s.calendar) : undefined, reason: s.reason ? String(s.reason) : undefined });
    } else if (t === "calendar_hours_set" && Array.isArray(s.hours)) {
      const hours = (s.hours as Array<Record<string, unknown>>)
        .filter((h) => h && Array.isArray(h.days) && /^\d{1,2}:\d{2}$/.test(String(h.open)) && /^\d{1,2}:\d{2}$/.test(String(h.close)))
        .map((h) => ({ days: (h.days as unknown[]).map(Number).filter((d) => d >= 0 && d <= 6), open: String(h.open), close: String(h.close) }));
      if (hours.length) out.push({ type: t, calendar: s.calendar ? String(s.calendar) : undefined, hours });
    } else if (t === "location_address_set") {
      const step: PlanStep = { type: t };
      for (const k of ["address1", "city", "state", "postalCode"] as const) if (s[k]) step[k] = String(s[k]);
      if (Object.keys(step).length > 1) out.push(step);
    } else if (t === "manual") out.push({ type: t, what: String(s.what ?? s.reason ?? "see the request") });
    else if (t === "payment_links" && Array.isArray(s.amounts_cents)) {
      const amounts = (s.amounts_cents as unknown[]).map(Number);
      // All or nothing: a bad amount drops the step rather than silently changing the split.
      if (!amounts.length || amounts.length > PAY_LINK_MAX || amounts.some((c) => !Number.isInteger(c) || c < PAY_LINK_MIN_CENTS || c > PAY_LINK_MAX_CENTS)) continue;
      if (out.some((x) => x.type === "payment_links")) continue; // one set of links per card
      out.push({
        type: t, amounts_cents: amounts,
        label: String(s.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "Payment",
        bill_cents: Number.isInteger(Number(s.bill_cents)) && Number(s.bill_cents) > 0 ? Number(s.bill_cents) : null,
        bill_label: s.bill_label ? String(s.bill_label).slice(0, 60) : null,
        bill_owner: s.bill_owner ? String(s.bill_owner).slice(0, 80) : null,
        bill_status: s.bill_status ? String(s.bill_status).slice(0, 40) : null,
        ...(Array.isArray(s.links) ? { links: (s.links as Array<Record<string, unknown>>).filter((l) => l && typeof l.url === "string").map((l) => ({ amount_cents: Number(l.amount_cents), url: String(l.url), id: String(l.id ?? "") })) } : {}),
      });
    }
  }
  return out;
}

// ── Human-readable one-liner per step, for the card and the SMS ──────────────
export function describeStep(s: PlanStep): string {
  switch (s.type) {
    case "custom_value_set": return `Set "${s.name}" to "${s.value}"`;
    case "calendar_block_dates": return `Block ${s.dates.join(", ")}${s.calendar ? ` on "${s.calendar}"` : ""}`;
    case "calendar_hours_set": {
      const D = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      return `Hours${s.calendar ? ` on "${s.calendar}"` : ""}: ` + s.hours.map((h) => `${h.days.map((d) => D[d]).join("/")} ${h.open}–${h.close}`).join(", ");
    }
    case "location_address_set": return `Address → ${[s.address1, s.city, s.state, s.postalCode].filter(Boolean).join(", ")}`;
    case "manual": return `Needs a teammate: ${s.what}`;
    case "payment_links": {
      const total = s.amounts_cents.reduce((a, b) => a + b, 0);
      return `Create ${s.amounts_cents.length === 1 ? "a Square payment link" : `${s.amounts_cents.length} Square payment links`} (${describeAmounts(s.amounts_cents)}${s.amounts_cents.length > 1 ? ` = ${usd(total)}` : ""}) for "${s.label}" and add ${s.amounts_cents.length === 1 ? "it" : "them"} to the reply`;
    }
  }
}

// ── Execution ────────────────────────────────────────────────────────────────
async function protectedLocations(): Promise<Set<string>> {
  const set = new Set<string>([AGENCY_LOCATION_ID]);
  try { const main = await getReplyAccount(); if (main?.locationId) set.add(main.locationId); } catch { /* still refuse the agency id */ }
  return set;
}

function locHeaders(token: string, version: string) {
  return { Authorization: `Bearer ${token}`, Version: version, Accept: "application/json", "Content-Type": "application/json" };
}

type CustomValue = { id: string; name: string; value?: string };
async function listCustomValues(locationId: string, token: string): Promise<CustomValue[]> {
  const r = await fetch(`${GHL}/locations/${locationId}/customValues`, { headers: locHeaders(token, V_LOC) });
  if (!r.ok) throw new Error(`customValues HTTP ${r.status}`);
  const j = (await r.json()) as { customValues?: CustomValue[] };
  return j.customValues ?? [];
}

type Calendar = { id: string; name: string; openHours?: unknown };
async function listCalendars(locationId: string, token: string): Promise<Calendar[]> {
  const r = await fetch(`${GHL}/calendars/?locationId=${locationId}`, { headers: locHeaders(token, V_CAL) });
  if (!r.ok) throw new Error(`calendars HTTP ${r.status}`);
  const j = (await r.json()) as { calendars?: Calendar[] };
  return j.calendars ?? [];
}
async function getCalendar(id: string, token: string): Promise<Calendar | null> {
  const r = await fetch(`${GHL}/calendars/${id}`, { headers: locHeaders(token, V_CAL) });
  if (!r.ok) return null;
  const j = (await r.json()) as { calendar?: Calendar };
  return j.calendar ?? null;
}
// The client's booking calendar: the one they named, else the single
// calendar, else the one whose name says booking/appointment/consult.
function pickCalendar(cals: Calendar[], wanted?: string): Calendar | null {
  if (!cals.length) return null;
  if (wanted) {
    const w = wanted.toLowerCase();
    const hit = cals.find((c) => c.name.toLowerCase() === w) ?? cals.find((c) => c.name.toLowerCase().includes(w));
    if (hit) return hit;
  }
  if (cals.length === 1) return cals[0];
  return cals.find((c) => /book|appoint|consult|session/i.test(c.name)) ?? null;
}

type Location = { name?: string; address?: string; city?: string; state?: string; postalCode?: string; timezone?: string };
async function getLocation(locationId: string, token: string): Promise<Location> {
  const r = await fetch(`${GHL}/locations/${locationId}`, { headers: locHeaders(token, V_LOC) });
  if (!r.ok) throw new Error(`location HTTP ${r.status}`);
  const j = (await r.json()) as { location?: Location };
  return j.location ?? {};
}

// "2026-10-08" + "00:00:00" in the studio's timezone → ISO with the right offset.
function isoInTz(date: string, time: string, tz: string): string {
  const guess = new Date(`${date}T${time}Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(guess);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  const offsetMin = Math.round((asUtc - guess.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${date}T${time}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function fmtHours(openHours: unknown): string {
  if (!Array.isArray(openHours) || !openHours.length) return "(none set)";
  const D = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (openHours as Array<{ daysOfTheWeek?: number[]; hours?: Array<{ openHour: number; openMinute: number; closeHour: number; closeMinute: number }> }>)
    .map((o) => `${(o.daysOfTheWeek ?? []).map((d) => D[d] ?? d).join("/")} ${(o.hours ?? []).map((h) => `${String(h.openHour).padStart(2, "0")}:${String(h.openMinute).padStart(2, "0")}–${String(h.closeHour).padStart(2, "0")}:${String(h.closeMinute).padStart(2, "0")}`).join("+")}`)
    .join(", ");
}

export async function executePlan(
  plan: PlanStep[],
  locationId: string,
): Promise<{ steps: StepResult[]; allOk: boolean; anyManual: boolean }> {
  const steps: StepResult[] = [];
  if (isProtectedLocation(locationId) || (await protectedLocations()).has(locationId)) {
    return { steps: plan.map((step) => ({ step, ok: false, note: "refused: this is the agency's own account" })), allOk: false, anyManual: false };
  }
  const tok = await getAppLocationToken(locationId);
  if (!tok.token) {
    return { steps: plan.map((step) => ({ step, ok: false, note: `no GHL token for this sub-account: ${tok.error}` })), allOk: false, anyManual: false };
  }
  const token = tok.token;

  for (const step of plan) {
    try {
      // Payment links run in executeProposal (before the reply goes out), not here.
      if (step.type === "payment_links") continue;
      if (step.type === "manual") {
        steps.push({ step, ok: true, manual: true, note: step.what });
        continue;
      }
      if (step.type === "custom_value_set") {
        const cvs = await listCustomValues(locationId, token);
        const w = step.name.toLowerCase();
        const cv = cvs.find((c) => c.name.toLowerCase() === w) ?? cvs.find((c) => c.name.toLowerCase().includes(w) || w.includes(c.name.toLowerCase()));
        if (!cv) { steps.push({ step, ok: false, note: `no custom value named "${step.name}" in this account` }); continue; }
        const before = cv.value ?? "";
        const r = await fetch(`${GHL}/locations/${locationId}/customValues/${cv.id}`, {
          method: "PUT", headers: locHeaders(token, V_LOC), body: JSON.stringify({ name: cv.name, value: step.value }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
        const after = (await listCustomValues(locationId, token)).find((c) => c.id === cv.id)?.value ?? "";
        steps.push({ step, ok: after === step.value, before, after, note: after === step.value ? `"${cv.name}" updated` : `"${cv.name}" did not take the new value` });
        continue;
      }
      if (step.type === "calendar_block_dates") {
        const cal = pickCalendar(await listCalendars(locationId, token), step.calendar);
        if (!cal) { steps.push({ step, ok: false, note: "could not tell which calendar — several exist and none was named" }); continue; }
        const tz = (await getLocation(locationId, token)).timezone || "America/Los_Angeles";
        const made: string[] = [];
        for (const d of step.dates) {
          const r = await fetch(`${GHL}/calendars/events/block-slots`, {
            method: "POST", headers: locHeaders(token, V_CAL),
            body: JSON.stringify({ calendarId: cal.id, locationId, startTime: isoInTz(d, "00:00:00", tz), endTime: isoInTz(d, "23:59:00", tz), title: step.reason ? `Blocked — ${step.reason}` : "Blocked (client request)" }),
          });
          if (!r.ok) throw new Error(`block ${d}: HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
          made.push(d);
        }
        steps.push({ step, ok: true, before: "open", after: `blocked: ${made.join(", ")}`, note: `${made.length} day${made.length === 1 ? "" : "s"} blocked on "${cal.name}" (${tz})` });
        continue;
      }
      if (step.type === "calendar_hours_set") {
        const cal = pickCalendar(await listCalendars(locationId, token), step.calendar);
        if (!cal) { steps.push({ step, ok: false, note: "could not tell which calendar — several exist and none was named" }); continue; }
        const full = await getCalendar(cal.id, token);
        const before = fmtHours(full?.openHours);
        const openHours = step.hours.map((h) => {
          const [oh, om] = h.open.split(":").map(Number);
          const [ch, cm] = h.close.split(":").map(Number);
          return { daysOfTheWeek: h.days, hours: [{ openHour: oh, openMinute: om, closeHour: ch, closeMinute: cm }] };
        });
        const r = await fetch(`${GHL}/calendars/${cal.id}`, { method: "PUT", headers: locHeaders(token, V_CAL), body: JSON.stringify({ openHours }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
        const after = fmtHours((await getCalendar(cal.id, token))?.openHours);
        steps.push({ step, ok: true, before, after, note: `hours updated on "${cal.name}"` });
        continue;
      }
      if (step.type === "location_address_set") {
        const agency = await getAppAgencyToken();
        if (!agency) { steps.push({ step, ok: false, note: "agency token unavailable" }); continue; }
        const beforeLoc = await getLocation(locationId, token);
        const before = [beforeLoc.address, beforeLoc.city, beforeLoc.state, beforeLoc.postalCode].filter(Boolean).join(", ");
        const body: Record<string, string> = { companyId: agency.companyId };
        if (step.address1) body.address = step.address1;
        if (step.city) body.city = step.city;
        if (step.state) body.state = step.state;
        if (step.postalCode) body.postalCode = step.postalCode;
        const r = await fetch(`${GHL}/locations/${locationId}`, { method: "PUT", headers: locHeaders(agency.token, V_LOC), body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
        const afterLoc = await getLocation(locationId, token);
        const after = [afterLoc.address, afterLoc.city, afterLoc.state, afterLoc.postalCode].filter(Boolean).join(", ");
        steps.push({ step, ok: true, before, after, note: "business address updated" });
        continue;
      }
    } catch (e) {
      steps.push({ step, ok: false, note: e instanceof Error ? e.message.slice(0, 200) : "error" });
    }
  }
  const anyManual = steps.some((s) => s.manual);
  const allOk = steps.every((s) => s.ok);
  return { steps, allOk, anyManual };
}

// One line per step for the card's proof block and the `result` column.
export function formatResults(steps: StepResult[]): string {
  return steps.map((s) => {
    const icon = s.manual ? "👤" : s.ok ? "✓" : "✗";
    const change = s.before !== undefined || s.after !== undefined ? ` [${s.before ?? "?"} → ${s.after ?? "?"}]` : "";
    return `${icon} ${describeStep(s.step)} — ${s.note}${change}`;
  }).join("\n");
}
