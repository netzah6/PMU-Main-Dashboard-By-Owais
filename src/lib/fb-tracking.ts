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
   name"), read from Meta with the first token that reaches the dataset.
   Names rarely change → kept 6 hours per server instance (a failed read
   30 minutes). Never blocks the column: no name → the cell says "OK". */
const GRAPH = "https://graph.facebook.com/v21.0";
const nameCache = new Map<string, { at: number; name: string | null }>();
async function datasetName(px: string, tokens: string[]): Promise<string | null> {
  const hit = nameCache.get(px);
  if (hit && Date.now() - hit.at < (hit.name ? 6 * 3600_000 : 30 * 60_000)) return hit.name;
  let name: string | null = null;
  for (const t of tokens) {
    try {
      const r = await fetch(`${GRAPH}/${encodeURIComponent(px)}?fields=name&access_token=${encodeURIComponent(t)}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { name?: string };
      if (j.name?.trim()) { name = j.name.trim(); break; }
    } catch { /* next token */ }
  }
  nameCache.set(px, { at: Date.now(), name });
  return name;
}

export async function fbTrackingBySlug(svc: SupabaseClient): Promise<{ bySlug: Record<string, FbTrack>; nameBySlug: Record<string, string> }> {
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

  const names = new Map<string, string | null>();
  await Promise.all([...tokensByPx].map(async ([px, tokens]) => { names.set(px, await datasetName(px, tokens)); }));
  const nameBySlug: Record<string, string> = {};
  for (const [slug, px] of pxBySlug) { const n = names.get(px); if (n) nameBySlug[slug] = n; }
  return { bySlug: out, nameBySlug };
}
