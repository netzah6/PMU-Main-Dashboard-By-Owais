"use client";
import { useEffect, useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { useUser } from "@/lib/hooks/useUser";
import { createClient } from "@/lib/supabase/client";
import { ClientList } from "@/components/clients/ClientList";
import { ClientProfile } from "@/components/clients/ClientProfile";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  normalizeClient, normalizeDeposit, normalizeBooking,
  normalizeLead, normalizeCall, normalizePerformance, normalizeOwnerKey,
} from "@/lib/normalizers";
import type { ClientRecord, PaymentRecord } from "@/lib/types";

// Load the latest-month payments (keyed by normalized owner name) from the
// financing sheet snapshot in client_payments.
function usePayments() {
  const [map, setMap] = useState<Map<string, PaymentRecord>>(new Map());
  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data } = await supabase
        .from("client_payments")
        .select("owner_key, client_name, usd, payment_status, billing_status, pay_day, notes, month");
      if (!data) return;
      setMap(new Map((data as PaymentRecord[]).map((p) => [p.owner_key, p])));
    })();
  }, []);
  return map;
}

export default function ClientsPage() {
  const { role } = useUser();
  const { data: rawClients, loading: loadingClients } = useTableData<Record<string, unknown>>({
    table: "clients_master",
    realtimeEnabled: true,
  });
  const { data: rawDeposits } = useTableData<Record<string, unknown>>({ table: "deposits" });
  const { data: rawBookings } = useTableData<Record<string, unknown>>({ table: "bookings" });
  const { data: rawLeads } = useTableData<Record<string, unknown>>({ table: "leads_master" });
  const { data: rawCalls } = useTableData<Record<string, unknown>>({ table: "outgoing_calls" });
  const { data: rawPerformance } = useTableData<Record<string, unknown>>({ table: "performance_tracking" });

  const clients = useMemo(() => rawClients.map(normalizeClient) as ClientRecord[], [rawClients]);
  const deposits = useMemo(() => rawDeposits.map(normalizeDeposit), [rawDeposits]);
  const bookings = useMemo(() => rawBookings.map(normalizeBooking), [rawBookings]);
  const leads = useMemo(() => rawLeads.map(normalizeLead), [rawLeads]);
  const calls = useMemo(() => rawCalls.map(normalizeCall), [rawCalls]);
  const performance = useMemo(() => rawPerformance.map(normalizePerformance), [rawPerformance]);

  const payments = usePayments();
  const [selectedClient, setSelectedClient] = useState<ClientRecord | null>(null);

  const selectedPayment = useMemo(
    () => (selectedClient ? payments.get(normalizeOwnerKey(selectedClient.owner_name)) ?? null : null),
    [selectedClient, payments]
  );

  return (
    <div className="flex h-full">
      {/* Left Panel */}
      <div className="w-[22%] min-w-[200px] max-w-[300px] border-r border-[#e4ebf2] flex flex-col h-full">
        {loadingClients ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : (
          <ClientList
            clients={clients}
            selectedId={selectedClient
              ? String(selectedClient._id ?? selectedClient.row_number ?? "")
              : null}
            onSelect={setSelectedClient}
          />
        )}
      </div>

      {/* Right Panel — 70% */}
      <div className="flex-1 h-full overflow-hidden">
        {selectedClient ? (
          <ClientProfile
            key={String(selectedClient._id ?? selectedClient.business_name ?? Math.random())}
            client={selectedClient}
            role={role}
            deposits={deposits}
            bookings={bookings}
            leads={leads}
            calls={calls}
            performance={performance}
            payment={selectedPayment}
            onUpdate={(updated) => setSelectedClient(updated)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
              style={{ background: "#15B7AE20" }}
            >
              <span className="text-3xl" style={{ color: "#15B7AE" }}>P</span>
            </div>
            <p className="text-[#34568a] font-medium">Select a client</p>
            <p className="text-[#8595a8] text-sm mt-1">
              Choose a client from the list to view their profile
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
