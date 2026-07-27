import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { squareConfigured, listDisputes, getPayment, getCustomers } from "@/lib/square";

export const maxDuration = 120;

// Chargebacks tab: live Square disputes, each auto-matched to a client and
// enriched with CRM delivery evidence + a ready-to-paste dispute statement
// (≤2,000 chars, Square's evidence-form limit). Admin only.

const READABLE_REASON: Record<string, string> = {
  PRODUCT_NOT_RECEIVED: "Goods/services not received",
  NOT_AS_DESCRIBED: "Not as described",
  NO_KNOWLEDGE: "Doesn't recognize the charge",
  CANCELLED: "Canceled recurring payment",
  DUPLICATE: "Duplicate charge",
  PAID_BY_OTHER_MEANS: "Paid by other means",
  CUSTOMER_REQUESTS_CREDIT: "Customer requests credit",
  AMOUNT_DIFFERS: "Amount differs",
  EMV_LIABILITY_SHIFT: "EMV liability shift",
};

function nameTokens(s: string): Set<string> {
  return new Set(String(s ?? "").toLowerCase().replace(/[^a-z]+/g, " ").split(" ").filter((t) => t.length >= 2));
}
function sameClient(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared >= 2 || (shared >= 1 && (a.size === 1 || b.size === 1));
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

function buildStatement(o: {
  amountCents: number; payDate: string | null; receipt: string | null;
  business: string; leads: number; booked: number; convos: number;
  firstLead: string | null; lastLead: string | null;
}): string {
  const s = [
    `TRANSACTION: The ${money(o.amountCents)} charge (${fmtDate(o.payDate)}${o.receipt ? `, receipt #${o.receipt}` : ""}) is a monthly installment of "PMU Success - 3 Months Plan," a 90-day marketing service program for the cardholder's business (${o.business}), per the signed Scope of Service (attached, with e-signature certificate): ad campaign creation & management, AI assistant, a CRM account for her business, custom booking pages, strategy calls, onboarding, and 1-on-1 coaching.`,
    `DELIVERY: Fully documented. Onboarding began at purchase, the cardholder attended a launch call, and the ad campaign went live on the agreed schedule ("after the launch call, ads go live"). Between ${fmtDate(o.firstLead)} and ${fmtDate(o.lastLead)}, ${o.leads} sales leads with full contact details were delivered into the CRM we provisioned for her${o.booked ? `; ${o.booked} of them booked appointments on her calendar` : ""}${o.convos ? `; ${o.convos} two-way conversations with those consumers are logged in her account` : ""}. Her custom booking pages remain live. Support continued through the dispute date — inside the 90-day term.`,
    `CONTEXT: The signed agreement makes all payments non-refundable, bars chargebacks during the term, makes converting leads the client's responsibility, and sets the sole remedy for any results shortfall as continued service at no additional fee. The attached CRM conversation logs document delivery and the cardholder's own acknowledgments of the service. Services were delivered immediately and measurably; we respectfully request resolution in the merchant's favor.`,
  ].join("\n\n");
  return s.length <= 2000 ? s : s.slice(0, 1997) + "…";
}

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (!squareConfigured()) {
    return NextResponse.json(
      { error: "Square is not configured — add SQUARE_ACCESS_TOKEN to the dashboard environment." },
      { status: 503 }
    );
  }

  try {
    const disputes = await listDisputes();
    // Newest first; open ones (evidence required) lead.
    const OPEN = new Set(["EVIDENCE_REQUIRED", "INQUIRY_EVIDENCE_REQUIRED"]);
    disputes.sort((a, b) => {
      const ao = OPEN.has(a.state) ? 0 : 1, bo = OPEN.has(b.state) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return String(b.reportedAt ?? "").localeCompare(String(a.reportedAt ?? ""));
    });

    // Payments (concurrency 6) → customers in one bulk call.
    const payments = new Map<string, Awaited<ReturnType<typeof getPayment>>>();
    for (let i = 0; i < disputes.length; i += 6) {
      await Promise.all(disputes.slice(i, i + 6).map(async (d) => {
        if (d.paymentId) payments.set(d.paymentId, await getPayment(d.paymentId));
      }));
    }
    const customerIds = Array.from(new Set(
      Array.from(payments.values()).map((p) => p?.customerId).filter(Boolean)
    )) as string[];
    const customers = await getCustomers(customerIds);

    // Client roster for matching + per-owner CRM stats.
    const svc = createServiceClient();
    const { data: cm } = await svc.from("clients_master").select("data");
    const roster = ((cm ?? []) as Array<{ data: Record<string, unknown> }>).map((r) => ({
      owner: String(r.data?.["Owner Full Name"] ?? "").trim(),
      business: String(r.data?.["Business Name"] ?? "").trim(),
      tokens: nameTokens(String(r.data?.["Owner Full Name"] ?? "")),
    })).filter((c) => c.owner);

    const enriched = [];
    for (const d of disputes) {
      const pay = d.paymentId ? payments.get(d.paymentId) ?? null : null;
      const customer = pay?.customerId ? customers.get(pay.customerId) ?? null : null;
      const holderName = customer?.name ?? "";
      const match = holderName ? roster.find((c) => sameClient(nameTokens(holderName), c.tokens)) ?? null : null;

      let stats = null;
      let statement = null;
      if (match) {
        const key = match.owner.toLowerCase();
        const [ls, cv] = await Promise.all([
          svc.from("ghl_lead_status").select("date_added, booked, offer_made, fanbasis").eq("owner_key", key),
          svc.from("ghl_conversations").select("id", { count: "exact", head: true }).eq("owner_key", key),
        ]);
        const rows = (ls.data ?? []) as Array<{ date_added: string | null; booked: boolean; offer_made: boolean; fanbasis: boolean }>;
        const dates = rows.map((r) => r.date_added).filter(Boolean).sort() as string[];
        stats = {
          leads: rows.length,
          booked: rows.filter((r) => r.booked).length,
          engaged: rows.filter((r) => r.offer_made).length,
          deposits: rows.filter((r) => r.fanbasis).length,
          conversations: cv.count ?? 0,
          firstLead: dates[0] ?? null,
          lastLead: dates[dates.length - 1] ?? null,
        };
        statement = buildStatement({
          amountCents: d.amountCents || pay?.amountCents || 0,
          payDate: pay?.createdAt ?? null,
          receipt: pay?.receiptNumber ?? null,
          business: match.business || match.owner,
          leads: stats.leads, booked: stats.booked, convos: stats.conversations,
          firstLead: stats.firstLead, lastLead: stats.lastLead,
        });
      }

      enriched.push({
        ...d,
        reasonLabel: READABLE_REASON[d.reason] ?? d.reason,
        open: OPEN.has(d.state),
        payment: pay ? { date: pay.createdAt, receipt: pay.receiptNumber, amountCents: pay.amountCents, last4: pay.cardLast4, buyerEmail: pay.buyerEmail } : null,
        cardholder: customer ? { name: customer.name, email: customer.email } : null,
        client: match ? { owner: match.owner, business: match.business } : null,
        stats,
        statement,
      });
    }

    return NextResponse.json({ disputes: enriched, count: enriched.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Square disputes failed" }, { status: 502 });
  }
}
