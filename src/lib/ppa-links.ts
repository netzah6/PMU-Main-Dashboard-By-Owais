import { createServiceClient } from "@/lib/supabase/server";
import { deletePaymentLink, getPaidLinkOrders } from "@/lib/square";

/* ── PPA payment links that mark themselves paid (owner, 11/10/2026) ─────────
   A link from the PPA Billing tab used to move money without marking a single
   show, so the shows stayed "Ready" and the Monday auto-charge / decline
   retries could collect them a second time (Brittanie Lee, 11/02 + 11/09).

   Now every link is stored with its Square ORDER id and the exact shows it
   covers. settleOpenLinks() asks Square about those order ids only — never a
   name or amount — so a retainer, deposit or subscription payment can never
   be read as a PPA payment. It runs every 10 minutes and right before any card
   charge, so a link paid a minute ago is seen before the card is touched.

   Safety rules (from an adversarial review of the first draft):
   - A link is always for the FULL fee of its shows. Account credit is never
     used in a link, so it can't be spent twice; it stays for the next card
     charge.
   - Any owner whose link Square shows as paid OR pending but that we could not
     record (busy, error, bank still processing) is HELD: the three card paths
     (manual Charge, Monday auto-charge, decline retries) must not charge them
     this time. See holdOwners().
   - Before a link is cancelled (card charged, or admin click) it is deleted in
     Square FIRST, then Square is asked once more whether it was paid in the
     meantime. If yes → "paid_review", never a silent "cancelled".
   - Money in for shows that were already charged or voided is NOT turned into
     credit (owner rule 11/09: credits are a human decision); the link goes to
     "paid_review" and shows on the client's row. */

export type LinkShow = { appt_id: string; name: string | null };

export interface OpenLinkInfo {
  id: number;
  url: string;
  amount: number;
  shows: LinkShow[];
  createdAt: string;
  status: string;
  reviewNote: string | null;
}

type LinkRow = {
  id: number; owner_key: string; square_link_id: string; square_order_id: string;
  amount_cents: number; fee: number; shows: LinkShow[]; status: string; updated_at: string;
};

const STALE_MS = 15 * 60_000;

export async function recordPaymentLink(args: {
  ownerKey: string; squareLinkId: string; squareOrderId: string; url: string;
  amountCents: number; fee: number; shows: LinkShow[]; createdBy: string;
}): Promise<string | null> {
  const svc = createServiceClient();
  const { error } = await svc.from("ppa_payment_links").insert({
    owner_key: args.ownerKey, square_link_id: args.squareLinkId, square_order_id: args.squareOrderId,
    url: args.url, amount_cents: args.amountCents, fee: args.fee, shows: args.shows,
    status: "open", created_by: args.createdBy,
  });
  return error ? error.message : null;
}

export type SettleResult = {
  linkId: number;
  ownerKey: string;
  /** paid / paid_review = recorded. pending / busy / error = money is (or may
   *  be) in but NOT recorded yet — the owner must not be charged now. */
  status: "paid" | "paid_review" | "pending" | "busy" | "error";
  marked: number;
  detail: string;
};

/** Owners the card paths must leave alone this run: a link of theirs was just
 *  recorded (their bill changed) or is paid/pending but not recorded. */
export function holdOwners(results: SettleResult[]): Set<string> {
  return new Set(results.map((r) => r.ownerKey));
}

/** Mark the shows of every PAID open link (one client, or everyone). Throws
 *  when Square can't answer — callers then charge nobody. */
export async function settleOpenLinks(ownerKey?: string): Promise<SettleResult[]> {
  const svc = createServiceClient();
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  let q = svc.from("ppa_payment_links")
    .select("id, owner_key, square_link_id, square_order_id, amount_cents, fee, shows, status, updated_at")
    // A run that died mid-way leaves "settling"; pick it up again after 15 min.
    .or(`status.eq.open,status.eq.settling`);
  if (ownerKey) q = q.eq("owner_key", ownerKey);
  const { data, error } = await q;
  if (error) throw new Error(`payment links read failed: ${error.message}`);
  const links = (data ?? []) as LinkRow[];
  if (!links.length) return [];

  const orders = await getPaidLinkOrders(links.map((l) => l.square_order_id));
  const results: SettleResult[] = [];

  for (const link of links) {
    const o = orders.get(link.square_order_id);
    const fresh = link.status === "settling" && link.updated_at >= staleBefore;
    // Another run is recording this link right now: hold the owner.
    if (fresh) { results.push({ linkId: link.id, ownerKey: link.owner_key, status: "busy", marked: 0, detail: "Link is being recorded by another run." }); continue; }
    if (!o) {
      if (link.status === "settling") {
        // Died before Square said paid — just reopen it.
        await svc.from("ppa_payment_links").update({ status: "open", updated_at: new Date().toISOString() }).eq("id", link.id).eq("status", "settling");
      }
      continue;
    }
    if (o.state === "pending") {
      results.push({ linkId: link.id, ownerKey: link.owner_key, status: "pending", marked: 0, detail: "She paid the link but the bank is still processing it." });
      continue;
    }
    const now = new Date().toISOString();

    // Claim the link so two runs (cron + a charge click) can't both record it.
    let claim = svc.from("ppa_payment_links").update({ status: "settling", updated_at: now }).eq("id", link.id).eq("status", link.status);
    if (link.status === "settling") claim = claim.lt("updated_at", staleBefore);
    const { data: claimed } = await claim.select("id");
    if (!claimed?.length) { results.push({ linkId: link.id, ownerKey: link.owner_key, status: "busy", marked: 0, detail: "Link is being recorded by another run." }); continue; }

    const ids = link.shows.map((s) => s.appt_id);
    const { data: existing, error: exErr } = await svc.from("ppa_charges")
      .select("appt_id, charged, excluded, square_payment_id").in("appt_id", ids);
    if (exErr) {
      await svc.from("ppa_payment_links").update({ status: "open", last_error: exErr.message.slice(0, 500), updated_at: now }).eq("id", link.id);
      results.push({ linkId: link.id, ownerKey: link.owner_key, status: "error", marked: 0, detail: exErr.message });
      continue;
    }
    // A show already carrying THIS payment was marked by an earlier run of
    // this same link (it died before finishing) — that is not a conflict.
    const taken = new Set(((existing ?? []) as Array<{ appt_id: string; charged: boolean; excluded: boolean; square_payment_id: string | null }>)
      .filter((r) => (r.charged || r.excluded) && r.square_payment_id !== o.paymentId).map((r) => r.appt_id));
    const free = link.shows.filter((s) => !taken.has(s.appt_id));
    const paidAt = o.paidAt ?? now;

    if (free.length) {
      const { error: upErr } = await svc.from("ppa_charges").upsert(
        free.map((s) => ({
          appt_id: s.appt_id, owner_key: link.owner_key, charged: true, amount: link.fee,
          charged_at: paidAt, charged_by: "payment link", square_payment_id: o.paymentId,
          note: `Paid by link · Square ${o.paymentId}${s.name ? ` — ${s.name}` : ""}`,
          excluded: false, exclude_reason: null, updated_at: now,
        })),
        { onConflict: "appt_id" },
      );
      if (upErr) {
        // Put it back so the next run tries again; the owner stays held.
        await svc.from("ppa_payment_links").update({ status: "open", last_error: upErr.message.slice(0, 500), updated_at: now }).eq("id", link.id);
        results.push({ linkId: link.id, ownerKey: link.owner_key, status: "error", marked: 0, detail: upErr.message });
        continue;
      }
    }

    const paidDollars = (o.amountCents / 100).toFixed(2);
    const amountOff = o.amountCents !== link.amount_cents;
    const review = taken.size > 0 || amountOff;
    const reviewNote = review
      ? [
          taken.size > 0 && `${taken.size} of ${link.shows.length} show${link.shows.length === 1 ? " was" : "s were"} already charged or voided before the link was paid (${link.shows.filter((s) => taken.has(s.appt_id)).map((s) => s.name ?? s.appt_id).join(", ")}).`,
          amountOff && `Square shows $${paidDollars} paid, the link was for $${(link.amount_cents / 100).toFixed(2)}.`,
          "Check by hand — no credit was added.",
        ].filter(Boolean).join(" ")
      : null;
    await svc.from("ppa_payment_links").update({
      status: review ? "paid_review" : "paid", square_payment_id: o.paymentId, paid_at: paidAt,
      review_note: reviewNote, last_error: null, updated_at: now,
    }).eq("id", link.id);
    results.push({
      linkId: link.id, ownerKey: link.owner_key, status: review ? "paid_review" : "paid", marked: free.length,
      detail: reviewNote ?? `$${paidDollars} paid by link — ${free.length} show${free.length === 1 ? "" : "s"} marked charged`,
    });
  }
  return results;
}

/** Take a link out of use: delete it in Square FIRST, then ask Square whether
 *  it got paid before the delete landed. Returns what happened. */
async function retireLink(svc: ReturnType<typeof createServiceClient>, l: { id: number; square_link_id: string; square_order_id: string },
  why: string): Promise<"cancelled" | "paid_review" | "not_deleted"> {
  const now = new Date().toISOString();
  const gone = await deletePaymentLink(l.square_link_id).catch(() => false);
  if (!gone) {
    await svc.from("ppa_payment_links").update({ last_error: "Could not delete the link in Square", updated_at: now }).eq("id", l.id);
    return "not_deleted";
  }
  let paid: { state: string; paymentId: string } | undefined;
  try { paid = (await getPaidLinkOrders([l.square_order_id])).get(l.square_order_id); }
  catch { paid = { state: "unknown", paymentId: "" }; }
  if (paid) {
    await svc.from("ppa_payment_links").update({
      status: "paid_review", square_payment_id: paid.paymentId || null,
      review_note: `${why} — but Square shows this link ${paid.state === "unknown" ? "could not be checked" : `was paid too (${paid.state})`}. Possible double payment: check by hand.`,
      updated_at: now,
    }).eq("id", l.id);
    return "paid_review";
  }
  await svc.from("ppa_payment_links").update({ status: "cancelled", review_note: why, updated_at: now }).eq("id", l.id);
  return "cancelled";
}

/** Shows were just charged another way (card / credit): retire any open link
 *  that covers them, so the client can't pay the same shows twice. Returns a
 *  warning for the admin when something needs a human. */
export async function closeLinksForShows(ownerKey: string, apptIds: string[]): Promise<string | null> {
  if (!apptIds.length) return null;
  const svc = createServiceClient();
  const { data } = await svc.from("ppa_payment_links")
    .select("id, square_link_id, square_order_id, shows").eq("owner_key", ownerKey).eq("status", "open");
  const charged = new Set(apptIds);
  const warnings: string[] = [];
  for (const l of (data ?? []) as Array<{ id: number; square_link_id: string; square_order_id: string; shows: LinkShow[] }>) {
    if (!l.shows.some((s) => charged.has(s.appt_id))) continue;
    const r = await retireLink(svc, l, "Shows were charged on the card — link deleted in Square");
    if (r === "not_deleted") warnings.push("An open payment link for these shows could not be deleted in Square — if she pays it too, the dashboard will flag it for review.");
    if (r === "paid_review") warnings.push("She ALSO paid the payment link for these shows — flagged on her row, check by hand.");
  }
  return warnings.length ? warnings.join(" ") : null;
}

/** Admin "cancel this link" click. */
export async function cancelLink(linkId: number, by: string): Promise<"cancelled" | "paid_review" | "not_deleted"> {
  const svc = createServiceClient();
  const { data: l } = await svc.from("ppa_payment_links").select("id, square_link_id, square_order_id").eq("id", linkId).maybeSingle();
  if (!l) return "not_deleted";
  return retireLink(svc, l as { id: number; square_link_id: string; square_order_id: string }, `Cancelled by ${by}`);
}

/** Open and needs-review links per client, for the billing row. */
export async function linksByOwner(ownerKeys: string[]): Promise<Map<string, OpenLinkInfo[]>> {
  const out = new Map<string, OpenLinkInfo[]>();
  if (!ownerKeys.length) return out;
  const svc = createServiceClient();
  const { data } = await svc.from("ppa_payment_links")
    .select("id, owner_key, url, amount_cents, shows, created_at, status, review_note")
    .in("owner_key", ownerKeys).in("status", ["open", "settling", "paid_review"]);
  for (const r of (data ?? []) as Array<{ id: number; owner_key: string; url: string; amount_cents: number; shows: LinkShow[]; created_at: string; status: string; review_note: string | null }>) {
    const list = out.get(r.owner_key) ?? [];
    list.push({ id: r.id, url: r.url, amount: r.amount_cents / 100, shows: r.shows, createdAt: r.created_at, status: r.status, reviewNote: r.review_note });
    out.set(r.owner_key, list);
  }
  return out;
}
