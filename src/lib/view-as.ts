import type { UserRole } from "@/lib/types";
import { SALES_ROLES } from "@/lib/types";

/* "View as" for the Sales tab (owner, 2026-10-12: previewing as a closer
   still showed every closer). The preview is client-side; the sales APIs
   check the REAL role, so an admin always got admin data. Now the client
   sends the preview with each sales request and the API — for admins only —
   trims the data exactly as it would for that seat. A closer seat needs a
   name (admins have no sales_name), so the preview also carries the closer
   being previewed. */
export const VIEW_AS_KEY = "pmu_view_as";
export const VIEW_AS_NAME_KEY = "pmu_view_as_name";
export const VIEW_AS_EVENT = "pmu-view-as";

export function viewAsHeaders(): Record<string, string> {
  try {
    const role = window.localStorage.getItem(VIEW_AS_KEY);
    if (!role || !(SALES_ROLES as string[]).includes(role)) return {};
    const name = window.localStorage.getItem(VIEW_AS_NAME_KEY) ?? "";
    return { "X-View-As": role, ...(name ? { "X-View-As-Name": name } : {}) };
  } catch { return {}; }
}

export function setViewAsName(name: string): void {
  try { if (name) window.localStorage.setItem(VIEW_AS_NAME_KEY, name); else window.localStorage.removeItem(VIEW_AS_NAME_KEY); } catch {}
  window.dispatchEvent(new Event(VIEW_AS_EVENT));
}

/* Server side: the seat to trim for. Only an admin may preview; everyone
   else is always their real role. */
export function effectiveSalesRole(realRole: string | null, headers: Headers): { role: string | null; previewName: string | null; previewing: boolean } {
  const want = headers.get("x-view-as");
  if (realRole === "admin" && want && (SALES_ROLES as string[]).includes(want)) {
    return { role: want as UserRole, previewName: (headers.get("x-view-as-name") ?? "").trim() || null, previewing: true };
  }
  return { role: realRole, previewName: null, previewing: false };
}
