import type { SupabaseClient } from "@supabase/supabase-js";

// Pixel Checking — crawls a client's GHL funnel pages and reports which Meta
// pixel events actually FIRE on each step, checked against the desired
// structure: PageView on page 1, Lead on page 2 (booking), Schedule on page 3
// (deposit), Purchase on page 4 (thank-you).
//
// Execution rules (browser-proven 2026-08-31, see funnel_tracking_flags notes):
// GHL renders each page's tracking config into the __NUXT_DATA__ payload.
//  - funnel Settings head/body code and page-level header/footer code EXECUTE;
//  - custom-code ELEMENTS are innerHTML-injected: inline <script> NEVER runs,
//    but external <script src> (lead-pixel.js) loads, and <img> beacons load.
// A plain grep of the HTML gets this wrong in both directions.

export type PageAudit = {
  position: number | null; // 1 survey · 2 booking · 3 deposit · 4 thank-you; null = extra/duplicate page
  role: "survey" | "booking" | "deposit" | "thankyou";
  path: string;
  url: string;
  pixels: string[]; // fbq init ids that actually execute on this page
  events: Record<string, number>; // events that FIRE
  dead: Record<string, number>; // event code present but never executes
  sources: Record<string, string[]>;
  sched_snippet: boolean;
  extra: boolean;
};

export type Check = { ok: boolean; detail: string };
export type Checks = { pv1?: Check; lead2?: Check; sched3?: Check; purchase4?: Check };

export type PixelCheckRow = {
  location_id: string;
  business_name: string;
  owner_name: string | null;
  funnel_name: string | null;
  funnel_id: string | null;
  entry_url: string | null;
  pixel_ids: string[];
  pages: PageAudit[];
  checks: Checks;
  status: "ok" | "issues" | "blocked" | "unresolved";
  notes: string | null;
  audited_at: string;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";

// Attribution URLs that are NOT the client's GHL funnel.
const EXCLUDE_HOSTS = [
  "book.pmu-care.com", // one-box pages — different engine, audited elsewhere
  "link.apisystem.tech",
  "facebook.com",
  "instagram.com",
  "google.",
  "linktr",
  "api.leadconnectorhq",
  "msgsndr",
  "youtube",
  "wa.me",
  "bit.ly",
];

// One transient GHL hiccup must not silently drop a step from the audit
// (caught live 2026-09-01: a re-check lost the thank-you page and the checks
// shifted) — so retry once before giving up.
async function fetchPage(url: string, tries = 2): Promise<{ finalUrl: string; html: string } | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store", redirect: "follow" });
      if (res.ok) return { finalUrl: res.url, html: await res.text() };
    } catch {
      /* retry */
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

// ---------- __NUXT_DATA__ decoding (flat devalue array with index refs) ----------

function getNuxtData(html: string): unknown[] | null {
  const m = html.match(/<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>/);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf("</script>", start);
  if (end < 0) return null;
  try {
    const arr = JSON.parse(html.slice(start, end));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

const WRAPPERS = new Set(["ShallowReactive", "Reactive", "Ref", "ShallowRef", "EmptyRef", "EmptyShallowRef"]);

function resolve(arr: unknown[], idx: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (typeof idx !== "number" || idx < 0 || idx >= arr.length) return idx;
  const v = arr[idx];
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === "string" && WRAPPERS.has(v[0])) return resolve(arr, v[1], depth + 1);
    return v.map((i) => resolve(arr, i, depth + 1));
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, i] of Object.entries(v as Record<string, unknown>)) out[k] = resolve(arr, i, depth + 1);
    return out;
  }
  return v;
}

// ---------- per-page analysis ----------

const FBQ_RE = /fbq\s*\(\s*['"](init|track|trackCustom)['"]\s*,\s*['"]([^'"]+)/g;
const IMG_TR_RE = /facebook\.com\/tr\?([^"'\s>]+)/g;
const EXT_SCRIPT_RE = /<script[^>]*\bsrc=["']([^"']+)["']/i;

type RawAnalysis = {
  hasNuxt: boolean;
  inits: string[];
  fired: Record<string, number>;
  dead: Record<string, number>;
  sources: Record<string, string[]>;
  schedSnippet: boolean;
  role: PageAudit["role"];
};

// Container keys → bucket. "custom" buckets are innerHTML-injected elements.
const CODE_KEYS: Array<[string, string, boolean]> = [
  ["globalHeadTrackingCode", "head", true],
  ["globalBodyTrackingCode", "body", true],
  ["headerCode", "pageHead", true],
  ["footerCode", "pageFoot", true],
  ["customCode", "custom", false],
  ["rawCustomCode", "custom", false],
];

export function analyzePage(html: string): RawAnalysis {
  const arr = getNuxtData(html);
  const blobs: Array<{ bucket: string; executing: boolean; code: string }> = [];
  const seen = new Set<string>();
  if (arr) {
    for (const v of arr) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      for (const [key, bucket, executing] of CODE_KEYS) {
        if (!(key in (v as Record<string, unknown>))) continue;
        let r = resolve(arr, (v as Record<string, unknown>)[key]);
        if (r && typeof r === "object" && !Array.isArray(r) && "value" in (r as Record<string, unknown>))
          r = (r as Record<string, unknown>).value;
        if (typeof r !== "string" || !r.trim()) continue;
        if (!/fbq|facebook\.com\/tr|lead-pixel/.test(r)) continue;
        const dedupe = bucket + "\u0000" + r;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        blobs.push({ bucket, executing, code: r });
      }
    }
  }

  const inits = new Set<string>();
  const fired: Record<string, number> = {};
  const dead: Record<string, number> = {};
  const sources: Record<string, Set<string>> = {};
  let schedSnippet = false;
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const src = (ev: string, s: string) => (sources[ev] = sources[ev] ?? new Set()).add(s);

  for (const { bucket, executing, code } of blobs) {
    // The cc_sched Schedule snippet lives in funnel body code on every page but
    // self-gates on #fanbasis-checkout-wrapper — it only fires on the deposit page.
    if (code.includes("cc_sched") && code.includes("Schedule")) {
      schedSnippet = true;
      continue;
    }
    const stripped = code.replace(/<noscript>[\s\S]*?<\/noscript>/gi, "");
    for (const m of stripped.matchAll(FBQ_RE)) {
      const [, kind, val] = m;
      if (executing) {
        if (kind === "init") inits.add(val);
        else {
          bump(fired, val);
          src(val, bucket);
        }
      } else {
        bump(dead, kind === "init" ? "init:" + val : val);
      }
    }
    for (const m of stripped.matchAll(IMG_TR_RE)) {
      // <img> beacons load even via innerHTML.
      const q = new URLSearchParams(m[1].replace(/&amp;/g, "&"));
      const ev = q.get("ev") ?? "?";
      bump(fired, ev);
      src(ev, bucket + "-img");
      const id = q.get("id");
      if (id) inits.add(id);
    }
    const ext = stripped.match(EXT_SCRIPT_RE);
    if (ext && stripped.includes("lead-pixel")) {
      // lead-pixel.js: external script — loads even in custom-code elements,
      // fires one early Lead and swallows later duplicate Leads on the page.
      bump(fired, "Lead");
      src("Lead", "lead-pixel.js");
    }
  }

  let role: PageAudit["role"] = "thankyou";
  if (/id=["']fanbasis-checkout-wrapper/.test(html)) role = "deposit";
  else if (html.includes("c-calendar")) role = "booking";
  else if (html.includes("ghl-survey-form") || html.includes("csurvey-")) role = "survey";

  return {
    hasNuxt: !!arr,
    inits: [...inits].sort(),
    fired,
    dead,
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, [...v].sort()])),
    schedSnippet,
    role,
  };
}

function extractSteps(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/"\\u002F([A-Za-z0-9][A-Za-z0-9_-]*)"/g)) out.add(m[1]);
  return [...out].sort();
}

function funnelMeta(html: string): { funnelId: string | null; funnelName: string | null } {
  const arr = getNuxtData(html);
  if (!arr) return { funnelId: null, funnelName: null };
  for (const v of arr) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    if ("funnelName" in o || "funnelId" in o) {
      const name = "funnelName" in o ? resolve(arr, o.funnelName) : null;
      const id = "funnelId" in o ? resolve(arr, o.funnelId) : null;
      if (typeof name === "string" || typeof id === "string")
        return {
          funnelId: typeof id === "string" ? id : null,
          funnelName: typeof name === "string" ? name : null,
        };
    }
  }
  return { funnelId: null, funnelName: null };
}

// ---------- funnel-URL discovery (no funnels API scope needed) ----------
// Recent contacts carry the funnel page URL in raw.attributions[].url.

export async function discoverEntryUrl(svc: SupabaseClient, locationId: string): Promise<string | null> {
  const { data } = await svc
    .from("ghl_contacts")
    .select("date_added, raw->attributions")
    .eq("location_id", locationId)
    .order("date_added", { ascending: false })
    .limit(60);
  const latest: Record<string, string> = {};
  for (const row of (data ?? []) as Array<{ date_added: string; attributions: unknown }>) {
    const atts = Array.isArray(row.attributions) ? row.attributions : [];
    for (const a of atts as Array<{ url?: string }>) {
      const u = (a?.url ?? "").split("?")[0].replace(/\/$/, "");
      if (!u.startsWith("http")) continue;
      if (EXCLUDE_HOSTS.some((x) => u.includes(x))) continue;
      if (!latest[u] || row.date_added > latest[u]) latest[u] = row.date_added;
    }
  }
  const sorted = Object.entries(latest).sort((a, b) => (a[1] < b[1] ? 1 : -1));
  return sorted[0]?.[0] ?? null;
}

// ---------- the four structural checks ----------

const ROLE_POS: Record<PageAudit["role"], number> = { survey: 1, booking: 2, deposit: 3, thankyou: 4 };

function buildChecks(pages: PageAudit[]): { checks: Checks; status: PixelCheckRow["status"] } {
  const byRole = new Map<string, PageAudit>();
  for (const p of pages) if (!p.extra) byRole.set(p.role, p);
  const sv = byRole.get("survey");
  const bk = byRole.get("booking");
  const dp = byRole.get("deposit");
  const ty = byRole.get("thankyou");
  const checks: Checks = {};
  const mk = (ok: boolean, detail: string): Check => ({ ok, detail });

  if (!sv) checks.pv1 = mk(false, "No survey page found");
  else if (sv.events.PageView) checks.pv1 = mk(true, "PageView fires");
  else if (!sv.pixels.length) checks.pv1 = mk(false, "No pixel base on this page");
  else checks.pv1 = mk(false, "Pixel present but no PageView");

  const leadRoles = [...new Set(pages.filter((p) => p.events.Lead && p.pixels.length).map((p) => p.role))].sort();
  if (!bk) {
    checks.lead2 = mk(
      false,
      "No booking page (old funnel)" +
        (leadRoles.includes("thankyou")
          ? " — Lead fires on thank-you"
          : leadRoles.length
            ? ` — Lead fires on ${leadRoles.join(", ")}`
            : " — no Lead anywhere")
    );
  } else if (bk.events.Lead && bk.pixels.length) {
    const viaLp = (bk.sources.Lead ?? []).includes("lead-pixel.js");
    checks.lead2 = mk(true, `Lead fires (${viaLp ? "lead-pixel.js" : "header code"})`);
  } else if (bk.dead.Lead) {
    const others = leadRoles.filter((r) => r !== "booking");
    checks.lead2 = mk(
      false,
      "Lead code present but DEAD (inline custom-code)" + (others.length ? ` — live Lead only on ${others.join(", ")}` : "")
    );
  } else if (leadRoles.length) {
    checks.lead2 = mk(false, `No Lead here — fires on ${leadRoles.join(", ")} instead`);
  } else if (!bk.pixels.length) {
    checks.lead2 = mk(false, "No pixel base on this page");
  } else {
    checks.lead2 = mk(false, "No Lead event anywhere");
  }

  if (!dp) checks.sched3 = mk(false, "No deposit page (old funnel) — nothing to fire Schedule on");
  else if (dp.events.Schedule || (dp.sched_snippet && dp.pixels.length))
    checks.sched3 = mk(true, "Schedule fires (cc_sched snippet)");
  else if (dp.sched_snippet && !dp.pixels.length) checks.sched3 = mk(false, "Snippet installed but NO pixel base — cannot fire");
  else checks.sched3 = mk(false, "Schedule snippet not installed");

  const last = ty ?? dp ?? bk ?? sv;
  if (!last) checks.purchase4 = mk(false, "No thank-you page found");
  else if (last.events.Purchase) checks.purchase4 = mk(true, "Purchase fires");
  else checks.purchase4 = mk(false, "No Purchase event" + (ty ? "" : " (no thank-you page)"));

  const allPixels = pages.some((p) => p.pixels.length);
  const ok = [checks.pv1, checks.lead2, checks.sched3, checks.purchase4].every((c) => c?.ok);
  return { checks, status: ok ? "ok" : allPixels ? "issues" : "blocked" };
}

// ---------- full re-check of one client ----------

export async function auditClient(opts: {
  svc: SupabaseClient;
  locationId: string;
  businessName: string;
  ownerName: string | null;
  entryUrl?: string | null;
}): Promise<PixelCheckRow> {
  const { svc, locationId, businessName, ownerName } = opts;
  const base: PixelCheckRow = {
    location_id: locationId,
    business_name: businessName,
    owner_name: ownerName,
    funnel_name: null,
    funnel_id: null,
    entry_url: opts.entryUrl ?? null,
    pixel_ids: [],
    pages: [],
    checks: {},
    status: "unresolved",
    notes: null,
    audited_at: new Date().toISOString(),
  };

  let entry = opts.entryUrl ?? null;
  if (!entry) entry = await discoverEntryUrl(svc, locationId);
  if (!entry) {
    base.notes = "Could not find a live funnel URL (no usable contact attribution). Check the sub-account in GHL.";
    return base;
  }

  const entryPage = await fetchPage(entry);
  if (!entryPage || EXCLUDE_HOSTS.some((x) => entryPage.finalUrl.includes(x))) {
    base.entry_url = entry;
    base.notes = `Funnel entry URL did not load as a GHL page (${entry}). It may have been renamed or redirected.`;
    return base;
  }
  base.entry_url = entryPage.finalUrl.split("?")[0];
  const origin = new URL(base.entry_url).origin;
  const meta = funnelMeta(entryPage.html);
  base.funnel_name = meta.funnelName;
  base.funnel_id = meta.funnelId;

  const steps = extractSteps(entryPage.html).slice(0, 8);
  const audits: Array<{ path: string; a: RawAnalysis }> = [];
  const failed: string[] = [];
  for (const path of steps) {
    const pg = await fetchPage(`${origin}/${path}`);
    if (!pg) {
      failed.push(path);
      continue;
    }
    audits.push({ path, a: analyzePage(pg.html) });
  }
  if (!audits.length) {
    base.notes = "Funnel steps could not be crawled (all step pages failed to load). Try ↻ again.";
    return base;
  }
  if (failed.length)
    base.notes = `⚠ ${failed.length} step page(s) failed to load and are NOT reflected in the checks: /${failed.join(", /")}. Hit ↻ again for a complete pass.`;

  // canonical page per role = the copy that fires the most events (renamed
  // duplicates from GHL conflict-renames stay listed as extras)
  const best = new Map<string, { score: [number, number]; path: string; a: RawAnalysis }>();
  for (const { path, a } of audits) {
    const score: [number, number] = [Object.values(a.fired).reduce((s, n) => s + n, 0), -path.length];
    const cur = best.get(a.role);
    if (!cur || score[0] > cur.score[0] || (score[0] === cur.score[0] && score[1] > cur.score[1]))
      best.set(a.role, { score, path, a });
  }
  const pixelIds = new Set<string>();
  base.pages = audits
    .map(({ path, a }) => {
      a.inits.forEach((i) => pixelIds.add(i));
      const canonical = best.get(a.role)?.path === path;
      return {
        position: canonical ? ROLE_POS[a.role] : null,
        role: a.role,
        path,
        url: `${origin}/${path}`,
        pixels: a.inits,
        events: a.fired,
        dead: a.dead,
        sources: a.sources,
        sched_snippet: a.schedSnippet,
        extra: !canonical,
      };
    })
    .sort((x, y) => (x.position ?? 9) - (y.position ?? 9) || x.path.localeCompare(y.path));
  base.pixel_ids = [...pixelIds].sort();

  const { checks, status } = buildChecks(base.pages);
  base.checks = checks;
  base.status = status;
  return base;
}
