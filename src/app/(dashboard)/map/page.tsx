"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { normalizeClient } from "@/lib/normalizers";
import { createClient } from "@/lib/supabase/client";
import { Skeleton } from "@/components/ui/Skeleton";
import type { ClientRecord } from "@/lib/types";

const ADDRESS_KEY = "Location (Full adress)";

const ClientMap = dynamic(() => import("@/components/map/ClientMap"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-96">
      <Skeleton className="w-full h-96" />
    </div>
  ),
});

// Load all geocoded address → coordinate pairs from the geocode_cache table.
function useGeocodeCache() {
  const [coords, setCoords] = useState<Map<string, { lat: number; lng: number }>>(new Map());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const map = new Map<string, { lat: number; lng: number }>();
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("geocode_cache")
          .select("address, lat, lng")
          .not("lat", "is", null)
          .range(from, from + PAGE - 1);
        if (error || !data || data.length === 0) break;
        for (const r of data as { address: string; lat: number; lng: number }[]) {
          // Safety net: only keep coordinates within North America so a stray
          // geocode can never plot a client off-continent.
          if (
            r.lat != null && r.lng != null &&
            r.lat >= 18 && r.lat <= 72 && r.lng >= -170 && r.lng <= -52
          ) {
            map.set(r.address, { lat: r.lat, lng: r.lng });
          }
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
      setCoords(map);
      setLoaded(true);
    })();
  }, []);

  return { coords, loaded };
}

type StatusFilter = "all" | "live" | "paused";

export default function MapPage() {
  const { data: raw, loading } = useTableData<Record<string, unknown>>({ table: "clients_master" });
  const { coords, loaded: geoLoaded } = useGeocodeCache();
  const [filter, setFilter] = useState<StatusFilter>("all");

  // Resolve each client's coordinates from its address via the geocode cache.
  // The sheet's own lat/lng columns are unreliable, so we ignore them.
  const clients = useMemo(() => {
    return (raw.map(normalizeClient) as ClientRecord[]).map((c) => {
      const addr = String(c[ADDRESS_KEY] ?? "").trim();
      const hit = addr ? coords.get(addr) : undefined;
      return {
        ...c,
        lat: hit ? String(hit.lat) : "",
        lng: hit ? String(hit.lng) : "",
      };
    });
  }, [raw, coords]);

  const stats = {
    total: clients.length,
    live: clients.filter((c) => String(c.status ?? "").toLowerCase() === "live").length,
    paused: clients.filter((c) => String(c.status ?? "").toLowerCase() === "paused").length,
    lost: clients.filter((c) => String(c.status ?? "").toLowerCase() === "lost").length,
    mapped: clients.filter((c) => c.lat && c.lng).length,
  };

  // Apply the live/paused/total filter to what's plotted on the map
  const shown = useMemo(() => {
    if (filter === "all") return clients;
    return clients.filter((c) => String(c.status ?? "").toLowerCase() === filter);
  }, [clients, filter]);

  return (
    <div className="p-6 space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[#1f3559]">Client Map — USA</h1>
        {!loading && (
          <div className="flex gap-2 text-xs">
            <button onClick={() => setFilter("all")}
              className={`px-2 py-1 rounded border bg-white border-[#e4ebf2] text-[#34568a] transition-shadow ${filter === "all" ? "ring-2 ring-[#34568a] ring-offset-1" : "hover:bg-[#f1f5f9]"}`}>
              Total: <strong>{stats.total}</strong>
            </button>
            <button onClick={() => setFilter("live")}
              className={`px-2 py-1 rounded border bg-[#e6f7f5] border-[#a7e3df] text-[#0e8f88] transition-shadow ${filter === "live" ? "ring-2 ring-[#0e8f88] ring-offset-1" : "hover:brightness-95"}`}>
              Live: <strong>{stats.live}</strong>
            </button>
            <button onClick={() => setFilter("paused")}
              className={`px-2 py-1 rounded border bg-[#fff7ec] border-[#fcd9a8] text-[#d97706] transition-shadow ${filter === "paused" ? "ring-2 ring-[#d97706] ring-offset-1" : "hover:brightness-95"}`}>
              Paused: <strong>{stats.paused}</strong>
            </button>
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
        {loading || !geoLoaded ? (
          <Skeleton className="w-full h-full" />
        ) : (
          <ClientMap clients={shown} />
        )}
      </div>
    </div>
  );
}
