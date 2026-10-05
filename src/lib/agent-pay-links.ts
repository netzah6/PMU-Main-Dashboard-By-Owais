import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPaymentLink, squareConfigured } from "@/lib/square";
import { nk } from "@/lib/ceo-growth";
import type { PlanStep } from "@/lib/agent-exec";

/* Square one-time payment links for the AI agent (owner, 2026-10-05). A
   client texts "can you break it up into 100/150/150?" — the card plans the
   links, and Approve creates them on the agency's Square account and texts
   them. Creating a link charges nobody: the client pays when they open it.
   Every link is logged in agent_payment_links so the team can match the
   payment to the client later. */

type Svc = SupabaseClient;
export type LinkStep = Extract<PlanStep, { type: "payment_links" }>;

/* Thrown before anything was sent — the card stays approvable. */
export class NothingSentError extends Error {}

export type Billing = { ownerName: string; month: string; cents: number; status: string | null; email: string | null };
const isPaid = (status: string | null) => /\bpaid\b/i.test(status ?? "");

let payCache: { at: number; rows: Array<Record<string, unknown>> } | null = null;
let cmCache: { at: number; rows: Array<Record<string, unknown>> } | null = null;

/* What this client owes this month — the Financing sheet's latest month tab,
   mirrored into client_payments — plus their email to pre-fill checkout.
   EXACT matches only (the GHL contact's id on the Clients sheet, else the
   full name): a near-miss would put someone else's bill and email on the
   links. No match → no bill, and the AI asks a teammate instead. */
export async function billingFor(svc: Svc, contactName: string, contactId?: string | null): Promise<Billing | null> {
  if (!payCache || Date.now() - payCache.at > 5 * 60_000) {
    const { data } = await svc.from("client_payments").select("owner_key, client_name, usd, payment_status, month");
    payCache = { at: Date.now(), rows: (data ?? []) as Array<Record<string, unknown>> };
  }
  if (!cmCache || Date.now() - cmCache.at > 5 * 60_000) {
    const { data } = await svc.from("clients_master").select("data");
    cmCache = { at: Date.now(), rows: ((data ?? []) as Array<{ data: Record<string, unknown> }>).map((r) => r.data ?? {}) };
  }
  const byId = contactId ? cmCache.rows.filter((d) => String(d["Contact ID"] ?? "").trim() === contactId) : [];
  const cm = byId.length === 1 ? byId[0] : null;
  const key = nk(cm ? cm["Owner Full Name"] : contactName);
  if (!key) return null;
  const rows = payCache.rows.filter((r) => nk(r.owner_key) === key || nk(r.client_name) === key);
  if (rows.length !== 1) return null; // none, or two it could be — don't guess a bill
  const row = rows[0];
  const usd = Number(row.usd);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const ownerName = String(row.client_name ?? row.owner_key ?? contactName);
  const owner = cm ?? cmCache.rows.find((d) => nk(d["Owner Full Name"]) === nk(ownerName));
  const email = String(owner?.["Email"] ?? "").trim().toLowerCase() || null;
  return {
    ownerName,
    month: String(row.month ?? "").replace(/\s*V\d+\s*$/i, "").trim() || "this month",
    cents: Math.round(usd * 100),
    status: (row.payment_status as string | null) || null,
    email,
  };
}

export const billingLine = (b: Billing | null) =>
  b ? `${b.month} bill: $${(b.cents / 100).toLocaleString("en-US")}${isPaid(b.status) ? ` — ALREADY MARKED "${b.status}" (don't send a link for it unless they ask for one anyway)` : b.status ? ` (marked "${b.status}")` : " (not marked paid yet)"}` : "unknown — no bill found for this client";
export const billIsPaid = (b: Billing | null) => !!b && isPaid(b.status);

/* Create the links (same proposal + part + amount → the same Square link,
   so a retried Approve never makes duplicates) and log them. */
export async function createLinksForProposal(
  svc: Svc,
  p: { id: string; contact_id: string | null; contact_name: string },
  step: LinkStep,
  decidedBy: string,
): Promise<Array<{ amount_cents: number; url: string; id: string }>> {
  if (!squareConfigured()) throw new NothingSentError("Square isn't set up on the server (SQUARE_ACCESS_TOKEN) — nothing was sent");
  const billing = await billingFor(svc, p.contact_name, p.contact_id).catch(() => null);
  const n = step.amounts_cents.length;
  // Links an earlier (failed) Approve of this card already made, by part.
  const { data: made } = await svc.from("agent_payment_links").select("part, parts, amount_cents, label, url, square_link_id, square_order_id").eq("proposal_id", p.id);
  const out: Array<{ amount_cents: number; url: string; id: string; orderId: string | null }> = [];
  for (let i = 0; i < n; i++) {
    const cents = step.amounts_cents[i];
    const part = n > 1 ? ` (${i + 1} of ${n})` : "";
    const prior = (made ?? []).find((m) => m.part === i + 1 && m.parts === n && m.amount_cents === cents && m.label === step.label);
    if (prior?.url) { out.push({ amount_cents: cents, url: prior.url, id: String(prior.square_link_id ?? ""), orderId: prior.square_order_id ?? null }); continue; }
    const req = {
      name: `${step.label}${part}`,
      amountCents: cents,
      note: `${billing?.ownerName ?? p.contact_name} — ${step.label}${part} · sent by the AI agent`,
      buyerEmail: billing?.email ?? undefined,
    };
    try {
      const link = await createPaymentLink({
        ...req,
        // Everything Square sees is in the key: same request → same link; a changed one → a new key.
        idempotencyKey: crypto.createHash("sha256").update(JSON.stringify(["agent-link", p.id, i, n, req])).digest("hex"),
      });
      out.push({ amount_cents: cents, ...link });
    } catch (e) {
      throw new NothingSentError(`Square couldn't create payment link ${i + 1} of ${n}: ${e instanceof Error ? e.message : "error"} — nothing was sent`);
    }
  }
  const { error } = await svc.from("agent_payment_links").upsert(out.map((l, i) => ({
    proposal_id: p.id, part: i + 1, parts: n, contact_id: p.contact_id, contact_name: p.contact_name,
    owner_name: billing?.ownerName ?? null, label: step.label, amount_cents: l.amount_cents,
    url: l.url, square_link_id: l.id, square_order_id: l.orderId, created_by: decidedBy,
  })), { onConflict: "proposal_id,part" });
  if (error) console.error("agent_payment_links log failed:", error.message); // the links exist; the log is a convenience
  return out.map(({ amount_cents, url, id }) => ({ amount_cents, url, id }));
}
