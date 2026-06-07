"use client";
import dynamic from "next/dynamic";
import { useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { normalizeClient } from "@/lib/normalizers";
import { Skeleton } from "@/components/ui/Skeleton";
import type { ClientRecord } from "@/lib/types";

const ClientMap = dynamic(() => import("@/components/map/ClientMap"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-96">
      <Skeleton className="w-full h-96" />
    </div>
  ),
});

export default function MapPage() {
  const { data: raw, loading } = useTableData<Record<string, unknown>>({ table: "clients_master" });
  const clients = useMemo(() => raw.map(normalizeClient) as ClientRecord[], [raw]);

  const stats = {
    total: clients.length,
    live: clients.filter((c) => String(c.status ?? "").toLowerCase() === "live").length,
    paused: clients.filter((c) => String(c.status ?? "").toLowerCase() === "paused").length,
    lost: clients.filter((c) => String(c.status ?? "").toLowerCase() === "lost").length,
    mapped: clients.filter((c) => c.lat && c.lng).length,
  };

  return (
    <div className="p-6 space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[#1f3559]">Client Map — USA</h1>
        {!loading && (
          <div className="flex gap-3 text-xs">
            <span className="px-2 py-1 bg-white rounded border border-[#e4ebf2] text-[#34568a]">
              Total: <strong>{stats.total}</strong>
            </span>
            <span className="px-2 py-1 bg-[#e6f7f5] rounded border border-[#a7e3df] text-[#0e8f88]">
              Live: <strong>{stats.live}</strong>
            </span>
            <span className="px-2 py-1 bg-[#fff7ec] rounded border border-[#fcd9a8] text-[#d97706]">
              Paused: <strong>{stats.paused}</strong>
            </span>
            <span className="px-2 py-1 bg-[#fde8ee] rounded border border-[#f5c2cf] text-[#e11d48]">
              Lost: <strong>{stats.lost}</strong>
            </span>
            <span className="px-2 py-1 bg-[#e6f7f5] rounded border border-[#a7e3df] text-[#0e8f88]">
              Mapped: <strong>{stats.mapped}</strong>
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 border border-[#e4ebf2] rounded-xl overflow-hidden">
        {loading ? (
          <Skeleton className="w-full h-full" />
        ) : (
          <ClientMap clients={clients} />
        )}
      </div>
    </div>
  );
}
