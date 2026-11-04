import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findClientProgram, type ProgramRow } from "@/lib/client-program";
import { ONEBOX_ENGINE_V, liveEngineSrc } from "@/lib/onebox-engine";

// What the Freeze screen and the Timeline screen share on the server.

export const INTERNAL_FUNNELS = new Set(["demo-v3", "pmu-bookings", "pps"]);

/* Save today's engine file the first time anyone needs this version. It is read
   from the deployed file itself and has to name the version it claims. */
export async function ensureEngineCopy(svc: SupabaseClient, origin: string): Promise<string | null> {
  const { data: have, error: readError } = await svc.from("onebox_engine_copies").select("version").eq("version", ONEBOX_ENGINE_V).maybeSingle();
  if (readError) return readError.message;
  if (have) return null;
  const res = await fetch(new URL(liveEngineSrc, origin), { cache: "no-store" }).catch(() => null);
  const body = res?.ok ? await res.text() : "";
  if (!body.includes(`ENGINE_V = "${ONEBOX_ENGINE_V}"`)) return `Couldn't read page version ${ONEBOX_ENGINE_V}, nothing was frozen. Try again in a minute.`;
  const { error } = await svc.from("onebox_engine_copies").upsert(
    { version: ONEBOX_ENGINE_V, body, sha256: createHash("sha256").update(body).digest("hex") },
    { onConflict: "version", ignoreDuplicates: true },
  );
  return error ? error.message : null;
}

/* Why this funnel can't be locked right now, or null if it can. (V1) has no
   calendar or deposit, and a locked funnel always keeps the full page, so locking
   one would silently change it. Read fresh, not through fetchProgramRows: its
   memo is display-only and hides a failed read. */
export async function freezeBlockedReason(
  svc: SupabaseClient,
  client: { slug: string; client_name?: string | null; extras?: unknown },
): Promise<{ error: string; status: number } | null> {
  if ((client.extras as { template?: string } | null)?.template === "b2b" || INTERNAL_FUNNELS.has(client.slug)) {
    return { error: "Only client funnels can be frozen.", status: 400 };
  }
  const { data: programRows, error: programError } = await svc.from("client_program_rows").select("sheet_row, business_name, version, owner_name");
  if (programError) return { error: "Couldn't check this client's label. Try again.", status: 503 };
  if (findClientProgram((programRows ?? []) as ProgramRow[], String(client.client_name ?? ""))?.version === "(V1)") {
    return { error: "On (V1): survey only, so it can't be frozen. If the label is wrong, fix it first; that also changes the live page.", status: 409 };
  }
  const { data: running, error: runningError } = await svc.from("onebox_experiments").select("id, name").eq("slug", client.slug).eq("status", "running").limit(1);
  if (runningError) return { error: "Couldn't check for split tests. Try again.", status: 503 };
  if (running?.length) return { error: `A split test is running on this funnel (${running[0].name}). End it first.`, status: 409 };
  return null;
}
