import { NextRequest, NextResponse } from "next/server";
import { isCollected } from "@/lib/ppa-collected";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getCoachScope } from "@/lib/coach";

export const maxDuration = 60;

// Recent billing: the service-fee money that actually went through, newest
// first, grouped by the day it was collected. Each day expands to show which
// clients made up that total (user request 2026-09-08).
//
// A charge row is one show. Rows sharing a Square payment id were collected in
// one transaction; rows with no payment id were recorded by hand. Both roll up
// per client, then per day.
//
// Admins see every client. A Client Success Coach sees only their own book.

const DEFAULT_DAYS = 120;

/** One billed show inside a client's charge: who it was, how much, how it came in. */
interface Show {
  name: string;
  amount: number;
  source: string;
}

/** Account credit that came off this charge, and which credit it was. */
interface CreditLine {
  amount: number;
  reason: string;
  approvedBy: string | null;
}

interface ClientLine {
  ownerKey: string;
  ownerName: string;
  coach: string;
  shows: number;
  /** Shows x fee, before any account credit. */
  gross: number;
  /** What the card was actually charged: gross minus credit. */
  total: number;
  creditApplied: number;
  credits: CreditLine[];
  chargedAt: string | null;
  chargedBy: string | null;
  manual: boolean;
  receiptUrl: string | null;
  paymentIds: string[];
  lines: Show[];
}

/**
 * Who each billed show was. An appt_id resolves against the table it came from
 * — a deposit row, a self-booked lead, a calendar appointment. Chat bookings
 * have no row of their own, but the charge note carries the name ("Square
 * <id> — Jane Doe"), which is also the backstop for anything else unmatched.
 */
async function resolveNames(
  svc: ReturnType<typeof createServiceClient>,
  apptIds: string[]
): Promise<Map<string, { name: string; source: string }>> {
  const out = new Map<string, { name: string; source: string }>();
  if (!apptIds.length) return out;

  const sources: Array<[string, string]> = [
    ["ppa_deposit_rows", "Deposit"],
    ["ppa_selfbooked", "Self-booked"],
    ["ppa_calendar_booked", "Calendar"],
  ];
  // Supabase caps a URL-encoded .in() list, so ask in batches.
  const CHUNK = 300;
  for (const [table, source] of sources) {
    for (let i = 0; i < apptIds.length; i += CHUNK) {
      const { data } = await svc
        .from(table)
        .select("appt_id, contact_name")
        .in("appt_id", apptIds.slice(i, i + CHUNK));
      for (const r of (data ?? []) as Array<{ appt_id: string; contact_name: string | null }>) {
        const name = String(r.contact_name ?? "").trim();
        // First table to claim an appt_id wins — deposits are the most
        // authoritative and are looked up first.
        if (name && !out.has(r.appt_id)) out.set(r.appt_id, { name, source });
      }
    }
  }
  return out;
}

/** "Square abc123 — Jane Doe" → "Jane Doe". */
function nameFromNote(note: string | null): string {
  const parts = String(note ?? "").split(" — ");
  return parts.length > 1 ? parts[parts.length - 1].trim() : "";
}

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") {
    return NextResponse.json({ error: "Coaches and admins only" }, { status: 403 });
  }

  const svc = createServiceClient();
  const requested = (req.nextUrl.searchParams.get("coach") ?? "").trim();
  const scope = await getCoachScope(svc, auth, requested);

  const days = Math.min(400, Math.max(7, Number(req.nextUrl.searchParams.get("days")) || DEFAULT_DAYS));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  let q = svc
    .from("ppa_charges")
    .select("appt_id, owner_key, amount, charged_at, charged_by, square_payment_id, note, charged, excluded")
    .eq("charged", true)
    .not("charged_at", "is", null)
    .gte("charged_at", since)
    .order("charged_at", { ascending: false });
  // A coach whose book is empty must see nothing, so answer without asking
  // Postgres at all rather than filtering on a list that cannot match.
  if (scope.ownerKeys && scope.ownerKeys.size === 0) {
    return NextResponse.json({
      scope: "coach", coach: scope.coach, coaches: scope.coaches,
      isAdmin: auth.role === "admin", days, runs: [],
    });
  }
  if (scope.ownerKeys) q = q.in("owner_key", [...scope.ownerKeys]);
  const { data, error } = await q.limit(5000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    appt_id: string; owner_key: string; amount: number | null; charged_at: string;
    charged_by: string | null; square_payment_id: string | null; note: string | null;
  };
  // Billed in chat but not paid yet is still in Ready, not a charge that
  // went through (same rule as every PPA screen).
  const rows = ((data ?? []) as Array<Row & { charged: boolean; excluded: boolean }>).filter((r) => isCollected(r));
  const nameBy = await resolveNames(svc, [...new Set(rows.map((r) => r.appt_id).filter(Boolean))]);

  // day → client → one line. The client key includes the payment id so two
  // separate transactions for the same client on the same day stay separate.
  const byDay = new Map<string, Map<string, ClientLine>>();
  for (const r of rows) {
    const day = String(r.charged_at).slice(0, 10);
    const lineKey = `${r.owner_key}|${r.square_payment_id ?? "manual"}`;
    const dayMap = byDay.get(day) ?? new Map<string, ClientLine>();
    const line = dayMap.get(lineKey) ?? {
      ownerKey: r.owner_key,
      // owner_key IS the owner's name lowercased, so it always reads as a
      // name even for a client who has since left the roster.
      ownerName: r.owner_key.replace(/\b[a-z]/g, (m) => m.toUpperCase()),
      coach: scope.coachByOwner.get(r.owner_key) ?? "",
      shows: 0,
      gross: 0,
      total: 0,
      creditApplied: 0,
      credits: [],
      chargedAt: r.charged_at,
      chargedBy: r.charged_by,
      manual: !r.square_payment_id,
      receiptUrl: r.square_payment_id ? `https://squareup.com/receipt/preview/${r.square_payment_id}` : null,
      paymentIds: r.square_payment_id ? [r.square_payment_id] : [],
      lines: [],
    };
    const hit = nameBy.get(r.appt_id);
    line.lines.push({
      name: hit?.name || nameFromNote(r.note) || "(name not recorded)",
      amount: Number(r.amount) || 0,
      // No table matched: a chat-detected booking if the id says so, otherwise
      // we simply don't know how it came in.
      source: hit?.source ?? (r.appt_id?.startsWith("chat:") ? "Chat" : ""),
    });
    line.shows++;
    line.gross += Number(r.amount) || 0;
    if (r.charged_at > (line.chargedAt ?? "")) line.chargedAt = r.charged_at;
    dayMap.set(lineKey, line);
    byDay.set(day, dayMap);
  }

  // Account credit that came off these charges. ppa_charges rows always carry
  // the GROSS per-show fee, so without this the panel would show $135 for a
  // client whose card was only charged $100.
  const allLines = [...byDay.values()].flatMap((m) => [...m.values()]);
  const { data: appData } = await svc
    .from("credit_applications")
    .select("owner_key, amount, square_payment_id, applied_at, client_credits(reason, decided_by)")
    .in("owner_key", [...new Set(allLines.map((l) => l.ownerKey)), " none"])
    .gte("applied_at", since);
  type AppRow = {
    owner_key: string; amount: number | null; square_payment_id: string | null; applied_at: string;
    // PostgREST types an embedded row as an array even on a to-one join.
    client_credits: Array<{ reason: string | null; decided_by: string | null }> | null;
  };
  // Same key the charge lines use: a credit-only settlement has no payment id,
  // which is exactly how its charge rows are grouped too.
  for (const a of (appData ?? []) as AppRow[]) {
    const key = `${String(a.applied_at).slice(0, 10)}|${a.owner_key}|${a.square_payment_id ?? "manual"}`;
    for (const [day, lines] of byDay) {
      for (const [lineKey, line] of lines) {
        if (`${day}|${lineKey}` !== key) continue;
        const amt = Number(a.amount) || 0;
        line.creditApplied += amt;
        line.credits.push({
          amount: amt,
          reason: a.client_credits?.[0]?.reason ?? "account credit",
          approvedBy: a.client_credits?.[0]?.decided_by ?? null,
        });
      }
    }
  }
  for (const line of allLines) line.total = Math.max(0, line.gross - line.creditApplied);

  const runs = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, lines]) => {
      const clients = [...lines.values()].sort((a, b) => b.total - a.total);
      for (const c of clients) c.lines.sort((a, b) => b.amount - a.amount);
      return {
        day,
        total: clients.reduce((t, c) => t + c.total, 0),
        gross: clients.reduce((t, c) => t + c.gross, 0),
        creditApplied: clients.reduce((t, c) => t + c.creditApplied, 0),
        shows: clients.reduce((t, c) => t + c.shows, 0),
        clientCount: new Set(clients.map((c) => c.ownerKey)).size,
        // A day where every line came from a card is an auto-charge run; a
        // mixed or all-manual day was worked by hand.
        manualOnly: clients.every((c) => c.manual),
        clients,
      };
    });

  return NextResponse.json({
    scope: scope.ownerKeys ? "coach" : "all",
    coach: scope.coach,
    coaches: scope.coaches,
    isAdmin: auth.role === "admin",
    days,
    runs,
  });
}
