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
        <h1 className="text-lg font-semibold text-white">Client Map — USA</h1>
        {!loading && (
          <div className="flex gap-3 text-xs">
            <span className="px-2 py-1 bg-slate-800 rounded border border-slate-700 text-slate-300">
              Total: <strong>{stats.total}</strong>
            </span>
            <span className="px-2 py-1 bg-emerald-900/30 rounded border border-emerald-700 text-emerald-300">
              Live: <strong>{stats.live}</strong>
            </span>
            <span className="px-2 py-1 bg-amber-900/30 rounded border border-amber-700 text-amber-300">
              Paused: <strong>{stats.paused}</strong>
            </span>
            <span className="px-2 py-1 bg-red-900/30 rounded border border-red-700 text-red-300">
              Lost: <strong>{stats.lost}</strong>
            </span>
            <span className="px-2 py-1 bg-teal-900/30 rounded border border-teal-700 text-teal-300">
              Mapped: <strong>{stats.mapped}</strong>
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 border border-slate-700 rounded-xl overflow-hidden">
        {loading ? (
          <Skeleton className="w-full h-full" />
        ) : (
          <ClientMap clients={clients} />
        )}
      </div>
    </div>
  );
}
