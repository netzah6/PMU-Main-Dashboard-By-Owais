import type { createServiceClient } from "@/lib/supabase/server";
import { fileAlert } from "@/lib/alerts";
import { textOwner } from "@/lib/agent-notify";

type Svc = ReturnType<typeof createServiceClient>;

/* Mac Mini saved-login health (owner, 11/20/2026).
   On the night of 11/19 the Mini's Chrome lost its CloseBot and GoHighLevel
   sign-ins AND saved passwords; the owner only found out from the failed
   daily CloseBot check. The worker now reports, every hour while Chrome is
   closed, how many saved passwords and cookies its profile holds per site
   (counts only — never the values), whether the Keychain item Chrome uses
   to encrypt them exists, the Mac's boot time and the Chrome version.
   A saved CloseBot or GoHighLevel password going missing = alert + one text,
   the same hour, before any task fails. Back to normal = the alert closes. */

export type LoginHealth = {
  at?: string;
  passwords?: Record<string, number | null>;
  cookies?: Record<string, number | null>;
  keychainItem?: boolean;
  bootAt?: string | null;
  chrome?: string | null;
};

const KEY = "agent_logins";
const SITES: Record<string, string> = { closebot: "CloseBot", ghl: "GoHighLevel" };

export function loginProblems(h: LoginHealth): string[] {
  const out: string[] = [];
  if (h.keychainItem === false) out.push("Chrome's key in the Mac Keychain is missing, so Chrome cannot read its saved passwords");
  for (const [k, name] of Object.entries(SITES)) {
    const n = h.passwords?.[k];
    if (n === null || n === undefined) out.push(`could not read the saved ${name} password list`);
    else if (n === 0) out.push(`no saved ${name} password`);
  }
  return out;
}

export async function onLoginHealth(svc: Svc, raw: LoginHealth): Promise<void> {
  const h: LoginHealth = {
    at: new Date().toISOString(),
    passwords: raw.passwords ?? {}, cookies: raw.cookies ?? {},
    keychainItem: raw.keychainItem, bootAt: raw.bootAt ?? null, chrome: raw.chrome ? String(raw.chrome).slice(0, 40) : null,
  };
  const { data: prevRow } = await svc.from("app_settings").select("value").eq("key", KEY).maybeSingle();
  const prev = (prevRow?.value ?? null) as (LoginHealth & { changes?: string[] }) | null;
  // Keep a short log of what changed (reboot, Chrome update), to explain a future loss.
  const changes = [...(prev?.changes ?? [])];
  if (prev?.bootAt && h.bootAt && prev.bootAt !== h.bootAt) changes.push(`${h.at} Mac restarted (${h.bootAt})`);
  if (prev?.chrome && h.chrome && prev.chrome !== h.chrome) changes.push(`${h.at} Chrome ${prev.chrome} → ${h.chrome}`);
  const problems = loginProblems(h);
  await svc.from("app_settings").upsert({
    key: KEY, value: { ...h, problems, changes: changes.slice(-20) }, updated_by: "worker", updated_at: h.at,
  });

  if (!problems.length) {
    await svc.from("alerts").update({ status: "resolved", resolved_by: "system (Mac Mini logins OK again)", resolved_at: h.at })
      .eq("type", "agent_logins").eq("status", "open");
    return;
  }
  const filed = await fileAlert(svc, {
    type: "agent_logins", severity: "high", source_key: "mac-mini-logins", resurfaceAfterDays: 1,
    title: "Mac Mini lost a saved login",
    detail: `The Mac Mini's Chrome: ${problems.join("; ")}. Tasks that need that site will stop at its sign-in page. `
      + `On the Mini, in Terminal: node ~/.pmu-agent/agent-worker.mjs login → sign in to CloseBot and GoHighLevel and click "Save" when Chrome offers to save the password `
      + `(if a Keychain window asks, type the Mac password and click "Always Allow") → quit Chrome with Cmd+Q.`
      + (changes.length ? ` Recent changes on the Mini: ${changes.slice(-3).join("; ")}.` : ""),
    meta: { ...h, problems },
  });
  if (filed) {
    try { await textOwner(svc, `🔑 Mac Mini lost a saved login: ${problems.join("; ")}. On the Mini: Terminal → node ~/.pmu-agent/agent-worker.mjs login → sign in, save the password → Cmd+Q.`); }
    catch { /* the alert is on the board */ }
  }
}
