import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { buildPortalView, portalOwnerByToken, type PortalView } from "@/lib/ppa-portal";

/* Client app (owner, 11/11/2026): the "PMU Bookings On Demand" app a client
   keeps on her phone — Home, Bookings, Leads, Billing. DEMO stage: opened by
   the same secret token as /my-billing (table ppa_portal_links); a real
   email sign-in replaces the token before any client gets it.

   Everything a client sees comes through here, so this file is where "what
   may a client see" is decided: her own leads' names, dates and status; her
   bookings; her billing. No lead emails or phones, no staff notes, no AI
   internals. */

export type AppLead = { name: string; at: string | null; state: "paid" | "booked" | "talking" };
export type AppData = { view: PortalView; leads: AppLead[]; leads30: number; booked30: number; paid30: number };

/** One load per request, shared by the layout and the page. */
export const loadApp = cache(async (token: string): Promise<AppData | null> => {
  const svc = createServiceClient();
  const ownerKey = await portalOwnerByToken(svc, token);
  if (!ownerKey) return null;
  const [view, { data: leadRows }] = await Promise.all([
    buildPortalView(svc, ownerKey).catch(() => null),
    svc.from("ghl_lead_status")
      .select("contact_name, date_added, booked, deposit_collected")
      .eq("owner_key", ownerKey).order("date_added", { ascending: false }).limit(300),
  ]);
  if (!view) return null;
  type Row = { contact_name: string | null; date_added: string | null; booked: boolean | null; deposit_collected: boolean | null };
  const rows = (leadRows ?? []) as Row[];
  const cut = Date.now() - 30 * 86_400_000;
  const recent = rows.filter((r) => r.date_added && new Date(r.date_added).getTime() >= cut);
  const state = (r: Row): AppLead["state"] => (r.deposit_collected ? "paid" : r.booked ? "booked" : "talking");
  return {
    view,
    leads: rows.slice(0, 60).map((r) => ({ name: (r.contact_name ?? "").trim() || "(no name)", at: r.date_added, state: state(r) })),
    leads30: recent.length,
    booked30: recent.filter((r) => r.booked || r.deposit_collected).length,
    paid30: recent.filter((r) => r.deposit_collected).length,
  };
});
