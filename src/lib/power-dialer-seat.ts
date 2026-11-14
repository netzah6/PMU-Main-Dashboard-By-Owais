import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { SALES_ROLES, type UserRole } from "@/lib/types";

export const DIALER_SETTINGS_KEY = "power_dialer";
export type DialerSettings = { workflows?: Record<string, string> }; // GHL user id → workflow id

/** Who is asking, what lists they may see, and which GHL user they dial as. */
export async function dialerSeat(users: Array<{ id: string; name: string }>) {
  const auth = await getAuth();
  const role = (auth?.role ?? null) as UserRole | null;
  if (!auth || !role || !["admin", ...SALES_ROLES].includes(role)) return null;
  const svc = createServiceClient();
  const [{ data: me }, { data: st }] = await Promise.all([
    svc.from("user_roles").select("sales_name").eq("user_id", auth.userId).maybeSingle(),
    svc.from("app_settings").select("value").eq("key", DIALER_SETTINGS_KEY).maybeSingle(),
  ]);
  const salesName = String(me?.sales_name ?? "").trim().toLowerCase();
  // Sales seats dial as the GHL user whose name starts with their sales name
  // ("Jennifer" → Jennifer Roman). Admins pick who the list goes to.
  // Admins without a sales name match by email ("nicolas@…" → Nicolas Mizrahi).
  const key = salesName || String(auth.email ?? "").split("@")[0].toLowerCase();
  const ghlUser = key ? users.find((u) => u.name.toLowerCase().startsWith(key)) ?? null : null;
  const settings = (st?.value ?? {}) as DialerSettings;
  return {
    role,
    isAdmin: role === "admin",
    seesSetter: role === "admin" || role === "setter" || role === "sales",
    seesCloser: role === "admin" || role === "closer" || role === "sales",
    ghlUser,
    workflows: settings.workflows ?? {},
  };
}
