import { createServiceClient } from "@/lib/supabase/server";
import { getV3Roster } from "@/lib/ppa";
import { buildClientDrill } from "@/lib/ppa-client-drill";

/* Client-facing "My Billing" page (owner, 11/11/2026): the artist sees her
   own pay-per-show billing live — who she owes for and how each was booked,
   every charge with its receipt, and her credit — so she doesn't have to ask
   "why was I charged?" / "who do I owe for?".

   Built from buildClientDrill(), the same code as the admin drill-down, so
   the numbers can't differ. This file decides what a CLIENT may see: names,
   dates, amounts, receipts, credit reasons. Never staff emails, internal
   notes, lead emails, void reasons or Square customer details. */

type Svc = ReturnType<typeof createServiceClient>;

const TOKEN_RE = /^[a-f0-9]{40,64}$/;
const READY = new Set(["served", "past_due", "self_booked", "calendar_booked", "chat_booked"]);

export type PortalShow = { name: string; date: string | null; how: string };
export type PortalPayment = {
  at: string | null; total: number; gross: number; credit: number;
  names: string[]; receiptUrl: string | null; creditOnly: boolean;
};
export type PortalView = {
  business: string; ownerName: string; fee: number; exempt: boolean;
  owed: { count: number; gross: number; credit: number; amount: number; shows: PortalShow[] };
  upcoming: PortalShow[];
  payments: PortalPayment[];
  paidTotal: number;
  creditLeft: number;
  credits: Array<{ amount: number; left: number; reason: string; at: string | null }>;
};

/** owner_key for a portal token, or null. Also counts the view. */
export async function portalOwnerByToken(svc: Svc, token: string): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { data } = await svc.from("ppa_portal_links").select("owner_key, views").eq("token", token).maybeSingle();
  if (!data) return null;
  void svc.from("ppa_portal_links")
    .update({ last_viewed_at: new Date().toISOString(), views: (Number(data.views) || 0) + 1 })
    .eq("owner_key", data.owner_key).then(() => {}, () => {});
  return data.owner_key as string;
}

export async function buildPortalView(svc: Svc, ownerKey: string): Promise<PortalView | null> {
  const client = (await getV3Roster()).find((c) => c.ownerKey === ownerKey);
  if (!client) return null;
  const [drill, { data: cfg }] = await Promise.all([
    buildClientDrill(svc, client),
    svc.from("ppa_config").select("billing_exempt").eq("owner_key", ownerKey).maybeSingle(),
  ]);
  const exempt = !!(cfg as { billing_exempt?: boolean } | null)?.billing_exempt;
  const fee = drill.client.fee;
  const nm = (a: { contactName: string | null }) => (a.contactName ?? "").trim() || "(no name)";

  // Same "ready" rule as the admin drill-down's Ready-to-charge box.
  const ready = exempt ? [] : drill.appointments.filter((a) => !a.charged && !a.excluded && !a.refunded && READY.has(a.chargeStatus));
  const gross = ready.length * fee;
  const credit = Math.min(drill.creditLeft, gross);

  return {
    business: client.business,
    ownerName: client.ownerName,
    fee,
    exempt,
    owed: {
      count: ready.length, gross, credit, amount: Math.max(0, gross - credit),
      shows: ready.map((a) => ({ name: nm(a), date: a.appointmentDate ?? a.depositDate ?? null, how: a.chargeStatus })),
    },
    upcoming: drill.appointments
      .filter((a) => a.chargeStatus === "upcoming" && !a.excluded && !a.refunded && !a.charged)
      .map((a) => ({ name: nm(a), date: a.appointmentDate, how: a.source === "calendar" ? "calendar_booked" : "served" })),
    payments: drill.payments.map((p) => ({
      at: p.chargedAt, total: p.total, gross: p.gross, credit: p.credit,
      names: p.contacts, receiptUrl: p.receiptUrl, creditOnly: p.creditOnly,
    })),
    paidTotal: Math.round(drill.payments.reduce((n, p) => n + p.total, 0) * 100) / 100,
    creditLeft: drill.creditLeft,
    credits: drill.credits.map((c) => ({ amount: c.amount, left: Math.max(0, c.amount - c.applied), reason: c.reason, at: c.approvedAt })),
  };
}
