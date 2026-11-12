import type { SupabaseClient } from "@supabase/supabase-js";
import { capiTokens } from "@/lib/meta-capi";

/* Can Facebook's server link reach each one-box funnel's dataset?
   (owner, 11/11/2026: "mark which clients we don't have the data" — on the
   dashboard's Performance page, not the sheet.)

   Proof is Meta's own answer to our real sends, logged per event in
   capi_events: the newest decisive answer per dataset wins, so a client
   who later shares the dataset (or removes us) flips by itself on the
   next lead. Nothing is guessed — a dataset with no send since the tokens
   went live stays "unchecked". */

export type FbTrack = "ok" | "no_access" | "no_pixel" | "unchecked";

/* Token 1 went live 11/11/2026 00:45 UTC; an OK before that is impossible
   and a refusal from before every token was in place proves nothing. */
const TOKENS_SINCE = Date.parse("2026-11-11T00:45:00Z");
const WINDOW_MS = 21 * 864e5;
const REFUSED = /^\[no token reaches this dataset, tried (\d+)\]/;

/* Dataset names (owner, 11/11/2026: "instead of OK mention their dataset
   name"). Two sources, live first:
   1. Meta: GET /{dataset}?fields=name with the first token that reaches it.
      On 11/11 every read came back empty with our Events-Manager CAPI
      tokens (likely send-only; not proven), so each refusal's code and
      message is now kept (never the token) and returned as nameErrors.
      Read on v25.0: Marketing API v21.0 is past its end date for reads.
   2. app_settings "meta_dataset_names" = { datasetId: name }, copied from
      Events Manager by hand (owner OK 11/12/2026). A new dataset shows
      "OK" until its name is added there.
   Names rarely change → a Meta answer is kept 6 hours per server instance,
   a failed read 30 minutes. Never blocks the column. */
const GRAPH_READ = "https://graph.facebook.com/v25.0";
const NAMES_KEY = "meta_dataset_names";
type NameRead = { name: string | null; reasons: string[] };
/* Meta has echoed a malformed token inside its error text (code 190):
   strip every token we hold and anything token-shaped before keeping it. */
function redact(msg: string, tokens: string[]): string {
  let out = msg;
  for (const t of tokens) if (t) out = out.split(t).join("[token]");
  return out.replace(/EAA[A-Za-z0-9]{10,}/g, "[token]");
}
const NAME_DEADLINE_MS = 6000; // the column never waits longer for Meta; late answers still fill the cache
const nameCache = new Map<string, { at: number } & NameRead>();
async function datasetName(px: string, tokens: string[]): Promise<NameRead> {
  const hit = nameCache.get(px);
  if (hit && Date.now() - hit.at < (hit.name ? 6 * 3600_000 : 30 * 60_000)) return { name: hit.name, reasons: hit.reasons };
  let name: string | null = null;
  const reasons: string[] = [];
  for (const [i, t] of tokens.entries()) {
    try {
      const r = await fetch(`${GRAPH_READ}/${encodeURIComponent(px)}?fields=name&access_token=${encodeURIComponent(t)}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      const j = (await r.json().catch(() => ({}))) as { name?: string; error?: { code?: number; error_subcode?: number; message?: string } };
      if (r.ok && j.name?.trim()) { name = j.name.trim(); break; }
      const e = j.error;
      reasons.push(`token ${i + 1}: ${r.ok ? "no name in reply" : `HTTP ${r.status}${e ? ` code ${e.code ?? "?"}${e.error_subcode ? `/${e.error_subcode}` : ""} ${redact(String(e.message ?? ""), tokens).slice(0, 120)}` : ""}`}`);
    } catch (e) {
      reasons.push(`token ${i + 1}: ${e instanceof Error ? e.name : "error"}`);
    }
  }
  if (!name && reasons.length) console.warn("[fb-tracking] dataset name not readable", px, reasons.join(" | "));
  nameCache.set(px, { at: Date.now(), name, reasons });
  return { name, reasons };
}

export async function fbTrackingBySlug(svc: SupabaseClient): Promise<{ bySlug: Record<string, FbTrack>; nameBySlug: Record<string, string>; nameErrors: Record<string, string[]> }> {
  const { data: clients, error: cErr } = await svc.from("onebox_clients")
    .select("slug, status, config, extras").neq("status", "draft");
  if (cErr) throw new Error(cErr.message);

  const since = new Date(Math.max(TOKENS_SINCE, Date.now() - WINDOW_MS)).toISOString();
  type Row = { pixel_id: string | null; ok: boolean; error: string | null };
  const latest = new Map<string, FbTrack>();
  const tokenCount = capiTokens({}).length;
  for (let i = 0; ; i += 1000) {
    const { data, error } = await svc.from("capi_events").select("pixel_id, ok, error")
      .gte("created_at", since).order("id", { ascending: false }).range(i, i + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Row[]) {
      const px = (r.pixel_id ?? "").replace(/\D/g, "");
      if (!px || latest.has(px)) continue;
      if (r.ok) { latest.set(px, "ok"); continue; }
      /* Only "every token refused" counts — a refusal logged while fewer
         tokens were set up (tried 1 or 2) may be reachable now. Skips such
         as "no event id from browser" are not an answer from Meta. */
      const m = REFUSED.exec(r.error ?? "");
      if (m && tokenCount > 0 && Number(m[1]) >= tokenCount) latest.set(px, "no_access");
    }
    if (!data || data.length < 1000) break;
  }

  const out: Record<string, FbTrack> = {};
  const tokensByPx = new Map<string, string[]>(); // the funnel's own token first, then the agency ones
  const pxBySlug = new Map<string, string>();
  for (const c of (clients ?? []) as Array<{ slug: string; config: { metaPixelId?: string } | null; extras: { metaPixelId?: string; template?: string; capiToken?: string } | null }>) {
    if (c.extras?.template === "b2b") continue; // the agency's own funnel, not a client's ads
    const px = String(c.config?.metaPixelId || c.extras?.metaPixelId || "").replace(/\D/g, "");
    out[c.slug] = !px ? "no_pixel" : latest.get(px) ?? "unchecked";
    if (out[c.slug] === "ok") {
      pxBySlug.set(c.slug, px);
      if (!tokensByPx.has(px)) tokensByPx.set(px, capiTokens(c.extras));
    }
  }

  const { data: saved, error: sErr } = await svc.from("app_settings").select("value").eq("key", NAMES_KEY).maybeSingle();
  if (sErr) console.warn("[fb-tracking] stored dataset names not readable:", sErr.message);
  const stored = (saved?.value ?? {}) as Record<string, unknown>;
  const names = new Map<string, string | null>();
  const nameErrors: Record<string, string[]> = {};
  await Promise.all([...tokensByPx].map(async ([px, tokens]) => {
    const read = await Promise.race([
      datasetName(px, tokens),
      new Promise<NameRead>((res) => setTimeout(() => res({ name: null, reasons: ["Meta read still running"] }), NAME_DEADLINE_MS)),
    ]);
    const fallback = typeof stored[px] === "string" ? String(stored[px]).trim() : "";
    names.set(px, read.name ?? (fallback || null));
    if (!read.name && read.reasons.length) nameErrors[px] = read.reasons;
  }));
  const nameBySlug: Record<string, string> = {};
  for (const [slug, px] of pxBySlug) { const n = names.get(px); if (n) nameBySlug[slug] = n; }
  return { bySlug: out, nameBySlug, nameErrors };
}
