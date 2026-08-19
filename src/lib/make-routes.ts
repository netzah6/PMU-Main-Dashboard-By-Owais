import { createServiceClient } from "@/lib/supabase/server";

// Read-only viewer for the "Fanbasis_Make.com_GHL" scenario. Pulls the
// blueprint via the Make API (a metadata read — consumes NO Make operations,
// runs nothing) and maps every router route to a client, so the 115-route
// scenario becomes a searchable table instead of an endless scroll.
//
// Nothing here writes to Make. Editing routes stays in the Make editor.

export interface RouteInfo {
  idx: number;               // 1-based position in the router — "route #"
  label: string;             // the filter's name, when the team named it
  filterText: string;        // human-readable filter values (what the route matches on)
  webhook: string | null;    // the GHL webhook URL the route posts to
  matchedBusiness: string | null; // client business matched from the filter text
  matchedStatus: string | null;   // that client's status in Clients Master
}

export interface MakeRoutesReport {
  scenarioName: string;
  scenarioId: string;
  zone: string;
  fetchedAt: string;
  routes: RouteInfo[];
  /** businesses that appear in MORE than one route — each extra fires twice per payment */
  duplicates: Array<{ business: string; routeIdxs: number[] }>;
  /** routes with no webhook URL inside — they match but post nowhere */
  noWebhook: number[];
  /** Live clients with no route at all — their deposits never reach the sheet */
  missingClients: string[];
  error?: string;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Collect the filter name and the literal values a route matches on.
 * Make stores the filter on the FIRST MODULE inside the route's flow (not on
 * the route object), so walk the whole route for every `filter` object and
 * harvest condition literals (skip `{{…}}` variable references).
 */
function filterStrings(route: Record<string, unknown>): { label: string; values: string[] } {
  const values: string[] = [];
  const labels: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      const flt = o.filter as Record<string, unknown> | undefined;
      if (flt) {
        if (typeof flt.name === "string" && flt.name.trim()) labels.push(flt.name.trim());
        const harvest = (c: unknown) => {
          if (Array.isArray(c)) { c.forEach(harvest); return; }
          if (c && typeof c === "object") {
            const cc = c as Record<string, unknown>;
            for (const k of ["a", "b"]) {
              const v = cc[k];
              if (typeof v === "string" && v.trim() && !v.includes("{{")) values.push(v.trim());
            }
          }
        };
        harvest(flt.conditions);
      }
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(route);
  return { label: labels[0] ?? "", values: [...new Set(values)] };
}

export async function buildMakeRoutesReport(): Promise<MakeRoutesReport> {
  const token = process.env.MAKE_API_TOKEN;
  const empty: MakeRoutesReport = {
    scenarioName: "", scenarioId: "", zone: "", fetchedAt: new Date().toISOString(),
    routes: [], duplicates: [], noWebhook: [], missingClients: [],
  };
  if (!token) return { ...empty, error: "MAKE_API_TOKEN is not configured in the environment." };

  const zones = process.env.MAKE_ZONE ? [process.env.MAKE_ZONE] : ["us1", "us2", "eu1", "eu2"];
  let zone = zones[0];
  const mk = async (path: string) => {
    const r = await fetch(`https://${zone}.make.com/api/v2${path}`, {
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
    });
    return { ok: r.ok, status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };

  // Find the scenario (same discovery as the onboarding check): pinned id via
  // env, else the fanbasis-named scenario whose blueprint actually has routes.
  let scenarioId = process.env.MAKE_SCENARIO_ID ?? "";
  let scenarioName = scenarioId ? `scenario ${scenarioId}` : "";
  const candidates: Array<{ id: string; name: string }> = [];
  if (!scenarioId) {
    for (const z of zones) {
      zone = z;
      const orgs = await mk(`/organizations`);
      const orgList = (orgs.json.organizations as Array<Record<string, unknown>> | undefined) ?? [];
      if (!orgs.ok || !orgList.length) continue;
      for (const o of orgList) {
        const teams = await mk(`/teams?organizationId=${o.id}`);
        for (const t of ((teams.json.teams as Array<Record<string, unknown>> | undefined) ?? [])) {
          const sc = await mk(`/scenarios?teamId=${t.id}`);
          for (const s of ((sc.json.scenarios as Array<Record<string, unknown>> | undefined) ?? [])) {
            if (/fanbasis/i.test(String(s.name ?? ""))) candidates.push({ id: String(s.id), name: String(s.name) });
          }
        }
      }
      if (candidates.length) break;
    }
    if (!candidates.length) return { ...empty, zone, error: "No Fanbasis scenario found via the Make API." };
  }

  // Pull blueprints until one has router routes (clones/backups have none).
  type RawRoute = Record<string, unknown>;
  let rawRoutes: RawRoute[] = [];
  for (const c of (scenarioId ? [{ id: scenarioId, name: scenarioName }] : candidates)) {
    const bp = await mk(`/scenarios/${c.id}/blueprint`);
    const blueprint = ((bp.json.response as Record<string, unknown> | undefined)?.blueprint ?? bp.json) as unknown;
    const found: RawRoute[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n && typeof n === "object") {
        const o = n as Record<string, unknown>;
        if (Array.isArray(o.routes)) for (const r of o.routes) found.push(r as RawRoute);
        for (const v of Object.values(o)) walk(v);
      }
    };
    walk(blueprint);
    if (found.length > rawRoutes.length) { rawRoutes = found; scenarioId = c.id; scenarioName = c.name; }
  }
  if (!rawRoutes.length) return { ...empty, zone, scenarioId, scenarioName, error: "Scenario found but no router routes in its blueprint." };

  // Clients Master for matching + the missing-clients cross-check.
  const svc = createServiceClient();
  const { data: cm } = await svc.from("clients_master").select("data");
  const clients = ((cm ?? []) as Array<{ data: Record<string, unknown> }>).map((r) => ({
    business: String(r.data?.["Business Name"] ?? "").trim(),
    owner: String(r.data?.["Owner Full Name"] ?? "").trim(),
    status: String(r.data?.["col_1"] ?? "").trim(),
    nb: norm(r.data?.["Business Name"]),
    no: norm(r.data?.["Owner Full Name"]),
  })).filter((c) => c.nb || c.no);

  const routes: RouteInfo[] = rawRoutes.map((r, i) => {
    const { label, values } = filterStrings(r);
    const raw = JSON.stringify(r);
    const hook = raw.match(/https:\\?\/\\?\/(?:services|backend)\.leadconnectorhq\.com\\?\/hooks\\?\/[A-Za-z0-9/_-]+/);
    // Match against the WHOLE route JSON — the same proven approach as the
    // Check-Setup detector. Filter literals alone miss routes that carry the
    // client name in a module label or URL instead of the filter.
    const blob = norm(raw);
    let matched: { business: string; status: string } | null = null;
    for (const c of clients) {
      if ((c.nb.length > 5 && blob.includes(c.nb)) || (c.no.length > 5 && blob.includes(c.no))) {
        matched = { business: c.business || c.owner, status: c.status };
        break;
      }
    }
    return {
      idx: i + 1,
      label,
      filterText: values.slice(0, 6).join(" · ") || label || "—",
      webhook: hook ? hook[0].replace(/\\\//g, "/") : null,
      matchedBusiness: matched?.business ?? null,
      matchedStatus: matched?.status ?? null,
    };
  });

  // Duplicates: same matched business on more than one route.
  const byBiz = new Map<string, number[]>();
  for (const r of routes) {
    if (!r.matchedBusiness) continue;
    const k = norm(r.matchedBusiness);
    if (!byBiz.has(k)) byBiz.set(k, []);
    byBiz.get(k)!.push(r.idx);
  }
  const duplicates = [...byBiz.entries()]
    .filter(([, idxs]) => idxs.length > 1)
    .map(([k, idxs]) => ({ business: routes.find((r) => norm(r.matchedBusiness ?? "") === k)?.matchedBusiness ?? k, routeIdxs: idxs }));

  const noWebhook = routes.filter((r) => !r.webhook).map((r) => r.idx);

  // Live clients with no route: deposits from their funnel never reach the sheet.
  const routedBiz = new Set(routes.filter((r) => r.matchedBusiness).map((r) => norm(r.matchedBusiness!)));
  const missingClients = clients
    .filter((c) => c.status === "Live" && c.nb && !routedBiz.has(c.nb))
    .map((c) => c.business)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();

  return { scenarioName, scenarioId, zone, fetchedAt: new Date().toISOString(), routes, duplicates, noWebhook, missingClients };
}

/** TEMP: first raw routes for blueprint-shape debugging. Removed before merge. */
export async function debugRawRoutes(): Promise<unknown> {
  const token = process.env.MAKE_API_TOKEN;
  if (!token) return { error: "no token" };
  const zones = process.env.MAKE_ZONE ? [process.env.MAKE_ZONE] : ["us1", "us2", "eu1", "eu2"];
  let zone = zones[0];
  const mk = async (path: string) => {
    const r = await fetch(`https://${zone}.make.com/api/v2${path}`, { headers: { Authorization: `Token ${token}`, Accept: "application/json" } });
    return { ok: r.ok, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const candidates: Array<{ id: string; name: string }> = [];
  for (const z of zones) {
    zone = z;
    const orgs = await mk(`/organizations`);
    const orgList = (orgs.json.organizations as Array<Record<string, unknown>> | undefined) ?? [];
    if (!orgs.ok || !orgList.length) continue;
    for (const o of orgList) {
      const teams = await mk(`/teams?organizationId=${o.id}`);
      for (const t of ((teams.json.teams as Array<Record<string, unknown>> | undefined) ?? [])) {
        const sc = await mk(`/scenarios?teamId=${t.id}`);
        for (const s of ((sc.json.scenarios as Array<Record<string, unknown>> | undefined) ?? []))
          if (/fanbasis/i.test(String(s.name ?? ""))) candidates.push({ id: String(s.id), name: String(s.name) });
      }
    }
    if (candidates.length) break;
  }
  const out: Record<string, unknown> = { zone, candidates };
  for (const c of candidates) {
    const bp = await mk(`/scenarios/${c.id}/blueprint`);
    const blueprint = ((bp.json.response as Record<string, unknown> | undefined)?.blueprint ?? bp.json) as unknown;
    const routes: unknown[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n && typeof n === "object") {
        const o = n as Record<string, unknown>;
        if (Array.isArray(o.routes)) for (const r of o.routes) routes.push(r);
        for (const v of Object.values(o)) walk(v);
      }
    };
    walk(blueprint);
    out[c.name] = { routeCount: routes.length, sample: JSON.stringify(routes[1] ?? routes[0] ?? null).slice(0, 4000) };
    if (routes.length) break;
  }
  return out;
}
