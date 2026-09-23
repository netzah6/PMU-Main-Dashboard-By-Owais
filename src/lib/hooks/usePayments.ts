"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { normalizeOwnerKey } from "@/lib/normalizers";
import type { PaymentRecord } from "@/lib/types";

// Load the latest-month payments (keyed by normalized owner name) from the
// financing sheet snapshot in client_payments.
//
// The financing sheet writes names by hand, so a strict key lookup misses real
// clients over nothing: a middle initial ("Maria A Blanco" vs "Maria Blanco"),
// a first name only ("Alla"), a shared row ("Martin Aba / Alise Herrera"), or
// the master's name sitting in the sheet's parentheses ("Ah Ra Cho (Estee
// Cho)"). Ten LIVE clients were unmatched for exactly these reasons, which
// blanked their Price and Program. So three keys are registered per row —
// exact, parenthetical alias, and first+last — and the looser keys are only
// kept when they are UNAMBIGUOUS, so a wrong client is never shown someone
// else's billing.
//
// Lives here (not in the Clients page) because the Reports tab shows the same
// Program badge — one rule, so the two tabs can never disagree.
export function usePayments() {
  const [map, setMap] = useState<Map<string, PaymentRecord>>(new Map());
  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data } = await supabase
        .from("client_payments")
        .select("owner_key, client_name, usd, payment_status, billing_status, pay_day, notes, month");
      if (!data) return;
      const rows = data as PaymentRecord[];
      const exact = new Map<string, PaymentRecord>();
      // key -> rows that claim it; anything claimed twice is dropped.
      const loose = new Map<string, PaymentRecord[]>();
      const addLoose = (k: string, p: PaymentRecord) => {
        if (!k || exact.has(k)) return;
        loose.set(k, [...(loose.get(k) ?? []), p]);
      };
      const firstLast = (k: string) => {
        const parts = k.split(" ").filter(Boolean);
        return parts.length > 2 ? `${parts[0]} ${parts[parts.length - 1]}` : "";
      };
      for (const p of rows) exact.set(p.owner_key, p);
      for (const p of rows) {
        const name = String(p.client_name ?? "");
        for (const m of name.matchAll(/\(([^)]+)\)/g)) addLoose(normalizeOwnerKey(m[1]), p);
        // "Martin Aba / Alise Herrera" is one paid row covering two names.
        for (const part of name.split("/")) addLoose(normalizeOwnerKey(part), p);
        addLoose(firstLast(p.owner_key), p);
      }
      const merged = new Map(exact);
      for (const [k, hits] of loose) if (hits.length === 1) merged.set(k, hits[0]);
      setMap(merged);
    })();
  }, []);
  return map;
}

/** Find a client's financing-sheet row: exact owner key, then first+last. */
export function lookupPayment(
  payments: Map<string, PaymentRecord>, ownerName: unknown,
): PaymentRecord | null {
  const k = normalizeOwnerKey(ownerName);
  if (!k) return null;
  const parts = k.split(" ").filter(Boolean);
  const fl = parts.length > 2 ? `${parts[0]} ${parts[parts.length - 1]}` : "";
  return payments.get(k) ?? (fl ? payments.get(fl) ?? null : null);
}

// A PPS/PPA Payment Status in the financing sheet = PPS, any other row =
// Standard, no row = unknown (user request 2026-09-14).
export function programOf(pay: PaymentRecord | null | undefined): "PPS" | "Standard" | null {
  if (!pay) return null;
  const st = String(pay.payment_status ?? "").toLowerCase();
  return st.includes("pps") || st.includes("ppa") ? "PPS" : "Standard";
}
