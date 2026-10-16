import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";
import {
  claimPoolAccount, fillAccountValues, fillCalendarId, setLocationProfile, discoverPool, POOL_NAME_RE, setExistingCustomValue, listLocationCustomValues,
  employeePassword, findLocationUserByEmail, setUserPassword, slugify, type ClaimResult, type ClaimAction,
} from "@/lib/ghl-claim";
import { poolBlocker, poolReadiness, type PoolReadiness, type PoolRow } from "@/lib/ghl-cleanup";
import { createDepositProductFromForm } from "@/lib/deposit-product";
import { addOneboxFunnel, FUNNEL_ORIGIN } from "@/lib/onebox-add";
import { harvestFirstPixel, refreshOneboxConfig, setDepositFunnelUrl } from "@/lib/onebox";
import { buildReplayPayload, isValidHookUrlForLocation, replayToClientHook } from "@/lib/payment-router";
import { verifyOnboarding } from "@/lib/onboarding-verify";
import { writeRowToSheet, getSheetEntryForTable } from "@/lib/sheets";
import { confirmToOwner, dashboardUrl, proposalLink, textOwner } from "@/lib/agent-notify";
import {
  RUNBOOK, runSteps, stepByKey, stepState, isSettled, miniPlan, miniContext,
  type RunbookStep, type SetupState, type StepState, type SetupFacts,
} from "@/lib/setup-runbook";

/* ── New Client Setup run ───────────────────────────────────────────────────
   Owner-approved 10/15/2026. The Onboarding card holds the whole run in
   onboardings.setup (see supabase/new-client-setup.sql):

     Clients tab → "Set up account" → the card → Approve (clean account
     shown first) → the dashboard runs the API steps right away and queues
     the browser steps to the Mac Mini ONE AT A TIME, in runbook order
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
   (snapshot loaded, no client data, A2P approved — lib/pool-readiness).
   Without a GHL agency token (local dev) the table alone is used. */
export async function poolChoices(svc: Svc): Promise<{ choices: PoolChoice[]; defaultId: string | null; note?: string }> {
  const { data } = await svc.from("pool_accounts").select("*").eq("status", "available");
  const rows = (data ?? []) as PoolRow[];
  const byId = new Map(rows.map((r) => [r.location_id, r]));
  let live: Array<{ id: string; name: string }> | null = null;
  let note: string | undefined;
  try { live = await discoverPool(); } catch (e) { note = `GHL pool list unavailable (${errMsg(e)}) — showing the dashboard's pool table`; }
  const src = live ?? rows.map((r) => ({ id: r.location_id, name: r.pool_name }));
  const choices: PoolChoice[] = src
    .filter((l) => POOL_NAME_RE.test(l.name))
    .map((l) => {
      const r = byId.get(l.id);
      const readiness = r ? poolReadiness(r) : "unknown";
      const blocker = r ? poolBlocker(r) : "not checked yet";
      return { id: l.id, name: l.name, readiness, blocker, snapshot: !!r?.snapshot_loaded_at };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const ready = choices.filter((c) => c.readiness === "ready");
  return { choices, defaultId: (ready[0] ?? choices.find((c) => c.snapshot) ?? choices[0])?.id ?? null, note };
}

// ── Approve ─────────────────────────────────────────────────────────────────
export async function approveSetup(svc: Svc, onboardingId: string, poolLocationId: string, by: string): Promise<SetupState> {
  const ob = await loadOb(svc, onboardingId);
  if (ob.setup) throw new Error("This setup was already approved");
  if (!String(ob.form.business_name ?? "").trim() || !String(ob.form.owner_name ?? "").trim()) throw new Error("Business name and owner name are required on the form");

  let poolName = "";
  if (ob.claim?.location_id) {
    // The old Claim button already took an account — the run continues on it.
    poolLocationId = ob.claim.location_id;
    poolName = ob.claim.original_name;
  } else {
    const { choices } = await poolChoices(svc);
    const pick = choices.find((c) => c.id === poolLocationId);
    if (!pick) throw new Error("That clean account is not available anymore — pick another one");
    // Hard stop, not a per-value "missing" later: the run fills EXISTING
    // custom values and never creates them, so an account without the Demo
    // snapshot fails every fill step (Clean New Account 78, 10/15/2026).
    if (!pick.snapshot) throw new Error(`${pick.name} has no snapshot loaded — load it first (Onboarding → clean-account pool → "Load snapshot"), then Approve`);
    poolName = pick.name;
  }

  const setup: SetupState = {
    v: 1, approved_by: by, approved_at: now(), location_id: poolLocationId, pool_name: poolName,
    status: "running", steps: {}, log: [{ at: now(), key: "run", msg: `Approved by ${by} — taking ${poolName}` }],
  };
  // Team / client / owner steps are shown, not run.
  for (const s of RUNBOOK) if (!["api", "mini", "ask"].includes(s.who) || s.later) setup.steps[s.key] = { status: "manual" };
  if (ob.claim) {
    for (const k of ["account_take", "account_info", "account_cvs", "cal_id"]) setup.steps[k] = { status: "done", who: ob.claim.claimed_by ?? "Claim button", at: ob.claim.claimed_at ?? now(), note: `done earlier by the Claim button (${ob.claim.original_name} → ${ob.claim.business_name})` };
    const pid = String(ob.form.product_id ?? "").trim();
    if (pid) { setup.steps.product = { status: "done", who: "Claim button", at: now(), note: `product ID ${pid} already on the form` }; setup.product_id = pid; }
  }
  const { error } = await svc.from("onboardings").update({ setup }).eq("id", onboardingId);
  if (error) throw new Error(error.message.includes("setup") ? `${error.message} — run supabase/new-client-setup.sql first` : error.message);
  return advanceSetup(svc, onboardingId);
}

// ── The engine ──────────────────────────────────────────────────────────────
/* Run every API step whose prerequisites are met, then make sure the next
   browser step has its card. Safe to call again at any time (Approve, a
   Mac Mini finish, the card's Refresh). */
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
    case "account_take": case "master_row": return true;
    case "account_info": case "account_cvs": case "cal_id": return done(ob, "account_take");
    case "connector": case "product": case "funnel_create": return done(ob, "account_take");
    case "funnel_pixel": return done(ob, "funnel_create");
    case "route_test": return done(ob, "webhook_url") && done(ob, "product") && !!ob.setup?.hook_url;
    case "user_password": return done(ob, "user_create");
    case "funnel_live": return done(ob, "funnel_test") && done(ob, "funnel_create");
    case "last_check": return done(ob, "funnel_live") && done(ob, "last_profile");
    case "first_cycle": return done(ob, "last_check");
    default: return false;
  }
}

async function runApiStep(svc: Svc, ob: Ob, step: RunbookStep): Promise<void> {
  await patch(svc, ob.id, (o) => { if (!o.setup) return; setStep(o.setup, step.key, { status: "running", who: DASHBOARD }); return { setup: o.setup }; });
  let out: { status: StepState["status"]; note: string; facts?: Partial<SetupState>; form?: Record<string, string>; claim?: Ob["claim"] };
  try {
    out = await API_STEPS[step.key](svc, ob);
  } catch (e) {
    out = { status: "failed", note: errMsg(e) };
  }
  await patch(svc, ob.id, (o) => {
    if (!o.setup) return;
    setStep(o.setup, step.key, { status: out.status, who: DASHBOARD, note: out.note, error: out.status === "failed" ? out.note : undefined }, `${step.n}. ${step.label} → ${out.status}`);
    Object.assign(o.setup, out.facts ?? {});
    const checklist = { ...o.checklist };
    if (out.status === "done" || out.status === "warn") tick(checklist, step.checklist, DASHBOARD);
    return { setup: o.setup, checklist, ...(out.form ? { form: { ...o.form, ...out.form } } : {}), ...(out.claim ? { claim: out.claim } : {}) };
  });
  if (["account_cvs", "cal_id", "product", "funnel_create"].includes(step.key)) await refreshCard(svc, ob.id);
}

/* Pre-live check (V3 one-box): the "CC -" values the AI and the funnel read
   must be filled in the sub-account itself — the live source, not the form. */
const PRE_LIVE_VALUES: Array<{ label: string; match: (n: string) => boolean }> = [
  { label: "Business name", match: (n) => n === "ccbusinessname" || n === "businessname" },
  { label: "Owner name", match: (n) => n.includes("ownersname") || n.includes("ownername") },
  { label: "Business phone", match: (n) => n.includes("businessphone") },
  { label: "Business address", match: (n) => n.includes("address") && !n.includes("url") && !n.includes("link") },
  { label: "PMU services", match: (n) => n.includes("permanentmakeupservices") || n.includes("pmuservices") },
  { label: "Offer", match: (n) => n === "ccoffer" || (n.endsWith("offer") && !n.includes("url")) },
  { label: "Deposit amount", match: (n) => n.includes("depositamount") },
  { label: "Original price (new brows)", match: (n) => n.includes("originalprice") && (n.includes("newbrows") || n.includes("forbrows")) },
  { label: "Discounted price (new brows)", match: (n) => n.includes("discountedprice") && (n.includes("newbrows") || n.includes("forbrows")) },
  { label: "Commas product ID", match: (n) => n.includes("fanbasisproductid") },
  { label: "Payment webhook URL", match: (n) => n.includes("fanbasiswebhookurl") },
  { label: "Calendar ID", match: (n) => n.includes("transformationcalendarid") },
];

async function preLiveGaps(locationId: string): Promise<string[]> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const cvs = await listLocationCustomValues(locationId);
  return PRE_LIVE_VALUES.filter((r) => {
    const hits = cvs.filter((c) => r.match(norm(c.name)));
    return !hits.some((c) => String(c.value ?? "").trim()); // missing or empty
  }).map((r) => r.label);
}

type StepFn = (svc: Svc, ob: Ob) => Promise<{ status: StepState["status"]; note: string; facts?: Partial<SetupState>; form?: Record<string, string>; claim?: Ob["claim"] }>;

const lines = (acts: ClaimAction[]) => acts.map((a) => `${a.ok ? "✓" : "✗"} ${a.action}${a.detail ? ` — ${a.detail}` : ""}`).join("\n");

const API_STEPS: Record<string, StepFn> = {
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
    const acts = await fillAccountValues(ob.setup!.location_id, ob.form);
    const missing = acts.filter((a) => !a.ok);
    const claim = ob.claim ? { ...ob.claim, actions: [...ob.claim.actions, ...acts.filter((a) => a.ok)] } : undefined;
    return missing.length
      ? { status: "warn", note: `${acts.length - missing.length} of ${acts.length} filled. 🔴 MISSING — the team creates these by hand in GHL, then Retry:\n${lines(missing)}`, claim }
      : { status: "done", note: `${acts.length} custom values filled from the client's record`, claim };
  },

  /* 24 · Transformation calendar ID → its custom value. */
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
    return { status: "done", note: `test payment accepted by the route (${sent.note}). The Mac Mini deletes the "Router Test" contact in the funnel test; VOID its deposit-sheet row if one appears.` };
  },

  /* 15 · Password by the team rule on the user the Mac Mini created. */
  user_password: async (_svc, ob) => {
    const email = String(ob.form.email ?? "").trim();
    if (!email) return { status: "failed", note: "no email on the form — the user cannot be found" };
    const u = await findLocationUserByEmail(ob.setup!.location_id, email);
    if (!u) return { status: "failed", note: `no user with ${email} on the account yet — check the Mac Mini's screenshots, then Retry` };
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
    const fromForm = String(ob.form.meta_pixel_id ?? "").replace(/\D/g, "");
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

  /* 30 · Go live (the Funnels tab's "Go live", incl. the deposit URL). */
  funnel_live: async (svc, ob) => {
    const slug = ob.setup!.slug!;
    // Never go live with holes: the AI quotes these values to leads.
    const gaps = await preLiveGaps(ob.setup!.location_id);
    if (gaps.length) return { status: "failed", note: `NOT live yet — ${gaps.length} value${gaps.length > 1 ? "s" : ""} empty in the sub-account. Fill them (Clients tab or GHL Custom Values), then Retry:\n${gaps.map((g) => `✗ ${g}`).join("\n")}` };
    const { error } = await svc.from("onebox_clients").update({ status: "live", updated_at: now() }).eq("slug", slug);
    if (error) throw new Error(error.message);
    const url = `${FUNNEL_ORIGIN}/${slug}`;
    const dep = await setDepositFunnelUrl(ob.setup!.location_id, url);
    return { status: dep.ok ? "done" : "warn", note: `funnel LIVE at ${url}${dep.ok ? "" : ` · ⚠ deposit URL custom value: ${dep.error}`}` };
  },

  /* 36 · The Check-Setup grade on the finished account. */
  last_check: async (_svc, ob) => {
    const r = await verifyOnboarding({ ...ob.form, product_id: ob.setup!.product_id ?? ob.form.product_id }, { locationId: ob.setup!.location_id });
    const fails = r.checks.filter((c) => c.status === "fail");
    const pass = r.checks.filter((c) => c.status === "pass").length;
    if (!fails.length) return { status: "done", note: `all green — ${pass} checks passed` };
    return { status: "warn", note: `${pass} passed, ${fails.length} to fix:\n${fails.map((f) => `✗ ${f.key}: ${f.detail}`).join("\n")}` };
  },

  /* 37 · Move the client's deal to "First Cycle" in the agency pipeline, then
     the summary text goes out (see settle). */
  first_cycle: async (_svc, ob) => {
    const contactId = String(ob.form.master_contact_id ?? "").trim();
    if (!contactId) return { status: "warn", note: "no Contact ID on the Clients Master row — move the deal to First Cycle by hand" };
    const tok = await getAppLocationToken(MAIN_LOC);
    if (!tok.token) return { status: "warn", note: `agency token unavailable (${tok.error}) — move the deal to First Cycle by hand` };
    const H = { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" };
    const pipes = (await fetch(`${GHL}/opportunities/pipelines?locationId=${MAIN_LOC}`, { headers: H }).then((r) => r.json()).catch(() => ({}))) as { pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> };
    let target: { pipelineId: string; stageId: string; stageName: string } | null = null;
    for (const p of pipes.pipelines ?? []) for (const s of p.stages ?? []) if (/first\s*cycle/i.test(s.name) && !target) target = { pipelineId: p.id, stageId: s.id, stageName: s.name };
    if (!target) return { status: "warn", note: "no pipeline stage named \"First Cycle\" in the agency account — move the deal by hand" };
    const opps = (await fetch(`${GHL}/opportunities/search?location_id=${MAIN_LOC}&contact_id=${contactId}&limit=20`, { headers: H }).then((r) => r.json()).catch(() => ({}))) as { opportunities?: Array<{ id: string; name?: string; pipelineId: string; pipelineStageId: string }> };
    const opp = (opps.opportunities ?? []).find((o) => o.pipelineId === target!.pipelineId) ?? (opps.opportunities ?? [])[0];
    if (!opp) return { status: "warn", note: "the client has no deal in the agency pipeline — move it to First Cycle by hand" };
    if (opp.pipelineStageId === target.stageId) return { status: "done", note: `deal "${opp.name ?? ""}" already in ${target.stageName}` };
    const r = await fetch(`${GHL}/opportunities/${opp.id}`, { method: "PUT", headers: H, body: JSON.stringify({ pipelineId: target.pipelineId, pipelineStageId: target.stageId }) });
    if (!r.ok) return { status: "failed", note: `could not move the deal: HTTP ${r.status} ${(await r.text()).slice(0, 150)}` };
    return { status: "done", note: `deal "${opp.name ?? ""}" → ${target.stageName}` };
  },
};

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
    funnel_ig: ["funnel_create"], funnel_redirect: ["funnel_create"], funnel_test: ["funnel_create", "product"], last_profile: ["funnel_live"],
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
  const isAsk = next.who === "ask";
  const { data: ins, error } = await svc.from("agent_proposals").insert({
    conversation_id: setupConvId(onboardingId, next.key),
    message_id: `${next.key}#${attempt}`,
    contact_id: null,
    contact_name: ob.form.business_name.trim(),
    channel: null,
    client_message: miniContext(next, f),
    summary: `Setup step ${next.n}/38: ${next.label}`.slice(0, 500),
    action_type: "account_change",
    proposed_reply: null,
    action_detail: `${next.label}${next.how ? ` — ${next.how}` : ""}`.slice(0, 1500),
    action_plan: miniPlan(next, f).map((what) => ({ type: "manual", what })),
    location_id: setup.location_id,
    ...(isAsk ? {} : { status: "queued_browser", decided_by: `${DASHBOARD} (setup run)`, decided_at: now(), executed_at: now(), result: "⏳ Waiting for the Mac Mini (new client setup)" }),
  }).select("id").maybeSingle();
  if (error || !ins) {
    await patch(svc, onboardingId, (o) => { if (!o.setup) return; setStep(o.setup, next.key, { status: "failed", who: DASHBOARD, note: `could not queue the Mac Mini card: ${error?.message ?? "insert failed"}`, error: error?.message }); return { setup: o.setup }; });
    return;
  }
  const pid = (ins as { id: string }).id;
  await patch(svc, onboardingId, (o) => {
    if (!o.setup) return;
    setStep(o.setup, next.key, { status: isAsk ? "waiting_owner" : "queued", who: isAsk ? "You → Mac Mini" : "Mac Mini", proposal_id: pid, note: isAsk ? "waiting for your Approve in the AI tab" : "queued for the Mac Mini" }, `card ${pid} ${isAsk ? "pending (asks you)" : "queued"}`);
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

  await patch(svc, ref.onboardingId, (o) => {
    if (!o.setup) return;
    const cur = o.setup.steps[ref.key];
    if (cur?.proposal_id && cur.proposal_id !== p.id) return; // an older card for a retried step
    const status: StepState["status"] = ok ? "done" : "failed";
    setStep(o.setup, ref.key, { status, who: "Mac Mini", note: text.slice(0, 1500), screenshots: shots, error: ok ? undefined : (p.status === "needs_teammate" ? "the Mac Mini needs a teammate — see its note" : "the Mac Mini could not finish") }, `card ${p.id} → ${p.status}`);
    const checklist = { ...o.checklist };
    if (ok) tick(checklist, step.checklist, "Mac Mini");
    // Step 7: the payment route URL the Mini read off the workflow editor.
    if (ok && ref.key === "webhook_url") {
      const m = text.match(/https:\/\/(?:services|backend)\.leadconnectorhq\.com\/hooks\/[A-Za-z0-9/_-]+/);
      if (m && isValidHookUrlForLocation(m[0], o.setup.location_id)) o.setup.hook_url = m[0];
      else { setStep(o.setup, ref.key, { status: "failed", error: m ? "the URL the Mini reported belongs to another account" : "no webhook URL in the Mini's report", note: `${text.slice(0, 800)}\n✗ ${m ? "URL is for another location" : "no URL found in the report"} — Retry` }); }
    }
    return { setup: o.setup, checklist };
  });

  // Save the hook where the payment router and the funnel read it.
  const ob = await loadOb(svc, ref.onboardingId);
  if (ok && ref.key === "webhook_url" && ob.setup?.hook_url) {
    const notes: string[] = [];
    if (ob.setup.slug) {
      const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", ob.setup.slug).maybeSingle();
      const extras = { ...((row?.extras ?? {}) as Record<string, unknown>), fanbasisHookUrl: ob.setup.hook_url, paymentRouter: "yes" };
      await svc.from("onebox_clients").update({ extras }).eq("slug", ob.setup.slug);
      notes.push("saved on the funnel (payment routing ON)");
    }
    try {
      const cvs = await listLocationCustomValues(ob.setup.location_id);
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const cv = cvs.find((c) => norm(c.name).includes("fanbasiswebhookurl"));
      if (cv) { await setExistingCustomValue(ob.setup.location_id, cv.name, ob.setup.hook_url); notes.push(`→ "${cv.name}"`); }
      else notes.push('🔴 custom value "CC - Fanbasis Webhook URL" is missing — create it by hand');
    } catch (e) { notes.push(`✗ custom value: ${errMsg(e)}`); }
    await patch(svc, ref.onboardingId, (o) => { if (!o.setup) return; const st = o.setup.steps[ref.key]; setStep(o.setup, ref.key, { status: st.status, note: `${st.note ?? ""}\n${notes.join(" · ")}`.trim() }); return { setup: o.setup }; });
  }
  if (ok && ref.key === "webhook_url") await refreshCard(svc, ref.onboardingId);
  await advanceSetup(svc, ref.onboardingId).catch(() => undefined);
}

/* The Funnels card (onebox_clients.config) is a copy of the sub-account's
   custom values taken when the funnel was created — before steps 3/6/7/24
   filled them, so Sally's card showed Calendar ID, product ID and webhook
   URL empty (10/16/2026). Re-copy after each of those steps. */
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
    await svc.from("agent_proposals").update({ status: "denied", result: `skipped on the Onboarding card by ${by} — done by hand`, decided_by: by, decided_at: now() })
      .eq("id", cur.proposal_id).in("status", ["pending", "queued_browser"]);
  }
  await patch(svc, onboardingId, (o) => {
    if (!o.setup) return;
    setStep(o.setup, key, { status: "skipped", who: by, note: note?.trim() || "marked done by hand" }, `skipped by ${by}`);
    const checklist = { ...o.checklist };
    tick(checklist, step.checklist, by);
    if (o.setup.status !== "running") o.setup.status = "running";
    return { setup: o.setup, checklist };
  });
  return advanceSetup(svc, onboardingId);
}

// ── Overall status + the one text at the end ────────────────────────────────
async function settle(svc: Svc, onboardingId: string): Promise<void> {
  const ob = await loadOb(svc, onboardingId);
  const setup = ob.setup!;
  const steps = runSteps();
  const states = steps.map((s) => ({ s, st: stepState(setup, s.key) }));
  const failed = states.filter((x) => x.st.status === "failed");
  const waiting = states.filter((x) => x.st.status === "waiting_owner");
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
      `${byApi} steps by the dashboard, ${byMini} by the Mac Mini · ${setup.pool_name} → ${biz}`,
      setup.funnel_url ? `Funnel: ${setup.funnel_url}` : "",
      ...failed.map((x) => `✗ Step ${x.s.n} ${x.s.label}: ${(x.st.error ?? x.st.note ?? "failed").split("\n")[0].slice(0, 160)}`),
      ...warns.map((x) => `⚠ Step ${x.s.n} ${x.s.label}: ${(x.st.note ?? "").split("\n")[0].slice(0, 160)}`),
      nextStatus === "done" ? "Still yours: Facebook (steps 31–34) and the client's FB/IG connection." : `Open the card to Retry or Skip: ${dashboardUrl()}/onboarding?open=${onboardingId}`,
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
