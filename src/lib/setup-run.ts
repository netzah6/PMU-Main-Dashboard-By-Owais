import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";
import {
  claimPoolAccount, fillAccountValues, fillCalendarId, syncScheduleTimezones, setLocationProfile, discoverPool, POOL_NAME_RE, setExistingCustomValue, listLocationCustomValues,
  employeePassword, findLocationUserByEmail, setUserPassword, slugify, type ClaimResult, type ClaimAction,
} from "@/lib/ghl-claim";
import { deleteAllContacts, inspectLocation, poolBlocker, poolReadiness, refreshPoolCleanliness, type PoolReadiness, type PoolRow } from "@/lib/ghl-cleanup";
import { createDepositProductFromForm } from "@/lib/deposit-product";
import { addOneboxFunnel, FUNNEL_ORIGIN } from "@/lib/onebox-add";
import { harvestFirstPixel, refreshOneboxConfig, setDepositFunnelUrl, setOneboxCustomValues } from "@/lib/onebox";
import { refreshFunnel, usernameFromLink } from "@/lib/ig-fetch";
import { refreshReviews } from "@/lib/g-reviews";
import { buildReplayPayload, isValidHookUrlForLocation, replayToClientHook } from "@/lib/payment-router";
import { verifyOnboarding } from "@/lib/onboarding-verify";
import { answersFromMainContact } from "@/lib/survey-answers";
import { queueSnapshotLoad, snapshotConvId } from "@/lib/pool-snapshot";
import { writeRowToSheet, getSheetEntryForTable } from "@/lib/sheets";
import { confirmToOwner, dashboardUrl, proposalLink, textOwner } from "@/lib/agent-notify";
import {
  RUNBOOK, runSteps, stepByKey, stepState, isSettled, miniPlan, miniContext, batchPlan, missingFields, NO_PIXEL_RE,
  type RunbookStep, type SetupState, type StepState, type SetupFacts,
} from "@/lib/setup-runbook";

/* ── New Client Setup run ───────────────────────────────────────────────────
   Owner-approved 10/15/2026. The Onboarding card holds the whole run in
   onboardings.setup (see supabase/new-client-setup.sql):

     Clients tab → "Set up account" → the card → Approve (clean account
     shown first) → the dashboard runs the API steps right away and queues
     the browser steps to the AI Agent ONE AT A TIME, in runbook order
     (each step depends on the one before: no A2P check before the number
     exists, no calendar hours before the user exists). "Asks you" steps are
     pending cards in the AI tab — the owner approves, the Mini does it.

   Hard rules (owner): nothing touches GHL before Approve; custom values are
   filled, never created (a missing one is flagged red); the agent never
   texts clients; errors show per step, never a silent skip. Dates in the
   notes are US format. */

type Svc = SupabaseClient;
type Ob = { id: string; form: Record<string, string>; checklist: Record<string, unknown>; claim: ClaimResult & { claimed_at?: string; claimed_by?: string } | null; setup: SetupState | null };

const now = () => new Date().toISOString();
const usDate = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" });
const DASHBOARD = "Dashboard";
const MAIN_LOC = process.env.GHL_LOCATION_ID || "SfpNMJ5YU9lBkxss47lK";
const GHL = "https://services.leadconnectorhq.com";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const SETUP_PREFIX = "setup:";
export const setupConvId = (onboardingId: string, key: string) => `${SETUP_PREFIX}${onboardingId}:${key}`;
export function parseSetupConvId(conversationId: string | null | undefined): { onboardingId: string; key: string } | null {
  if (!conversationId?.startsWith(SETUP_PREFIX)) return null;
  const [, onboardingId, key] = conversationId.split(":");
  return onboardingId && key ? { onboardingId, key } : null;
}

// ── Load / save ─────────────────────────────────────────────────────────────
async function loadOb(svc: Svc, id: string): Promise<Ob> {
  const { data, error } = await svc.from("onboardings").select("id, form, checklist, claim, setup").eq("id", id).single();
  if (error || !data) throw new Error(error?.message ?? "onboarding not found");
  const row = data as unknown as Ob;
  return { ...row, form: (row.form ?? {}) as Record<string, string>, checklist: (row.checklist ?? {}) as Record<string, unknown> };
}

/* Read-merge-write: the approve request and a Mac Mini finish can land at
   the same moment, so every write re-reads the row and changes only what
   it means to change. */
async function patch(svc: Svc, id: string, fn: (ob: Ob) => Partial<Pick<Ob, "setup" | "checklist" | "form" | "claim">> | void): Promise<Ob> {
  const ob = await loadOb(svc, id);
  const upd = fn(ob);
  if (upd && Object.keys(upd).length) {
    const { error } = await svc.from("onboardings").update(upd).eq("id", id);
    if (error) throw new Error(error.message);
    Object.assign(ob, upd);
  }
  return ob;
}

function setStep(setup: SetupState, key: string, st: Partial<StepState> & { status: StepState["status"] }, log?: string): void {
  const prev = setup.steps[key] ?? { status: "todo" };
  setup.steps[key] = { ...prev, ...st, at: st.at ?? now() };
  if (log) setup.log.push({ at: now(), key, msg: log.slice(0, 400) });
  if (setup.log.length > 300) setup.log = setup.log.slice(-300);
}

function tick(checklist: Record<string, unknown>, keys: string[] | undefined, by: string): void {
  for (const k of keys ?? []) checklist[k] = { done: true, by, at: now() };
}

// ── The clean account to take ───────────────────────────────────────────────
export type PoolChoice = { id: string; name: string; readiness: PoolReadiness; blocker: string | null; snapshot: boolean };

/* Every location still named "Clean New Account N" in GHL, with what the
   pool table knows about it. The default is the lowest-numbered READY one
   (empty + A2P approved — lib/pool-readiness).
   Without a GHL agency token (local dev) the table alone is used. */
export async function poolChoices(svc: Svc): Promise<{ choices: PoolChoice[]; defaultId: string | null; note?: string }> {
  const { data } = await svc.from("pool_accounts").select("*").eq("status", "available");
  const rows = (data ?? []) as PoolRow[];
  const byId = new Map(rows.map((r) => [r.location_id, r]));
  let live: Array<{ id: string; name: string }> | null = null;
  let note: string | undefined;
  try { live = await discoverPool(); } catch (e) { note = `GHL pool list unavailable (${errMsg(e)}) — showing the dashboard's pool table`; }
  const src = live ?? rows.map((r) => ({ id: r.location_id, name: r.pool_name }));
  // Owner 10/20/2026: only A2P-approved accounts are offered — a setup on an
  // unverified account can't text. The rest stay in the pool list, not here.
  let hidden = 0;
  const choices: PoolChoice[] = src
    .filter((l) => POOL_NAME_RE.test(l.name))
    .filter((l) => { const ok = byId.get(l.id)?.a2p === "approved"; if (!ok) hidden++; return ok; })
    .map((l) => {
      const r = byId.get(l.id);
      const readiness = r ? poolReadiness(r) : "unknown";
      const blocker = r ? poolBlocker(r) : "not checked yet";
      return { id: l.id, name: l.name, readiness, blocker, snapshot: !!r?.snapshot_loaded_at };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const ready = choices.filter((c) => c.readiness === "ready");
  if (hidden) note = [note, `${hidden} more not A2P-approved (hidden)`].filter(Boolean).join(" · ");
  return { choices, defaultId: (ready[0] ?? choices[0])?.id ?? null, note };
}

// ── Approve ─────────────────────────────────────────────────────────────────
export async function approveSetup(svc: Svc, onboardingId: string, poolLocationId: string, by: string, preapproved: string[] = []): Promise<SetupState> {
  const ob = await loadOb(svc, onboardingId);
  if (ob.setup) throw new Error("This setup was already approved");
  // Pre-flight: nothing starts with a hole in the form (owner 10/20/2026).
  const missing = missingFields(ob.form);
  if (missing.length) throw new Error(`Fill these first: ${missing.map((m) => m.label).join(", ")}`);

  let poolName = "";
  if (ob.claim?.location_id) {
    // The old Claim button already took an account — the run continues on it.
    poolLocationId = ob.claim.location_id;
    poolName = ob.claim.original_name;
  } else {
    const { choices } = await poolChoices(svc);
    const pick = choices.find((c) => c.id === poolLocationId);
    if (!pick) throw new Error("That clean account is not available anymore — pick another one");
    // No snapshot yet is not a stop (owner 10/21/2026): step 0 cleans the
    // account and queues the snapshot load to the AI Agent, then the run goes on.
    poolName = pick.name;
  }

  const setup: SetupState = {
    v: 1, approved_by: by, approved_at: now(), location_id: poolLocationId, pool_name: poolName,
    status: "running", steps: {}, log: [{ at: now(), key: "run", msg: `Approved by ${by} — taking ${poolName}${preapproved.length ? ` · pre-approved: ${preapproved.join(", ")}` : ""}` }],
    preapproved: preapproved.filter((k) => stepByKey(k)?.who === "ask"),
  };
  // Team / client / owner steps are shown, not run.
  for (const s of RUNBOOK) if (!["api", "mini", "ask"].includes(s.who) || s.later) setup.steps[s.key] = { status: "manual" };
  // An "asks you" step left unticked at Approve is skipped, not asked again
  // mid-run (owner 10/21/2026: "if not, just move on — no stops").
  for (const s of RUNBOOK) if (s.who === "ask" && !(setup.preapproved ?? []).includes(s.key)) setup.steps[s.key] = { status: "skipped", who: by, at: now(), note: "not ticked at Approve — skipped (tick it next time to have the AI Agent do it)" };
  if (ob.claim) {
    for (const k of ["account_check", "account_take", "account_info", "account_cvs", "cal_id"]) setup.steps[k] = { status: "done", who: ob.claim.claimed_by ?? "Claim button", at: ob.claim.claimed_at ?? now(), note: `done earlier by the Claim button (${ob.claim.original_name} → ${ob.claim.business_name})` };
    const pid = String(ob.form.product_id ?? "").trim();
    if (pid) { setup.steps.product = { status: "done", who: "Claim button", at: now(), note: `product ID ${pid} already on the form` }; setup.product_id = pid; }
  }
  // A skipped step is settled — its checklist item counts, so a finished
  // run reads 100% (owner 10/25: Sudbury Med Spa stuck at 97% on the IG widget).
  const checklist = { ...ob.checklist };
  for (const s of RUNBOOK) if (setup.steps[s.key]?.status === "skipped") tick(checklist, s.checklist, by);
  const { error } = await svc.from("onboardings").update({ setup, checklist }).eq("id", onboardingId);
  if (error) throw new Error(error.message.includes("setup") ? `${error.message} — run supabase/new-client-setup.sql first` : error.message);
  return advanceSetup(svc, onboardingId);
}

// ── The engine ──────────────────────────────────────────────────────────────
/* Run every API step whose prerequisites are met, then make sure the next
   browser step has its card. Safe to call again at any time (Approve, a
   AI Agent finish, the card's Refresh). */
export async function advanceSetup(svc: Svc, onboardingId: string): Promise<SetupState> {
  // Lock: one API-step runner at a time (a stale lock from a dead run expires).
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const locked = await patch(svc, onboardingId, (ob) => {
    if (!ob.setup) return;
    const busy = ob.setup.busy_at && Date.now() - Date.parse(ob.setup.busy_at) < 4 * 60_000;
    if (busy) return;
    return { setup: { ...ob.setup, busy_at: now(), busy_token: token } };
  });
  if (!locked.setup) throw new Error("not approved yet");
  if (locked.setup.busy_token !== token) return locked.setup; // someone else is running the steps
  try {
    // An API step left "running" for 6+ minutes is a run that died (Vercel
    // timeout, deploy): show it red with Retry instead of hanging forever.
    await patch(svc, onboardingId, (ob) => {
      if (!ob.setup) return;
      let touched = false;
      for (const s of runSteps()) {
        const st = stepState(ob.setup, s.key);
        if (s.who === "api" && st.status === "running" && st.at && Date.now() - Date.parse(st.at) > 6 * 60_000) {
          setStep(ob.setup, s.key, { status: "failed", error: "the run stopped in the middle of this step", note: "the run stopped in the middle of this step (timeout) — check the account, then Retry" }, `${s.n}. timed out`);
          touched = true;
        }
      }
      return touched ? { setup: ob.setup } : undefined;
    });
    for (;;) {
      const ob = await loadOb(svc, onboardingId);
      const next = runSteps().find((s) => s.who === "api" && stepState(ob.setup, s.key).status === "todo" && prereqsMet(ob, s));
      if (!next) break;
      await runApiStep(svc, ob, next);
    }
    await ensureMiniCard(svc, onboardingId);
    await settle(svc, onboardingId);
  } finally {
    await patch(svc, onboardingId, (ob) => (ob.setup && ob.setup.busy_token === token ? { setup: { ...ob.setup, busy_at: null, busy_token: null } } : undefined));
  }
  return (await loadOb(svc, onboardingId)).setup!;
}

const done = (ob: Ob, key: string) => isSettled(stepState(ob.setup, key));

function prereqsMet(ob: Ob, s: RunbookStep): boolean {
  switch (s.key) {
    case "account_check": case "master_row": return true;
    case "account_take": return done(ob, "account_check");
    case "account_info": case "account_cvs": case "cal_id": return done(ob, "account_take");
    case "cal_active": return done(ob, "cal_rules");
    case "connector": case "product": case "funnel_create": return done(ob, "account_take");
    case "funnel_pixel": case "funnel_ig": case "funnel_reviews": return done(ob, "funnel_create");
    case "route_test": return done(ob, "webhook_url") && done(ob, "product") && !!ob.setup?.hook_url;
    case "user_password": return done(ob, "user_create");
    // Go-live comes BEFORE the funnel test now (owner 10/20/2026: the test is
    // the AI Agent's last step); the redirect decision (done / not needed) first.
    case "funnel_live": return done(ob, "funnel_create") && done(ob, "funnel_redirect");
    case "last_check": return done(ob, "funnel_live") && done(ob, "last_profile");
    // Runs only after a person clicked Approve on the card (confirm step).
    case "first_cycle": return done(ob, "funnel_test") && !!stepState(ob.setup, "first_cycle").confirmed_by;
    default: return false;
  }
}

async function runApiStep(svc: Svc, ob: Ob, step: RunbookStep): Promise<void> {
  await patch(svc, ob.id, (o) => { if (!o.setup) return; setStep(o.setup, step.key, { status: "running", who: DASHBOARD }); return { setup: o.setup }; });
  let out: StepOut;
  try {
    out = await API_STEPS[step.key](svc, ob);
  } catch (e) {
    out = { status: "failed", note: errMsg(e) };
  }
  await patch(svc, ob.id, (o) => {
    if (!o.setup) return;
    setStep(o.setup, step.key, { status: out.status, who: DASHBOARD, note: out.note, proposal_id: out.proposal_id, error: out.status === "failed" ? out.note : undefined }, `${step.n}. ${step.label} → ${out.status}`);
    Object.assign(o.setup, out.facts ?? {});
    const checklist = { ...o.checklist };
    if (out.status === "done" || out.status === "warn") tick(checklist, step.checklist, DASHBOARD);
    return { setup: o.setup, checklist, ...(out.form ? { form: { ...o.form, ...out.form } } : {}), ...(out.claim ? { claim: out.claim } : {}) };
  });
  if (["account_cvs", "cal_id", "product", "funnel_create"].includes(step.key)) await refreshCard(svc, ob.id);
}

/* Pre-live check (V3 one-box): the "CC -" values the AI and the funnel read
   must be filled in the sub-account itself — the live source, not the form. */
const PRE_LIVE_VALUES: Array<{ label: string; match: (n: string) => boolean; v3Only?: boolean }> = [
  { label: "Business name", match: (n) => n === "ccbusinessname" || n === "businessname" },
  { label: "Owner name", match: (n) => n.includes("ownersname") || n.includes("ownername") },
  { label: "Business phone", match: (n) => n.includes("businessphone") },
  { label: "Business address", match: (n) => n.includes("address") && !n.includes("url") && !n.includes("link") },
  { label: "PMU services", match: (n) => n.includes("permanentmakeupservices") || n.includes("pmuservices") },
  { label: "Offer", match: (n) => n === "ccoffer" || (n.endsWith("offer") && !n.includes("url")) },
  { label: "Deposit amount", match: (n) => n.includes("depositamount") },
  // Prices are the V3 one-box's fields only (owner 10/21/2026: V2.3 has none).
  { label: "Original price (new brows)", v3Only: true, match: (n) => n.includes("originalprice") && (n.includes("newbrows") || n.includes("forbrows")) },
  { label: "Discounted price (new brows)", v3Only: true, match: (n) => n.includes("discountedprice") && (n.includes("newbrows") || n.includes("forbrows")) },
  { label: "Commas product ID", match: (n) => n.includes("fanbasisproductid") },
  { label: "Payment webhook URL", match: (n) => n.includes("fanbasiswebhookurl") },
  { label: "Calendar ID", match: (n) => n.includes("transformationcalendarid") },
];

/* The snapshot's booking calendar arrives INACTIVE (Sudbury Med Spa, 10/21/2026:
   GHL free-slots answered "Calendar is inactive", the funnel's time picker
   showed "Couldn't load available times" and the funnel test failed). Switch it
   on and prove slots load before the funnel goes live. */
async function ensureCalendarActive(locationId: string): Promise<{ ok: boolean; note: string }> {
  const cvs = await listLocationCustomValues(locationId);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const calendarId = String(cvs.find((c) => /calendarid/.test(norm(c.name)) && /transformation|permanentmakeup|booking/.test(norm(c.name)))?.value ?? "").trim();
  if (!calendarId) return { ok: false, note: "calendar: no calendar ID custom value yet" };
  const lt = await getAppLocationToken(locationId);
  if (!lt.token) return { ok: false, note: `calendar: ${lt.error ?? "could not mint location token"}` };
  const H = { Authorization: `Bearer ${lt.token}`, Version: "2021-04-15", Accept: "application/json", "Content-Type": "application/json" };
  const read = async () => {
    const r = await fetch(`${GHL}/calendars/${calendarId}`, { headers: H });
    if (!r.ok) throw new Error(`calendar read HTTP ${r.status}`);
    return ((await r.json()) as { calendar?: { name?: string; isActive?: boolean } }).calendar ?? {};
  };
  let cal = await read();
  let flipped = false;
  if (cal.isActive === false) {
    const r = await fetch(`${GHL}/calendars/${calendarId}`, { method: "PUT", headers: H, body: JSON.stringify({ isActive: true }) });
    if (!r.ok) return { ok: false, note: `calendar "${cal.name ?? calendarId}" is INACTIVE and could not be switched on (HTTP ${r.status}) — open GHL → Calendars and toggle it Active` };
    cal = await read();
    flipped = true;
    if (cal.isActive === false) return { ok: false, note: `calendar "${cal.name ?? calendarId}" is still INACTIVE after switching it on — open GHL → Calendars and toggle it Active` };
  }
  // Prove the funnel's time picker will work: the same free-slots call it makes.
  const start = Date.now(), end = start + 14 * 86400_000;
  const fr = await fetch(`${GHL}/calendars/${calendarId}/free-slots?startDate=${start}&endDate=${end}`, { headers: H });
  if (!fr.ok) return { ok: false, note: `calendar "${cal.name ?? calendarId}": free slots HTTP ${fr.status} — ${(await fr.text()).slice(0, 120)}` };
  const j = (await fr.json()) as Record<string, { slots?: string[] }>;
  const n = Object.values(j).reduce((a, v) => a + (Array.isArray(v?.slots) ? v.slots.length : 0), 0);
  return { ok: n > 0, note: `calendar "${cal.name ?? calendarId}" ${flipped ? "was INACTIVE → switched on" : "active"} · ${n} open slots in the next 14 days${n ? "" : " — check the staff hours (step 22)"}` };
}

/* Owner 10/21/2026: the final check FIXES the client-facing contact values
   instead of flagging them — phone as "(978) 996-9082", address as
   "street, city, ST zip" with the usual abbreviations and no periods. Both
   go to the custom values the funnel renders (and the address to the
   business profile). Returns one line per value it changed. */
const STATE_ABBR: Record<string, string> = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC" };
const STREET_ABBR: Record<string, string> = { street: "St", avenue: "Ave", boulevard: "Blvd", drive: "Dr", road: "Rd", lane: "Ln", court: "Ct", place: "Pl", terrace: "Ter", highway: "Hwy", parkway: "Pkwy", circle: "Cir", trail: "Trl", suite: "Ste", north: "N", south: "S", east: "E", west: "W", northeast: "NE", northwest: "NW", southeast: "SE", southwest: "SW" };
export function cleanAddress(raw: string): string | null {
  const words = raw.replace(/\b(united states( of america)?|usa|u\.s\.a?\.?)\s*$/i, "").replace(/[.]/g, "").replace(/\s+/g, " ").trim();
  const zipM = [...words.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].pop();
  if (!zipM || zipM.index === undefined) return null;
  const zip = zipM[0];
  let head = (words.slice(0, zipM.index) + words.slice(zipM.index + zip.length)).replace(/\s*,\s*/g, ",").replace(/,+/g, ",").replace(/^,|,$/g, "").trim();
  // State: a 2-letter code or the full name, right before the zip (or last part).
  let state = "";
  const parts = head.split(",").map((x) => x.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0 && !state; i--) {
    const pt = parts[i].toLowerCase();
    if (STATE_ABBR[pt]) { state = STATE_ABBR[pt]; parts.splice(i, 1); }
    else if (/^[a-z]{2}$/.test(pt) && Object.values(STATE_ABBR).includes(pt.toUpperCase())) { state = pt.toUpperCase(); parts.splice(i, 1); }
    else { const m = parts[i].match(/^(.*\S)\s+([A-Za-z]{2})$/); if (m && Object.values(STATE_ABBR).includes(m[2].toUpperCase())) { state = m[2].toUpperCase(); parts[i] = m[1]; } }
  }
  if (!state || parts.length < 2) return null;
  const city = parts.pop()!;
  const cap = (w: string) => (/^\d/.test(w) || /^[A-Z]{1,2}$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  const street = parts.join(" ").split(" ").map((w) => STREET_ABBR[w.toLowerCase()] ?? cap(w)).join(" ");
  head = `${street}, ${city.split(" ").map(cap).join(" ")}, ${state} ${zip}`;
  return head;
}
const fmtPhone10 = (p: string) => { const d = p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null; };
async function tidyContactValues(locationId: string): Promise<ClaimAction[]> {
  const out: ClaimAction[] = [];
  const cvs = await listLocationCustomValues(locationId);
  const phoneCv = cvs.find((c) => /business phone number/i.test(c.name));
  const addrCv = cvs.find((c) => /full business address/i.test(c.name));
  const phone = String(phoneCv?.value ?? "").trim();
  const want = phone ? fmtPhone10(phone) : null;
  if (phoneCv && want && want !== phone) {
    await setExistingCustomValue(locationId, phoneCv.name, want);
    out.push({ action: "Phone format", ok: true, detail: `"${phone}" → "${want}"` });
  }
  const addr = String(addrCv?.value ?? "").trim();
  const clean = addr ? cleanAddress(addr) : null;
  if (addrCv && clean && clean !== addr) {
    await setExistingCustomValue(locationId, addrCv.name, clean);
    const prof = await setLocationProfile(locationId, { address: clean, phone: want ?? phone }).catch((e) => ({ action: "Business profile", ok: false, detail: errMsg(e) } as ClaimAction));
    out.push({ action: "Address format", ok: true, detail: `"${addr}" → "${clean}"${prof.ok ? " (custom value + business profile)" : ` (custom value; profile: ${prof.detail})`}` });
  }
  return out;
}

async function preLiveGaps(locationId: string, version: string): Promise<string[]> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const cvs = await listLocationCustomValues(locationId);
  const isV3 = /v3/i.test(version);
  return PRE_LIVE_VALUES.filter((r) => !r.v3Only || isV3).filter((r) => {
    const hits = cvs.filter((c) => r.match(norm(c.name)));
    return !hits.some((c) => String(c.value ?? "").trim()); // missing or empty
  }).map((r) => r.label);
}

type StepOut = { status: StepState["status"]; note: string; facts?: Partial<SetupState>; form?: Record<string, string>; claim?: Ob["claim"]; proposal_id?: string };
type StepFn = (svc: Svc, ob: Ob) => Promise<StepOut>;

const lines = (acts: ClaimAction[]) => acts.map((a) => `${a.ok ? "✓" : "✗"} ${a.action}${a.detail ? ` — ${a.detail}` : ""}`).join("\n");

const API_STEPS: Record<string, StepFn> = {
  /* 0 · Check, clean, load (owner 10/20 + 10/25/2026). A pool account is
     EMPTY + A2P verified; the snapshot keeps changing, so the latest one is
     loaded here, when the account is taken — never ahead of time. The
     account is inspected LIVE: leftover contacts are deleted, anything else
     on it (an old template, funnels…) stops the run, A2P must be approved,
     then the AI Agent loads the snapshot and this step resumes when its
     card closes. */
  account_check: async (svc, ob) => {
    const loc = ob.setup!.location_id;
    let [row] = await refreshPoolCleanliness([loc]);
    if (!row) throw new Error("this account is not in the clean-account pool");
    const notes: string[] = [];
    // This run's own snapshot load (a card created after the setup was approved).
    const since = ob.setup!.approved_at ?? new Date(0).toISOString();
    const { data: loads } = await svc.from("agent_proposals").select("id, status")
      .eq("conversation_id", snapshotConvId(loc)).gte("created_at", since);
    const runLoads = (loads ?? []) as Array<{ id: string; status: string }>;
    const loadedThisRun = runLoads.some((l) => l.status === "done");
    const insp = await inspectLocation(loc);
    if (insp.counts.contacts > 0) {
      const lt = await getAppLocationToken(loc);
      if (!lt.token) throw new Error(lt.error ?? "could not mint location token");
      const r = await deleteAllContacts(loc, lt.token);
      notes.push(`deleted ${r.deleted} of ${r.found} leftover contacts${r.failed ? ` (${r.failed} failed: ${r.error ?? ""})` : ""}`);
      [row] = await refreshPoolCleanliness([loc]);
    }
    if (row.a2p !== "approved") return { status: "failed", note: [...notes, "A2P not confirmed — press Verify A2P in the clean-account pool, then Retry"].join("\n") };
    const fresh = await inspectLocation(loc);
    if (fresh.counts.contacts > 0) return { status: "failed", note: [...notes, `${fresh.counts.contacts} contacts could not be deleted — clean them in GHL, then Retry`].join("\n") };
    if ((row.dirty ?? 0) > 0) {
      // Template on the account: fine only if THIS run loaded it, complete.
      if (loadedThisRun && fresh.snapshot.present) return { status: "done", note: [...notes, `✓ latest snapshot loaded by the AI Agent · A2P approved`].join("\n") };
      if (runLoads.length >= 2) return { status: "failed", note: [...notes, `✗ the AI Agent loaded the snapshot ${runLoads.length}× and the account still shows only part of it (${fresh.snapshot.missing.join(", ")}) — check the account in GHL, then Retry`].join("\n") };
      // A half-loaded template from an older load (Brows by Angie 10/25: 7 of
      // 18 automations, 9 of ~45 values from July) is not "dirty" — the
      // snapshot is loaded again on top of it, like Susan's.
      if (runLoads.length || (!fresh.snapshot.present && fresh.counts.conversations === 0)) {
        const q = await queueSnapshotLoad(svc, { locationId: loc, poolName: ob.setup!.pool_name, by: `${ob.setup!.approved_by} (setup run)`, reason: `is being taken for ${ob.form.business_name} and the last load left only part of the snapshot (${fresh.snapshot.missing.join(", ")})` });
        return { status: "queued", proposal_id: q.taskId, note: [...notes, `⏳ only part of the snapshot arrived — the AI Agent is loading it again${q.reused ? " (already queued)" : ""}`].join("\n") };
      }
      return { status: "failed", note: [...notes, `✗ not a clean account — ${row.clean_note ?? "it still has data"}. A clean account must be empty (no template, calendars, automations, funnels). Pick another account or wipe this one, then Retry`].join("\n") };
    }
    // Empty + A2P → load the latest snapshot now.
    const q = await queueSnapshotLoad(svc, { locationId: loc, poolName: ob.setup!.pool_name, by: `${ob.setup!.approved_by} (setup run)`, reason: `is being taken for ${ob.form.business_name} (empty clean account — loading the latest snapshot)` });
    return { status: "queued", proposal_id: q.taskId, note: [...notes, `✓ empty · A2P approved`, `⏳ the AI Agent is loading the latest snapshot${q.reused ? " (already queued)" : ""}; the setup continues by itself when it is done`].join("\n") };
  },
  /* 1 + 2 · Take the pool account: rename it and set email/phone. The
     employee user is NOT created here (step 14 asks the owner first), and the
     custom values are steps 3 and 24 — their own steps so a Retry re-fills
     them once the template is in (Sally Nails And Spa, 10/16/2026). */
  account_take: async (svc, ob) => {
    const setup = ob.setup!;
    const result = await claimPoolAccount(setup.location_id, ob.form, { skipUser: true, skipValues: true });
    const claim = { ...result, claimed_at: now(), claimed_by: `${setup.approved_by} (setup run)` };
    await patch(svc, ob.id, (o) => {
      if (!o.setup) return;
      const prof = result.actions.find((a) => a.action.startsWith("Business profile"));
      setStep(o.setup, "account_info", { status: prof && !prof.ok ? "warn" : "done", who: DASHBOARD, note: `name${ob.form.email ? ", email" : ""}${ob.form.phone ? ", phone" : ""} set on the sub-account${prof ? `\n${prof.ok ? "✓" : "⚠"} ${prof.action}` : ""}` });
      const checklist = { ...o.checklist };
      tick(checklist, stepByKey("account_info")?.checklist, DASHBOARD);
      return { setup: o.setup, checklist };
    });
    return { status: "done", note: `Renamed "${result.original_name}" → "${result.business_name}"`, claim };
  },
  /* 2 · Retry: re-apply the Business Profile address + time zone. */
  account_info: async (_svc, ob) => {
    const a = await setLocationProfile(ob.setup!.location_id, ob.form);
    return { status: a.ok ? "done" : "warn", note: `${a.ok ? "✓" : "⚠"} ${a.action}${a.detail && a.detail !== a.action ? ` — ${a.detail}` : ""}` };
  },

  /* 3 · "CC -" custom values from the client's record (the card's form,
     pre-filled from the Clients tab). Fills existing values only; an account
     with none means the template isn't loaded yet → red, Retry after it is.
     The values it overwrote are kept on the claim so Un-claim restores them. */
  account_cvs: async (_svc, ob) => {
    const have = await listLocationCustomValues(ob.setup!.location_id);
    if (!have.length) return { status: "failed", note: "the account has no custom values — the template (snapshot) is not loaded yet. Load it, then Retry" };
    const extra = await answersFromMainContact(String(ob.form.master_contact_id ?? ""), ob.form);
    const form = { ...ob.form, ...extra };
    const acts = await fillAccountValues(ob.setup!.location_id, form, { depositUrl: ob.setup!.slug ? `${FUNNEL_ORIGIN}/${ob.setup!.slug}` : null });
    const missing = acts.filter((a) => !a.ok);
    const claim = ob.claim ? { ...ob.claim, actions: [...ob.claim.actions, ...acts.filter((a) => a.ok)] } : undefined;
    return missing.length
      ? { status: "warn", note: `${acts.length - missing.length} of ${acts.length} filled. 🔴 MISSING — the team creates these by hand in GHL, then Retry:\n${lines(missing)}`, claim, form: extra }
      : { status: "done", note: `${acts.length} custom values filled from the client's record`, claim, form: extra };
  },

  /* 24 · Transformation calendar ID → its custom value. */
  /* 24 · The snapshot's calendar arrives switched off (owner 10/21/2026): turn
     it on here, in section F, and prove GHL returns open slots. */
  cal_active: async (_svc, ob) => {
    const cal = await ensureCalendarActive(ob.setup!.location_id);
    return { status: cal.ok ? "done" : "failed", note: `${cal.ok ? "✓" : "✗"} ${cal.note}` };
  },

  cal_id: async (_svc, ob) => {
    const acts = await fillCalendarId(ob.setup!.location_id);
    const a = acts[0];
    const claim = ob.claim && a?.ok ? { ...ob.claim, actions: [...ob.claim.actions, a] } : undefined;
    if (!a) return { status: "failed", note: "could not read the account's calendars" };
    return { status: a.ok ? "done" : "failed", note: `${a.action}${a.detail ? ` — ${a.detail}` : ""}`, claim };
  },

  /* 4 · Clients Master row: Version / Assigned / Media Buyer from the form,
     status "Onboarding" unless the row already says Live/Paused/Offboarded.
     Field-scoped write (onlyColumns) — nothing else on the row is touched. */
  master_row: async (svc, ob) => {
    const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const { data: cm } = await svc.from("clients_master").select("sheet_row, data");
    const rows = (cm ?? []) as Array<{ sheet_row: number; data: Record<string, unknown> }>;
    const wantRow = Number(ob.form.master_row ?? 0);
    const row = (wantRow ? rows.find((r) => Number(r.sheet_row) === wantRow) : undefined)
      ?? rows.find((r) => norm(r.data["Owner Full Name"]) === norm(ob.form.owner_name) && (!norm(r.data["Business Name"]) || norm(r.data["Business Name"]) === norm(ob.form.business_name)))
      ?? rows.find((r) => norm(r.data["Business Name"]) === norm(ob.form.business_name));
    if (!row) return { status: "warn", note: `No Clients Master row found for ${ob.form.owner_name} / ${ob.form.business_name} — add the client to the sheet and press Retry` };
    const cur = String(row.data.col_1 ?? "").trim();
    const keepStatus = /^(live|paused|offboarded)$/i.test(cur);
    const values: Record<string, unknown> = {};
    if (!keepStatus) values.col_1 = "Onboarding";
    if (String(ob.form.version ?? "").trim()) values.Version = ob.form.version.trim();
    if (String(ob.form.assigned ?? "").trim()) values.Assigned = ob.form.assigned.trim();
    if (String(ob.form.media_buyer ?? "").trim()) values["Media Buyer"] = ob.form.media_buyer.trim();
    const cols = Object.keys(values);
    if (!cols.length) return { status: "done", note: `row ${row.sheet_row}: nothing to change (status "${cur}")` };
    const merged = { ...row.data, ...values, row_number: row.sheet_row };
    const { error } = await svc.from("clients_master").update({ data: merged, synced_at: now() }).eq("sheet_row", row.sheet_row);
    if (error) throw new Error(`dashboard copy: ${error.message}`);
    const entry = getSheetEntryForTable("clients_master");
    if (!entry) throw new Error("Clients Master sheet mapping missing");
    await writeRowToSheet(entry.spreadsheetId, entry.sheetName, row.sheet_row, merged, entry.fallbackIndex, cols);
    return { status: "done", note: `row ${row.sheet_row}: ${cols.map((c) => `${c === "col_1" ? "Status" : c} = ${String(values[c])}`).join(", ")}`, form: { master_row: String(row.sheet_row), master_contact_id: String(row.data["Contact ID"] ?? ob.form.master_contact_id ?? "") } };
  },

  /* 5 · Connector: can the dashboard mint a token for this account? Pool
     accounts have the marketplace app pre-installed; if not, the install link. */
  connector: async (_svc, ob) => {
    const tok = await getAppLocationToken(ob.setup!.location_id);
    if (tok.token) return { status: "done", note: "connector token OK — leads, chats and deposits will sync" };
    return { status: "failed", note: `no connector token (${tok.error}). Install the dashboard app on the account: ${dashboardUrl()}/api/oauth/start — then Retry` };
  },

  /* 6 · Commas deposit product → card + "CC - Fanbasis Product ID". */
  product: async (_svc, ob) => {
    const existing = String(ob.form.product_id ?? "").trim();
    if (existing) {
      // Already created (an earlier run): just make sure the custom value has it.
      try { await setExistingCustomValue(ob.setup!.location_id, "CC - Fanbasis Product ID", existing); }
      catch (e) { return { status: "warn", note: `product ID ${existing} already on the form\n✗ custom value not set: ${errMsg(e)}`, facts: { product_id: existing } }; }
      return { status: "done", note: `product ID ${existing} already on the form → custom value "CC - Fanbasis Product ID"`, facts: { product_id: existing } };
    }
    const fb = await createDepositProductFromForm(ob.form);
    if (!fb.action.ok) return { status: "failed", note: fb.action.detail ?? "Commas failed" };
    const notes = [fb.action.action];
    if (fb.productId) {
      try { await setExistingCustomValue(ob.setup!.location_id, "CC - Fanbasis Product ID", fb.productId); notes.push(`→ custom value "CC - Fanbasis Product ID"`); }
      catch (e) { return { status: "warn", note: `${notes[0]}\n✗ custom value not set: ${errMsg(e)}`, facts: { product_id: fb.productId, checkout_url: fb.checkoutUrl }, form: { product_id: fb.productId } }; }
    }
    return { status: fb.productId ? "done" : "warn", note: notes.join("\n") + (fb.productId ? "" : "\n⚠ Commas returned no product ID"), facts: { product_id: fb.productId, checkout_url: fb.checkoutUrl }, form: fb.productId ? { product_id: fb.productId } : undefined };
  },

  /* 8 · One synthetic payment through the account's own inbound webhook
     (the same test the Funnels tab runs). The test contact and sheet row
     are cleaned by the funnel's test step / the team. */
  route_test: async (_svc, ob) => {
    const setup = ob.setup!;
    const hook = String(setup.hook_url ?? "");
    if (!isValidHookUrlForLocation(hook, setup.location_id)) return { status: "failed", note: `the saved webhook URL does not belong to this account: ${hook || "(empty)"}` };
    const payload = buildReplayPayload({
      email: "router.test.pmu@example.com", name: "Router Test", fanbasis_payment_id: `SETUP-TEST-${Date.now()}`,
      fanbasis_product: setup.product_id || "router-test", fanbasis_total_price: "1",
    });
    const sent = await replayToClientHook(hook, payload);
    if (!sent.ok) return { status: "failed", note: `test payment not accepted: ${sent.note}` };
    return { status: "done", note: `test payment accepted by the route (${sent.note}). The AI Agent deletes the "Router Test" contact in the funnel test; VOID its deposit-sheet row if one appears.` };
  },

  /* 15 · Password by the team rule on the user the Mac Mini created. */
  user_password: async (_svc, ob) => {
    const email = String(ob.form.email ?? "").trim();
    if (!email) return { status: "failed", note: "no email on the form — the user cannot be found" };
    const u = await findLocationUserByEmail(ob.setup!.location_id, email);
    if (!u) return { status: "failed", note: `no user with ${email} on the account yet — check the AI Agent's screenshots, then Retry` };
    const password = employeePassword(ob.form.owner_name);
    await setUserPassword(u.id, password);
    return { status: "done", note: `password set for ${email} (shown on this card only)`, facts: { user_id: u.id, password } };
  },

  /* 25 · One-box funnel = the Funnels tab's "Add client", then the deposit
     URL custom value so the AI's pay link points at it. */
  funnel_create: async (svc, ob) => {
    const biz = ob.form.business_name.trim();
    const slug = slugify(biz);
    const locationId = ob.setup!.location_id;
    const { data: have } = await svc.from("onebox_clients").select("slug, status").eq("location_id", locationId).maybeSingle();
    let note: string;
    let finalSlug = slug;
    if (have?.slug) { finalSlug = String(have.slug); note = `funnel already exists: /${finalSlug} (${have.status})`; }
    else {
      const r = await addOneboxFunnel(svc, { slug, locationId, clientName: biz, oldFunnelUrl: String(ob.form.old_funnel_url ?? "") });
      if ("error" in r) return { status: "failed", note: r.error };
      note = [`created ${r.url}`, r.pixelNote, r.photoNote, r.surveyNote, r.cvNote].filter(Boolean).join("\n");
    }
    const url = `${FUNNEL_ORIGIN}/${finalSlug}`;
    const dep = await setDepositFunnelUrl(locationId, url);
    note += dep.ok ? `\n"${dep.updated.join('", "')}" → ${url}` : `\n✗ deposit funnel URL custom value not set (${dep.error})`;
    return { status: dep.ok ? "done" : "warn", note, facts: { slug: finalSlug, funnel_url: url } };
  },

  /* 26 · Meta pixel: the form's ID wins, else harvested from the old pages. */
  funnel_pixel: async (svc, ob) => {
    const slug = ob.setup!.slug!;
    const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
    const extras = { ...((row?.extras ?? {}) as Record<string, unknown>) };
    const raw = String(ob.form.meta_pixel_id ?? "").trim();
    if (NO_PIXEL_RE.test(raw)) return { status: "skipped", note: `no pixel yet ("${raw}" on the form) — the media buyer adds it in the Funnels tab (Start Setup) once the ads account has one` };
    const fromForm = raw.replace(/\D/g, "");
    if (fromForm.length >= 10) {
      extras.metaPixelId = fromForm;
      await svc.from("onebox_clients").update({ extras }).eq("slug", slug);
      return { status: "done", note: `pixel ${fromForm} from the form → funnel` };
    }
    const cur = String(extras.metaPixelId ?? "").replace(/\D/g, "");
    if (cur) return { status: "done", note: `pixel ${cur} already on the funnel (harvested when it was created)` };
    const h = await harvestFirstPixel(slug, String(ob.form.old_funnel_url ?? "").trim() || undefined);
    if (!h.id) return { status: "warn", note: "no pixel found on the form or the client's old pages — the media buyer sets it in Start Setup (Funnels tab)" };
    extras.metaPixelId = h.id;
    await svc.from("onebox_clients").update({ extras }).eq("slug", slug);
    return { status: "done", note: `pixel ${h.id} harvested from ${h.from}` };
  },

  /* 28 · Instagram grid (owner, 10/26/2026): our own feed, fetched from the
     client's Instagram link and sorted by what each picture shows. No
     Elfsight. The hourly job keeps it fresh afterwards. */
  funnel_ig: async (svc, ob) => {
    const slug = ob.setup!.slug!;
    await refreshOneboxConfig(svc, slug, ob.setup!.location_id).catch(() => undefined);
    const { data: row } = await svc.from("onebox_clients").select("config").eq("slug", slug).maybeSingle();
    const config = { ...((row?.config ?? {}) as Record<string, unknown>) };
    const fromForm = String(ob.form.ig_link ?? "").trim();
    let link = String(config.igLink ?? "").trim();
    if (!usernameFromLink(link) && usernameFromLink(fromForm)) {
      link = fromForm;
      config.igLink = fromForm;
      await svc.from("onebox_clients").update({ config }).eq("slug", slug);
    }
    if (!usernameFromLink(link)) {
      return { status: "warn", note: link || fromForm
        ? `"${link || fromForm}" is not an Instagram profile link — fix it in the Funnels tab, then press Refresh in the client's 📸 panel (Cost per Deposit)`
        : "no Instagram link on the form — add it in the Funnels tab, then press Refresh in the client's 📸 panel (Cost per Deposit)" };
    }
    const r = await refreshFunnel(svc, slug);
    if (!r.ok) return { status: "warn", note: `Instagram fetch failed: ${r.why} — the funnel shows no Instagram section until it works (a private or restricted account can't be fetched)` };
    // Funnel logo (owner 10/27/2026): the client's Instagram profile picture
    // (already copied into our bucket by the fetch above) is the funnel logo —
    // never a Facebook cover or whatever an old account carried in "CC - Funnel
    // Logo" (Elena Altbaum's 2023 account). Only a logo typed on the form wins.
    let logoNote = "";
    if (!String(ob.form.logo_url ?? "").trim()) {
      const { data: fresh } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
      const pic = String((fresh?.extras as { igFeed?: { profile?: { pic?: string } } } | null)?.igFeed?.profile?.pic ?? "").trim();
      if (pic) {
        const w = await setOneboxCustomValues(ob.setup!.location_id, [{ name: "CC - Funnel Logo", value: pic }]);
        if (w.written.length) { await refreshOneboxConfig(svc, slug, ob.setup!.location_id, { logo: pic }).catch(() => undefined); logoNote = " · logo = her Instagram profile picture"; }
        else logoNote = ` · logo NOT set (${w.error ?? "custom value missing"}) — add it in the Funnels tab`;
      } else logoNote = " · no profile picture came back, logo left empty";
    }
    return { status: "done", note: `${r.imgs} pictures fetched and sorted (results first) — grid live on the funnel${logoNote}` };
  },

  /* 44 · Google reviews (owner, 10/27/2026): our own copy of the place's
     rating + best reviews from Google Places. No Elfsight. */
  funnel_reviews: async (svc, ob) => {
    const slug = ob.setup!.slug!;
    await refreshOneboxConfig(svc, slug, ob.setup!.location_id).catch(() => undefined);
    const { data: row } = await svc.from("onebox_clients").select("config").eq("slug", slug).maybeSingle();
    const config = { ...((row?.config ?? {}) as Record<string, unknown>) };
    const fromForm = String(ob.form.gmb_link ?? "").trim();
    if (!String(config.gmbLink ?? "").trim() && fromForm) {
      config.gmbLink = fromForm;
      await svc.from("onebox_clients").update({ config }).eq("slug", slug);
    }
    if (!process.env.GOOGLE_PLACES_API_KEY) return { status: "warn", note: "GOOGLE_PLACES_API_KEY is not set in Vercel yet — reviews will be fetched by the daily job once it is" };
    const r = await refreshReviews(svc, slug);
    if (!r.ok) return { status: "warn", note: `Google reviews: ${r.why} — the funnel has no reviews section until this works (add the Google Business link in the Funnels tab)` };
    return { status: "done", note: `${r.reviews} reviews${r.rating != null ? ` (rating ${r.rating})` : ""} on the funnel` };
  },

  /* 30 · Go live (the Funnels tab's "Go live", incl. the deposit URL). */
  funnel_live: async (svc, ob) => {
    const slug = ob.setup!.slug!;
    // Step 7 copied the webhook URL but its custom value can be missing then
    // (Brows by Susan 10/23/2026: the snapshot was reloaded after step 7) —
    // write the saved URL now so go-live never stops for a value we have.
    if (ob.setup!.hook_url) await healHookUrl(svc, ob).catch(() => undefined);
    // Never go live with holes: the AI quotes these values to leads.
    const gaps = await preLiveGaps(ob.setup!.location_id, String(ob.form.version ?? ""));
    if (gaps.length) return { status: "failed", note: `NOT live yet — ${gaps.length} value${gaps.length > 1 ? "s" : ""} empty in the sub-account. Fill them (Clients tab or GHL Custom Values), then Retry:\n${gaps.map((g) => `✗ ${g}`).join("\n")}` };
    const cal = await ensureCalendarActive(ob.setup!.location_id).catch((e) => ({ ok: false, note: `calendar: ${errMsg(e)}` }));
    if (!cal.ok) return { status: "failed", note: `NOT live yet — ${cal.note}. Fix it, then Retry` };
    const { error } = await svc.from("onebox_clients").update({ status: "live", updated_at: now() }).eq("slug", slug);
    if (error) throw new Error(error.message);
    const url = `${FUNNEL_ORIGIN}/${slug}`;
    const dep = await setDepositFunnelUrl(ob.setup!.location_id, url);
    return { status: dep.ok ? "done" : "warn", note: `funnel LIVE at ${url} · ${cal.note}${dep.ok ? "" : ` · ⚠ deposit URL custom value: ${dep.error}`}` };
  },

  /* 36 · The Check-Setup grade on the finished account. */
  last_check: async (_svc, ob) => {
    // Safety net: the artist's schedule must be in the studio's time zone.
    const tz: ClaimAction[] = await syncScheduleTimezones(ob.setup!.location_id).catch((e) => [{ action: "Schedule time zone", ok: false, detail: errMsg(e) }]);
    const cal = await ensureCalendarActive(ob.setup!.location_id).catch((e) => ({ ok: false, note: `calendar: ${errMsg(e)}` }));
    tz.push({ action: "Booking calendar", ok: cal.ok, detail: cal.note });
    // Fix the phone / address format ourselves and show it (owner 10/21/2026).
    tz.push(...await tidyContactValues(ob.setup!.location_id).catch((e) => [{ action: "Contact values", ok: false, detail: errMsg(e) } as ClaimAction]));
    // The number bought in step 9 lives in the AI Agent's report; the check
    // accepts it even when GHL never attached it to a user.
    const bought = (stepState(ob.setup, "phone_buy").note ?? "").match(/\+?1?[\s(-]*(\d{3})[\s)-]*(\d{3})[\s-]*(\d{4})\b/);
    const purchasedPhone = bought ? `${bought[1]}${bought[2]}${bought[3]}` : undefined;
    const tzBad = tz.filter((a) => !a.ok).length;
    const tzNote = tz.map((a) => `${a.ok ? "✓" : "✗"} ${a.action}${a.detail ? ` — ${a.detail}` : ""}`).join("\n");
    const r = await verifyOnboarding({ ...ob.form, product_id: ob.setup!.product_id ?? ob.form.product_id }, { locationId: ob.setup!.location_id, purchasedPhone });
    const fails = r.checks.filter((c) => c.status === "fail");
    const pass = r.checks.filter((c) => c.status === "pass").length;
    if (!fails.length && !tzBad) {
      // Logins saved early too, so a deal moved by hand in GHL still texts them.
      const cid = String(ob.form.master_contact_id ?? "").trim();
      const tok = cid ? await getAppLocationToken(MAIN_LOC).catch(() => null) : null;
      const saved = tok?.token
        ? await saveLoginFields(ob, cid, { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" }).then(() => "\nlogins saved on the agency contact").catch(() => "")
        : "";
      return { status: "done", note: `all green — ${pass} checks passed\n${tzNote}${saved}` };
    }
    // Owner 10/21/2026: anything still off STOPS the run here (red, Retry after fixing).
    return { status: "failed", note: `STOPPED — ${pass} passed, ${fails.length + tzBad} to fix before the funnel test:\n${[...fails.map((f) => `✗ ${f.key}: ${f.detail}`), tzNote].join("\n")}` };
  },

  /* 37 · Move the client's deal to "First Cycle" in the agency pipeline, then
     the summary text goes out (see settle). */
  first_cycle: async (_svc, ob) => {
    const contactId = String(ob.form.master_contact_id ?? "").trim();
    if (!contactId) return { status: "warn", note: "no Contact ID on the Clients Master row — move the deal to First Cycle by hand" };
    const tok = await getAppLocationToken(MAIN_LOC);
    if (!tok.token) return { status: "warn", note: `agency token unavailable (${tok.error}) — move the deal to First Cycle by hand` };
    const H = { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" };
    // Owner 10/22/2026: the "Started stage -> Went live Notification" workflow
    // texts the client the logins (3 texts) once the deal lands in First Cycle,
    // from these contact fields — so they are filled right before the move.
    let fieldNotes: string[];
    try {
      fieldNotes = await saveLoginFields(ob, contactId, H);
    } catch (e) {
      return { status: "failed", note: `logins not saved on the agency contact — ${errMsg(e)}. Fix and Retry (the deal was NOT moved, so the client gets no half-filled texts)` };
    }
    const pipes = (await fetch(`${GHL}/opportunities/pipelines?locationId=${MAIN_LOC}`, { headers: H }).then((r) => r.json()).catch(() => ({}))) as { pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> };
    let target: { pipelineId: string; stageId: string; stageName: string } | null = null;
    for (const p of pipes.pipelines ?? []) for (const s of p.stages ?? []) if (/first\s*cycle/i.test(s.name) && !target) target = { pipelineId: p.id, stageId: s.id, stageName: s.name };
    if (!target) return { status: "warn", note: "no pipeline stage named \"First Cycle\" in the agency account — move the deal by hand" };
    const opps = (await fetch(`${GHL}/opportunities/search?location_id=${MAIN_LOC}&contact_id=${contactId}&limit=20`, { headers: H }).then((r) => r.json()).catch(() => ({}))) as { opportunities?: Array<{ id: string; name?: string; pipelineId: string; pipelineStageId: string }> };
    const opp = (opps.opportunities ?? []).find((o) => o.pipelineId === target!.pipelineId) ?? (opps.opportunities ?? [])[0];
    if (!opp) return { status: "warn", note: "the client has no deal in the agency pipeline — move it to First Cycle by hand" };
    if (opp.pipelineStageId === target.stageId) return { status: "done", note: `${fieldNotes.join("; ")}\ndeal "${opp.name ?? ""}" already in ${target.stageName}` };
    const r = await fetch(`${GHL}/opportunities/${opp.id}`, { method: "PUT", headers: H, body: JSON.stringify({ pipelineId: target.pipelineId, pipelineStageId: target.stageId }) });
    if (!r.ok) return { status: "failed", note: `could not move the deal: HTTP ${r.status} ${(await r.text()).slice(0, 150)}` };
    return { status: "done", note: `${fieldNotes.join("; ")}\ndeal "${opp.name ?? ""}" → ${target.stageName} — the client gets the 3 welcome texts now` };
  },
};

/* The login email, password and funnel URL on the client's agency contact —
   what the "Went live" workflow texts. Also run when step 34 is approved by
   hand (owner 10/24: Susan got "Email: / Password:" blank after a manual
   approve skipped this). */
export async function saveLoginFields(ob: Ob, contactId: string, H: Record<string, string>): Promise<string[]> {
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
      const pw = String(ob.setup!.password ?? "").trim();
      const email = String(ob.form.email ?? "").trim();
      const funnel = String(ob.setup!.funnel_url ?? "").trim();
      if (email) values.push({ id: await ensure("CC - Login Email", "contact.cc__login_email"), field_value: email });
      if (pw) values.push({ id: await ensure("CC - Login Password", "contact.cc__login_password"), field_value: pw });
      if (funnel) values.push({ id: await ensure("CC - Funnel URL", "contact.cc__funnel_url"), field_value: funnel });
      const body: Record<string, unknown> = { customFields: values };
      if (ob.form.business_name) body.companyName = ob.form.business_name;
      const r = await fetch(`${GHL}/contacts/${contactId}`, { method: "PUT", headers: H, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`contact update HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      fieldNotes.push(`login email${pw ? ", password" : " (no password on the run!)"}${funnel ? ", funnel URL" : " (no funnel URL!)"} saved on the agency contact → the Went-live workflow texts them`);
    return fieldNotes;
}

// ── Mac Mini steps: one card at a time, in runbook order ───────────────────
function facts(ob: Ob): SetupFacts {
  return { locationId: ob.setup!.location_id, form: ob.form, slug: ob.setup!.slug, funnelUrl: ob.setup!.funnel_url, userEmail: ob.form.email };
}

/* The next browser step that is still "todo" gets its agent_proposals row:
   mini → queued_browser (the worker claims it), ask → pending (the owner's
   Approve in the AI tab queues it). Nothing is queued while an earlier
   browser step is still open, or while a prerequisite API step failed. */
async function ensureMiniCard(svc: Svc, onboardingId: string): Promise<void> {
  const ob = await loadOb(svc, onboardingId);
  const setup = ob.setup!;
  const browserSteps = runSteps().filter((s) => s.who === "mini" || s.who === "ask");
  const open = browserSteps.find((s) => ["queued", "waiting_owner", "running"].includes(stepState(setup, s.key).status));
  if (open) return;
  if (browserSteps.some((s) => stepState(setup, s.key).status === "failed")) return;
  const next = browserSteps.find((s) => stepState(setup, s.key).status === "todo");
  if (!next) return;
  // Gates: a browser step cannot start before the API step it builds on.
  const needs: Record<string, string[]> = {
    webhook_url: ["account_take"], phone_a2p: ["phone_buy"], phone_cnam: ["phone_buy"], phone_optout: ["phone_buy"], phone_forward: ["phone_buy"],
    user_settings: ["user_password"], user_calendar: ["user_password"], wf_survey: ["user_password"], cal_team: ["user_password"], cal_hours: ["user_password"],
    funnel_ig: ["funnel_create"], funnel_reviews: ["funnel_create"], funnel_redirect: ["funnel_create"], funnel_test: ["funnel_live", "last_check", "product"], last_profile: ["funnel_live"],
  };
  for (const k of needs[next.key] ?? []) {
    const st = stepState(setup, k);
    if (!isSettled(st)) {
      if (st.status === "failed") return; // the failed API step shows red; Retry it first
      return; // still running / waiting — try again on the next advance
    }
  }
  const f = facts(ob);
  const attempt = (setup.log.filter((l) => l.key === next.key && l.msg.startsWith("card")).length) + 1;
  // An "asks you" step approved up front at Approve time runs like any AI Agent step.
  const asks = (s: RunbookStep) => s.who === "ask" && !(setup.preapproved ?? []).includes(s.key);
  const isAsk = asks(next);
  // Batch (owner 10/21/2026): the following "todo" steps of the same batch
  // (same screens) ride on this card, as long as nothing gates them except
  // steps already settled or in the card itself. An unapproved "asks you"
  // step ends the batch — it gets its own pending card.
  const group: RunbookStep[] = [next];
  if (next.batch && !isAsk) {
    const idx = browserSteps.indexOf(next);
    for (const s of browserSteps.slice(idx + 1)) {
      if (s.batch !== next.batch || stepState(setup, s.key).status !== "todo" || asks(s)) break;
      const gated = (needs[s.key] ?? []).some((k) => !isSettled(stepState(setup, k)) && !group.some((g) => g.key === k));
      if (gated) break;
      group.push(s);
    }
  }
  const batched = group.length > 1;
  const nums = `${group[0].n}–${group[group.length - 1].n}`;
  const { data: ins, error } = await svc.from("agent_proposals").insert({
    conversation_id: setupConvId(onboardingId, next.key),
    message_id: `${group.map((g) => g.key).join("+")}#${attempt}`,
    contact_id: null,
    contact_name: ob.form.business_name.trim(),
    channel: null,
    client_message: miniContext(next, f, group),
    summary: (batched ? `Setup steps ${nums}/${RUNBOOK.length}: ${group.map((g) => g.title ?? g.label).join(" · ")}` : `Setup step ${next.n}/${RUNBOOK.length}: ${next.label}`).slice(0, 500),
    action_type: "account_change",
    proposed_reply: null,
    action_detail: (batched ? group.map((g) => `${g.n}. ${g.label}`).join("\n") : `${next.label}${next.how ? ` — ${next.how}` : ""}`).slice(0, 1500),
    action_plan: (batched ? batchPlan(group, f) : miniPlan(next, f)).map((what) => ({ type: "manual", what })),
    location_id: setup.location_id,
    ...(isAsk ? {} : { status: "queued_browser", decided_by: `${DASHBOARD} (setup run)`, decided_at: now(), executed_at: now(), result: "⏳ Waiting for the AI Agent (new client setup)" }),
  }).select("id").maybeSingle();
  if (error || !ins) {
    await patch(svc, onboardingId, (o) => { if (!o.setup) return; setStep(o.setup, next.key, { status: "failed", who: DASHBOARD, note: `could not queue the AI Agent card: ${error?.message ?? "insert failed"}`, error: error?.message }); return { setup: o.setup }; });
    return;
  }
  const pid = (ins as { id: string }).id;
  await patch(svc, onboardingId, (o) => {
    if (!o.setup) return;
    for (const g of group) {
      setStep(o.setup, g.key, { status: isAsk ? "waiting_owner" : "queued", who: isAsk ? "You → AI Agent" : "AI Agent", proposal_id: pid, note: isAsk ? "waiting for your Approve in the AI tab" : batched ? `queued for the AI Agent (steps ${nums} on one card)` : "queued for the AI Agent" }, g.key === next.key ? `card ${pid} ${isAsk ? "pending (asks you)" : batched ? `queued with steps ${nums}` : "queued"}` : undefined);
    }
    return { setup: o.setup };
  });
  if (isAsk) {
    const biz = ob.form.business_name.trim();
    await textOwner(svc, `🧩 Setup ${biz} — step ${next.n} needs you: ${next.label}.\nApprove or deny: ${proposalLink(pid)}`).catch(() => undefined);
  }
}

/* Called by the worker when a setup card closes (done / failed / needs a
   teammate), and by the stale-claim sweeper. Records the outcome and the
   screenshots on the card, ticks the checklist, keeps the facts the next
   steps need (the webhook URL), then moves the run along. */
export async function onSetupProposalClosed(svc: Svc, p: { id: string; conversation_id: string; status: string; result: string | null; screenshots?: Array<{ name: string; url: string }> | null }): Promise<void> {
  const ref = parseSetupConvId(p.conversation_id);
  if (!ref) return;
  const step = stepByKey(ref.key);
  if (!step) return;
  const shots = (p.screenshots ?? []).slice(0, 10);
  const ok = p.status === "done";
  const text = String(p.result ?? "");

  // A batched card (several steps, one proposal): each step follows its own
  // "STEP n: done|failed — …" line; a step without a line follows the card.
  const perStep = new Map<number, { ok: boolean; note: string }>();
  for (const m of text.matchAll(/STEP\s+(\d+)\s*:\s*(done|failed|skipped)\b\s*[—\-–:]?\s*([^\n]*)/gi)) perStep.set(Number(m[1]), { ok: m[2].toLowerCase() === "done", note: m[3].trim() });
  const closedKeys: string[] = [];

  await patch(svc, ref.onboardingId, (o) => {
    if (!o.setup) return;
    const cur = o.setup.steps[ref.key];
    if (cur?.proposal_id && cur.proposal_id !== p.id) return; // an older card for a retried step
    const members = runSteps().filter((s) => o.setup!.steps[s.key]?.proposal_id === p.id);
    const group = members.length ? members : [step];
    const checklist = { ...o.checklist };
    for (const g of group) {
      const line = group.length > 1 ? perStep.get(g.n) : undefined;
      const stepOk = line ? line.ok : ok;
      const note = line ? `${line.ok ? "✓" : "✗"} ${line.note}`.trim() : text;
      // "SUPPORT TICKET: …" in a done report = finished as far as the AI Agent
      // can, a person follows up with GHL support (stale CNAM on a recycled
      // account, 10/21/2026). Shown amber, the run goes on.
      // Owner 10/22/2026: a CNAM the carrier REJECTS (caller name only — texts
      // and A2P are unaffected) never stops the run: amber note, run goes on.
      const cnamRejected = g.key === "phone_cnam" && !stepOk && /reject/i.test(note || text);
      const status: StepState["status"] = cnamRejected ? "warn" : stepOk ? (/\bSUPPORT TICKET\b/i.test(note) ? "warn" : "done") : "failed";
      const shown = cnamRejected ? `⚠ CNAM rejected by the carrier — skipped so the setup goes on (only the caller name on outgoing calls; texts work). Re-submit later or ask GHL support.\n${note}` : note;
      setStep(o.setup, g.key, { status, who: "AI Agent", note: shown.slice(0, 1500), screenshots: g.key === ref.key ? shots : undefined, error: stepOk || cnamRejected ? undefined : (p.status === "needs_teammate" || line ? "the AI Agent needs a teammate — see its note" : "the AI Agent could not finish") }, `card ${p.id} → ${p.status}${line ? ` (step ${g.n}: ${line.ok ? "done" : "failed"})` : ""}`);
      if (stepOk) { tick(checklist, g.checklist, "AI Agent"); closedKeys.push(g.key); }
      // Step 15: the password the Mini set by the team rule, kept on the card.
      if (stepOk && g.key === "user_password") o.setup.password = employeePassword(String(o.form.owner_name ?? ""));
    }
    // Step 7: the payment route URL the Mini read off the workflow editor.
    if (ok && ref.key === "webhook_url") {
      const m = text.match(/https:\/\/(?:services|backend)\.leadconnectorhq\.com\/hooks\/[A-Za-z0-9/_-]+/);
      if (m && isValidHookUrlForLocation(m[0], o.setup.location_id)) o.setup.hook_url = m[0];
      else { setStep(o.setup, ref.key, { status: "failed", error: m ? "the URL the Mini reported belongs to another account" : "no webhook URL in the Mini's report", note: `${text.slice(0, 800)}\n✗ ${m ? "URL is for another location" : "no URL found in the report"} — Retry` }); }
    }
    return { setup: o.setup, checklist };
  });

  /* Step 22: put the artist's schedule in the sub-account's time zone right
     away (owner 2026-10-20) — whatever the AI Agent did with the hours, a
     schedule left in Israel or another US zone shifts every slot. The last
     check (step 32, the final check) still re-checks it. */
  if (closedKeys.includes("cal_hours")) {
    const loc = (await loadOb(svc, ref.onboardingId)).setup?.location_id;
    if (loc) {
      const tz: ClaimAction[] = await syncScheduleTimezones(loc).catch((e) => [{ action: "Schedule time zone", ok: false, detail: errMsg(e) }]);
      const line = tz.map((a) => `${a.ok ? "✓" : "✗"} ${a.action}${a.detail ? ` — ${a.detail}` : ""}`).join("\n");
      await patch(svc, ref.onboardingId, (o) => {
        const cur = o.setup?.steps.cal_hours;
        if (!o.setup || !cur || (cur.proposal_id && cur.proposal_id !== p.id)) return;
        setStep(o.setup, "cal_hours", { ...cur, status: cur.status, at: cur.at, note: `${line}\n${cur.note ?? ""}`.slice(0, 1500) }, "schedule time zone synced to the sub-account");
        return { setup: o.setup };
      });
    }
  }

  // Save the hook where the payment router and the funnel read it.
  const ob = await loadOb(svc, ref.onboardingId);
  if (ok && ref.key === "webhook_url" && ob.setup?.hook_url) {
    const notes = await healHookUrl(svc, ob);
    await patch(svc, ref.onboardingId, (o) => { if (!o.setup) return; const st = o.setup.steps[ref.key]; setStep(o.setup, ref.key, { status: st.status, note: `${st.note ?? ""}\n${notes.join(" · ")}`.trim() }); return { setup: o.setup }; });
  }
  if (ok && (ref.key === "webhook_url" || ref.key === "funnel_ig")) await refreshCard(svc, ref.onboardingId);
  await advanceSetup(svc, ref.onboardingId).catch(() => undefined);
}

/* The Funnels card (onebox_clients.config) is a copy of the sub-account's
   custom values taken when the funnel was created — before steps 3/6/7/24
   filled them, so Sally's card showed Calendar ID, product ID and webhook
   URL empty (10/16/2026). Re-copy after each of those steps. */
/* The webhook URL from step 7 → the funnel (payment routing) and the
   "CC - Fanbasis Webhook URL" custom value. Step 7's finish and go-live. */
async function healHookUrl(svc: Svc, ob: Ob): Promise<string[]> {
  const setup = ob.setup!;
  const hook = setup.hook_url!;
  const notes: string[] = [];
  if (setup.slug) {
    const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", setup.slug).maybeSingle();
    const extras = { ...((row?.extras ?? {}) as Record<string, unknown>), fanbasisHookUrl: hook, paymentRouter: "yes" };
    await svc.from("onebox_clients").update({ extras }).eq("slug", setup.slug);
    notes.push("saved on the funnel (payment routing ON)");
  }
  try {
    const cvs = await listLocationCustomValues(setup.location_id);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const cv = cvs.find((c) => norm(c.name).includes("fanbasiswebhookurl"));
    if (cv) { await setExistingCustomValue(setup.location_id, cv.name, hook); notes.push(`→ "${cv.name}"`); }
    else notes.push('🔴 custom value "CC - Fanbasis Webhook URL" is missing — create it by hand');
  } catch (e) { notes.push(`✗ custom value: ${errMsg(e)}`); }
  if (setup.slug) await refreshOneboxConfig(svc, setup.slug, setup.location_id).catch(() => undefined);
  return notes;
}

async function refreshCard(svc: Svc, onboardingId: string): Promise<void> {
  const ob = await loadOb(svc, onboardingId).catch(() => null);
  const slug = ob?.setup?.slug;
  if (!slug || !ob?.setup?.location_id) return;
  try { await refreshOneboxConfig(svc, slug, ob.setup.location_id); } catch { /* the card's Sync button does the same */ }
}

/* Live card statuses for the steps that have one (the AI tab card may have
   moved since: pending → queued_browser → running). */
export async function liveCardStatuses(svc: Svc, setup: SetupState | null): Promise<Record<string, { status: string; screenshots: Array<{ name: string; url: string }>; result: string | null }>> {
  const ids = Object.values(setup?.steps ?? {}).map((s) => s.proposal_id).filter((x): x is string => !!x);
  if (!ids.length) return {};
  const { data } = await svc.from("agent_proposals").select("id, status, screenshots, result").in("id", ids);
  const out: Record<string, { status: string; screenshots: Array<{ name: string; url: string }>; result: string | null }> = {};
  for (const r of (data ?? []) as Array<{ id: string; status: string; screenshots: Array<{ name: string; url: string }> | null; result: string | null }>) {
    out[r.id] = { status: r.status, screenshots: r.screenshots ?? [], result: r.result };
  }
  return out;
}

// ── Owner actions on a step ─────────────────────────────────────────────────
/* A confirm step (Move to First Cycle): a person clicks Approve on the card,
   then the dashboard runs it like any other API step. */
export async function confirmStep(svc: Svc, onboardingId: string, key: string, by: string): Promise<SetupState> {
  const step = stepByKey(key);
  if (!step?.confirm) throw new Error("this step has no Approve button");
  await patch(svc, onboardingId, (o) => {
    if (!o.setup) return;
    const cur = stepState(o.setup, key);
    if (cur.status !== "todo") return;
    setStep(o.setup, key, { ...cur, confirmed_by: by }, `approved by ${by}`);
    return { setup: o.setup };
  });
  return advanceSetup(svc, onboardingId);
}

export async function retryStep(svc: Svc, onboardingId: string, key: string, by: string): Promise<SetupState> {
  const step = stepByKey(key);
  if (!step) throw new Error("unknown step");
  await patch(svc, onboardingId, (o) => {
    if (!o.setup) return;
    setStep(o.setup, key, { status: "todo", note: undefined, error: undefined, proposal_id: undefined, screenshots: undefined }, `retry by ${by}`);
    if (o.setup.status !== "running") o.setup.status = "running";
    return { setup: o.setup };
  });
  return advanceSetup(svc, onboardingId);
}

export async function skipStep(svc: Svc, onboardingId: string, key: string, by: string, note?: string): Promise<SetupState> {
  const step = stepByKey(key);
  if (!step) throw new Error("unknown step");
  // A card still waiting in the AI tab / the Mini's queue is closed too, so
  // the Mini never does a step a person already finished by hand.
  const cur = (await loadOb(svc, onboardingId)).setup?.steps[key];
  if (cur?.proposal_id) {
    await svc.from("agent_proposals").update({ status: "denied", result: `skipped on the Onboarding card by ${by} — approved manually`, decided_by: by, decided_at: now() })
      .eq("id", cur.proposal_id).in("status", ["pending", "queued_browser"]);
  }
  // Deal moved by hand → the Went-live texts still need the logins saved.
  let loginNote = "";
  if (key === "first_cycle") {
    const ob = await loadOb(svc, onboardingId);
    const contactId = String(ob.form.master_contact_id ?? "").trim();
    const tok = contactId ? await getAppLocationToken(MAIN_LOC) : null;
    if (!contactId) loginNote = "⚠ no Contact ID — logins NOT saved on the agency contact";
    else if (!tok?.token) loginNote = `⚠ agency token unavailable — logins NOT saved (${tok?.error})`;
    else loginNote = await saveLoginFields(ob, contactId, { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" })
      .then((n) => n.join("; ")).catch((e) => `⚠ logins NOT saved: ${errMsg(e)}`);
  }
  await patch(svc, onboardingId, (o) => {
    if (!o.setup) return;
    setStep(o.setup, key, { status: "skipped", who: by, note: [note?.trim() || "approved manually", loginNote].filter(Boolean).join("\n") }, `skipped by ${by}`);
    const checklist = { ...o.checklist };
    tick(checklist, step.checklist, by);
    if (o.setup.status !== "running") o.setup.status = "running";
    return { setup: o.setup, checklist };
  });
  return advanceSetup(svc, onboardingId);
}

/* A pool snapshot card closed (lib/pool-snapshot updated the pool row). A
   setup run waiting on it at step 0 resumes: done → the step runs again and
   now passes; failed → red with Retry (which queues the load again). */
export async function onPoolSnapshotClosedForSetup(svc: Svc, p: { id: string; status: string; result: string | null }): Promise<void> {
  const { data } = await svc.from("onboardings").select("id, setup").contains("setup", { steps: { account_check: { proposal_id: p.id } } });
  for (const row of (data ?? []) as Array<{ id: string; setup: SetupState | null }>) {
    const st = stepState(row.setup, "account_check");
    if (st.status !== "queued" || st.proposal_id !== p.id) continue;
    // The pool row is the truth (lib/pool-snapshot re-checked the account):
    // a worker that stopped early after a successful load still counts as done.
    const { data: pool } = await svc.from("pool_accounts").select("snapshot_loaded_at").eq("location_id", row.setup!.location_id).maybeSingle();
    const ok = p.status === "done" || !!(pool as { snapshot_loaded_at?: string | null } | null)?.snapshot_loaded_at;
    const first = String(p.result ?? "").split("\n")[0].replace(/^[✓✗👤]\s*/, "").slice(0, 200);
    await patch(svc, row.id, (o) => {
      if (!o.setup) return;
      setStep(o.setup, "account_check", ok
        ? { status: "todo", note: `✓ snapshot loaded by the AI Agent — checking the account again`, proposal_id: undefined }
        : { status: "failed", error: "the AI Agent could not load the snapshot", note: `✗ snapshot load failed: ${first} — check the account, then Retry` }, `snapshot card ${p.id} → ${p.status}`);
      return { setup: o.setup };
    });
    if (ok) await advanceSetup(svc, row.id).catch(() => { /* Refresh re-runs the engine */ });
  }
}

// ── Overall status + the one text at the end ────────────────────────────────
async function settle(svc: Svc, onboardingId: string): Promise<void> {
  const ob = await loadOb(svc, onboardingId);
  const setup = ob.setup!;
  const steps = runSteps();
  const states = steps.map((s) => ({ s, st: stepState(setup, s.key) }));
  const failed = states.filter((x) => x.st.status === "failed");
  const waiting = states.filter((x) => x.st.status === "waiting_owner" || (x.s.confirm && x.st.status === "todo" && states.filter((y) => y.s.key !== x.s.key).every((y) => isSettled(y.st))));
  const allDone = states.every((x) => isSettled(x.st));
  const nextStatus: SetupState["status"] = failed.length ? "failed" : allDone ? "done" : waiting.length ? "waiting" : "running";
  const changed = nextStatus !== setup.status;
  if (!changed) return;

  let finalText: string | undefined;
  if (nextStatus === "done" || nextStatus === "failed") {
    const biz = ob.form.business_name.trim();
    const byApi = states.filter((x) => x.s.who === "api" && isSettled(x.st)).length;
    const byMini = states.filter((x) => x.s.who !== "api" && isSettled(x.st)).length;
    const warns = states.filter((x) => x.st.status === "warn");
    const head = nextStatus === "done" ? `✅ Setup done — ${biz}` : `❌ Setup stopped — ${biz}`;
    const body = [
      `${byApi} steps by the dashboard, ${byMini} by the AI Agent · ${setup.pool_name} → ${biz}`,
      setup.funnel_url ? `Funnel: ${setup.funnel_url}` : "",
      ...failed.map((x) => `✗ Step ${x.s.n} ${x.s.label}: ${(x.st.error ?? x.st.note ?? "failed").split("\n")[0].slice(0, 160)}`),
      ...warns.map((x) => `⚠ Step ${x.s.n} ${x.s.label}: ${(x.st.note ?? "").split("\n")[0].slice(0, 160)}`),
      nextStatus === "done" ? "Still yours: Facebook (Business Manager, campaign, publish) and the client's FB/IG connection — done by the team, outside this run." : `Open the card to Retry or Skip: ${dashboardUrl()}/onboarding?open=${onboardingId}`,
    ].filter(Boolean);
    finalText = `${head}\n${body.join("\n")}`;
    const lastShots = states.flatMap((x) => x.st.screenshots ?? []).slice(-2).map((s) => s.url);
    try { await confirmToOwner(svc, { contact_name: biz, summary: "New client setup", status: nextStatus === "done" ? "done" : "failed", result: body.join("\n") }, lastShots); } catch { /* the card has it */ }
  }
  await patch(svc, onboardingId, (o) => {
    if (!o.setup) return;
    o.setup.status = nextStatus;
    if (finalText) { o.setup.final_text = finalText; o.setup.finished_at = now(); }
    o.setup.log.push({ at: now(), key: "run", msg: `status → ${nextStatus}` });
    return { setup: o.setup };
  });
}

export const fmtWhen = usDate;
