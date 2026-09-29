import { createServiceClient } from "@/lib/supabase/server";

/* Dashboard payment routing — the replacement for the per-client router in
   the Make "Fanbasis_Make.com_GHL" scenario (one filter+HTTP route per
   client, ~115 and growing; every new client needed a hand-built route,
   and late joiners kept being missed).

   What a Make route actually does with a matched payment: POST the payload
   to that client's "FanBasis to GHL workflow" inbound webhook (a snapshot
   workflow published on every account: Find Contact by email -> tag
   "fanbasis buyer" -> fanbasis_* custom fields -> a GHL Webhook step that
   feeds the Deposits sheet). So replaying the SAME payload to the SAME
   inbound webhook is behavior-identical — including the sheet row, which
   is written downstream of the GHL workflow, not by the route itself.

   Per-client state lives in onebox_clients.extras (extras survives the
   5-minute CV resync; config does NOT — buildConfig replaces it wholesale):
     extras.fanbasisHookUrl — the client's own inbound-webhook URL
     extras.paymentRouter   — "yes" enables routing for this client
   The product-id -> client mapping needs no new setup: it is the
   config.fanbasisProductId the team already enters at Start Setup.

   Once-only guard: that downstream sheet row comes BACK to /api/webhooks
   through Make, and Make also retries timed-out executions — so replaying
   on every deposits POST would double-run client automations and could
   even loop (replay -> workflow -> sheet row -> /api/webhooks -> replay).
   deposits.routed_at is claimed atomically per external_id before any
   send, released only if the send fails, so each payment routes at most
   once no matter how many times its row is (re)delivered. */

/* Same character set the Make-blueprint extractor matches for these URLs
   (make-routes.ts): no dots or "@" past the fixed host, so neither
   userinfo tricks nor /../ traversal can survive validation. */
const HOOK_URL_RE = /^https:\/\/(services|backend)\.leadconnectorhq\.com\/hooks\/[A-Za-z0-9/_-]+$/;

export function isValidHookUrl(url: string): boolean {
  return HOOK_URL_RE.test(url.trim());
}

/* The stored hook must belong to the client's OWN sub-account: the URL path
   is /hooks/<locationId>/webhook-trigger/<id>, so a URL pointing anywhere
   else (another account, a pasted mix-up) is rejected at save time. */
export function isValidHookUrlForLocation(url: string, locationId: string): boolean {
  const u = url.trim();
  return isValidHookUrl(u) && !!locationId && u.includes(`/hooks/${locationId}/`);
}

/* The client's hook URL can live in two places: extras.fanbasisHookUrl
   (set by admin, survives everything) or the "CC - Fanbasis Webhook URL"
   custom value pasted at Start Setup (config mirror; required for V2.3/V3
   onboarding). Extras wins when both exist. */
export function clientHookUrl(config: Record<string, unknown> | null, extras: Record<string, unknown> | null): string {
  return (
    String((extras ?? {}).fanbasisHookUrl ?? "").trim() ||
    String((config ?? {}).fanbasisHookUrl ?? "").trim()
  );
}

/* Is this client on dashboard routing? Explicit extras.paymentRouter wins
   ("yes"/"no"); with no explicit flag, a valid own-location hook URL turns
   routing ON — that is how a NEW V2.3/V3 client is live the moment the
   team pastes the webhook URL at Start Setup, with no extra switch.
   (Existing clients with Make routes have no URL stored anywhere, so
   nothing changes for them until the fleet cutover writes one.) */
export function isDashboardRouted(
  config: Record<string, unknown> | null,
  extras: Record<string, unknown> | null,
  locationId: string
): boolean {
  const flag = String((extras ?? {}).paymentRouter ?? "");
  if (flag === "no") return false;
  if (flag === "yes") return true;
  return isValidHookUrlForLocation(clientHookUrl(config, extras), locationId);
}

/* The payment payload Make sends today (captured from a real request in the
   trigger's Mapping Reference — lowercase snake_case keys). The replay keeps
   exactly this shape so the workflow's field mappings keep resolving. */
export type ReplayPayload = {
  email: string;
  name: string;
  tag: string;
  fanbasis_payment_id: string;
  fanbasis_payment_status: string;
  fanbasis_product: string;
  fanbasis_total_price: string;
  fanbasis_currency: string;
};

const pick = (src: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
};

/* Accepts both key styles: the Commas/Make payment shape (email, name,
   fanbasis_*) and the sheet-style deposit shape ("Full Name", "Email",
   "Product ID", "Amount") that /api/webhooks already receives. */
export function buildReplayPayload(raw: Record<string, unknown>): ReplayPayload {
  const name =
    pick(raw, ["name", "Full Name", "full_name", "fullName", "contact_name", "customer_name"]) ||
    [pick(raw, ["first_name", "firstName"]), pick(raw, ["last_name", "lastName"])].filter(Boolean).join(" ");
  return {
    email: pick(raw, ["email", "Email", "contact_email", "customer_email"]),
    name,
    tag: "Fanbasis buyer",
    fanbasis_payment_id: pick(raw, ["fanbasis_payment_id", "payment_id", "transaction_id", "external_id"]),
    fanbasis_payment_status: pick(raw, ["fanbasis_payment_status", "payment_status"]) || "payment.succeeded",
    fanbasis_product: pick(raw, ["fanbasis_product", "Product ID", "product_id", "productId", "product"]),
    fanbasis_total_price: pick(raw, ["fanbasis_total_price", "total_price", "Amount", "amount"]).replace(/[^0-9.]/g, ""),
    fanbasis_currency: pick(raw, ["fanbasis_currency", "currency"]) || "USD",
  };
}

type ClientRow = {
  slug: string;
  client_name: string;
  location_id: string;
  status: string;
  config: Record<string, unknown> | null;
  extras: Record<string, unknown> | null;
};

export type RouteResult = {
  routed: boolean;
  /* skipped = expected non-action (no product id, no live client match, or
     the client's router flag is off); conflict/error/sent describe
     themselves. Every outcome for a payload that carried a product id is
     logged by the caller — silence only for rows that were never payments. */
  outcome: "sent" | "skipped" | "conflict" | "error";
  note: string;
  slug?: string;
};

/* Resolve the paying client by Fanbasis product id — server-side filter, so
   the query is index-friendly and immune to the PostgREST 1000-row cap. Only
   a LIVE client can receive a replay (paused rows include recycled/offboarded
   accounts — routing there would fire a stranger's automations). A product id
   matching more than one live client is a hard conflict: surface it and do
   nothing, never silently pick a side. */
export async function resolvePaymentClient(productId: string): Promise<
  { row: ClientRow } | { conflict: string } | { dbError: string } | { pausedOnly: string } | null
> {
  const pid = productId.trim();
  if (!pid) return null;
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("onebox_clients")
    .select("slug, client_name, location_id, status, config, extras")
    .filter("config->>fanbasisProductId", "eq", pid);
  if (error) return { dbError: error.message };
  const rows = (data ?? []) as ClientRow[];
  if (!rows.length) return null;
  const live = rows.filter((r) => r.status === "live");
  if (!live.length) return { pausedOnly: rows.map((r) => r.slug).join(", ") };
  if (live.length > 1) {
    return { conflict: `product ${pid} matches ${live.length} live clients: ${live.map((r) => r.slug).join(", ")}` };
  }
  return { row: live[0] };
}

/* POST the payment to the client's own "FanBasis to GHL workflow" inbound
   webhook — the exact call the Make route makes today. Bounded: a hung GHL
   endpoint must not pin the serverless function until its own timeout. */
export async function replayToClientHook(hookUrl: string, payload: ReplayPayload): Promise<{ ok: boolean; note: string }> {
  try {
    const r = await fetch(hookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ok: false, note: `hook ${r.status}: ${(await r.text().catch(() => "")).slice(0, 120)}` };
    return { ok: true, note: "replayed to GHL inbound webhook" };
  } catch (e) {
    return { ok: false, note: String(e).slice(0, 160) };
  }
}

/* Atomic once-only claim per payment, in its own table so it works for
   route-only payloads too (those never create a deposits row). INSERT with
   ON CONFLICT DO NOTHING semantics: the call that inserts the row wins; a
   re-delivered or loop-generated duplicate hits the primary key and loses. */
async function claimRouting(externalId: string): Promise<boolean> {
  const svc = createServiceClient();
  const { error } = await svc
    .from("payment_router_claims")
    .insert({ external_id: externalId });
  if (!error) return true;
  if (error.code === "23505") return false; // duplicate key = someone already routed it
  throw new Error(`claim failed: ${error.message}`);
}

/* A failed send releases the claim, so the next re-delivery (Make retries
   timed-out executions) gets another attempt instead of losing the payment. */
async function releaseRouting(externalId: string): Promise<void> {
  const svc = createServiceClient();
  await svc.from("payment_router_claims").delete().eq("external_id", externalId);
}

/* Fire-and-forget entry for the /api/webhooks intake: never throws, never
   blocks or fails the deposit ingest. Routes only when the client has
   opted in (extras.paymentRouter === "yes") AND has a stored hook URL —
   everyone else keeps flowing through their Make route untouched. */
export async function routeIncomingPayment(
  raw: Record<string, unknown>,
  opts: { externalId?: string } = {}
): Promise<RouteResult> {
  try {
    const payload = buildReplayPayload(raw);
    if (!payload.fanbasis_product) return { routed: false, outcome: "skipped", note: "no product id in payload" };
    if (!payload.email) return { routed: false, outcome: "skipped", note: `no email in payload (product ${payload.fanbasis_product})` };

    const resolved = await resolvePaymentClient(payload.fanbasis_product);
    if (!resolved) return { routed: false, outcome: "skipped", note: `no client matches product ${payload.fanbasis_product}` };
    if ("dbError" in resolved) return { routed: false, outcome: "error", note: `client lookup failed: ${resolved.dbError}` };
    if ("conflict" in resolved) return { routed: false, outcome: "conflict", note: resolved.conflict };
    if ("pausedOnly" in resolved) {
      return { routed: false, outcome: "skipped", note: `product ${payload.fanbasis_product} matches only non-live clients (${resolved.pausedOnly})` };
    }

    const { row } = resolved;
    const extras = (row.extras ?? {}) as Record<string, unknown>;
    if (!isDashboardRouted(row.config, extras, row.location_id)) {
      return { routed: false, outcome: "skipped", note: "router not enabled for this client", slug: row.slug };
    }
    const hookUrl = clientHookUrl(row.config, extras);
    if (!isValidHookUrlForLocation(hookUrl, row.location_id)) {
      // only reachable with an explicit paymentRouter="yes" but a bad/missing URL
      return { routed: false, outcome: "error", note: "router enabled but the webhook URL is missing, invalid, or not this client's location", slug: row.slug };
    }

    if (opts.externalId) {
      const won = await claimRouting(opts.externalId);
      if (!won) return { routed: false, outcome: "skipped", note: "already routed (re-delivery or duplicate)", slug: row.slug };
    }
    const sent = await replayToClientHook(hookUrl, payload);
    if (!sent.ok && opts.externalId) await releaseRouting(opts.externalId).catch(() => {});
    return { routed: sent.ok, outcome: sent.ok ? "sent" : "error", note: sent.note, slug: row.slug };
  } catch (e) {
    return { routed: false, outcome: "error", note: String(e).slice(0, 160) };
  }
}
