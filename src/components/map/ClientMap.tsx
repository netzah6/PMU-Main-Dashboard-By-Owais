"use client";
import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type { ClientRecord } from "@/lib/types";

interface ClientMapProps {
  clients: ClientRecord[];
  // When set (from the search box), the map flies to this point.
  focus?: { lat: number; lng: number; zoom?: number } | null;
}

const STATUS_COLORS: Record<string, string> = {
  live: "#10b981",
  active: "#10b981",
  paused: "#f59e0b",
  lost: "#ef4444",
  default: "#64748b",
};

function getColor(status: string | undefined): string {
  return STATUS_COLORS[(status ?? "").toLowerCase()] ?? STATUS_COLORS.default;
}

export default function ClientMap({ clients, focus }: ClientMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<unknown>(null);
  // Synchronous guard prevents StrictMode double-invoke race on the async import
  const initializingRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !mapRef.current) return;
    if (mapInstanceRef.current || initializingRef.current) return;

    initializingRef.current = true;

    import("leaflet").then((L) => {
      // Guard again: cleanup may have run while the import was in-flight
      if (!mapRef.current || mapInstanceRef.current) {
        initializingRef.current = false;
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (L.Icon.Default.prototype as any)._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      });

      const map = L.map(mapRef.current!, {
        center: [39.5, -98.35],
        zoom: 4,
        zoomControl: true,
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: 18,
      }).addTo(map);

      mapInstanceRef.current = map;
      initializingRef.current = false;

      addMarkers(L, map, clients);
    });

    return () => {
      initializingRef.current = false;
      if (mapInstanceRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mapInstanceRef.current as any).remove();
        mapInstanceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fly to the searched address/ZIP when the focus point changes.
  useEffect(() => {
    if (!focus || !mapInstanceRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mapInstanceRef.current as any).flyTo([focus.lat, focus.lng], focus.zoom ?? 11, { duration: 1.2 });
  }, [focus]);

  // Re-render markers when clients data changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!mapInstanceRef.current || !clients.length) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = mapInstanceRef.current as any;
    import("leaflet").then((L) => {
      map.eachLayer((layer: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((layer as any) instanceof L.Marker) map.removeLayer(layer);
      });
      addMarkers(L, map, clients);
    });
  }, [clients]);

  return (
    <div className="flex flex-col h-full">
      <div ref={mapRef} className="flex-1 rounded-lg" style={{ minHeight: "500px" }} />
      <div className="flex items-center gap-4 p-3 border-t border-[#e4ebf2] text-xs text-[#697a91]">
        <span className="font-medium text-[#34568a]">Status:</span>
        {[
          { label: "Live", color: "#10b981" },
          { label: "Paused", color: "#f59e0b" },
          { label: "Lost", color: "#ef4444" },
          { label: "Unknown", color: "#64748b" },
        ].map(({ label, color }) => (
          <span key={label} className="flex items-center gap-1.5">
            <span style={{ background: color }} className="w-3 h-3 rounded-full inline-block" />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addMarkers(L: any, map: any, clients: ClientRecord[]) {
  const valid = clients.filter(
    (c) => c.lat && c.lng && !isNaN(parseFloat(String(c.lat))) && !isNaN(parseFloat(String(c.lng)))
  );

  if (valid.length === 0) {
    L.popup()
      .setLatLng([39.5, -98.35])
      .setContent('<div style="color:#697a91;padding:4px">No location data available</div>')
      .openOn(map);
    return;
  }

  valid.forEach((c) => {
    const lat = parseFloat(String(c.lat));
    const lng = parseFloat(String(c.lng));
    const color = getColor(String(c.status ?? ""));

    const icon = L.divIcon({
      className: "",
      html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 6px ${color}80;"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });

    L.marker([lat, lng], { icon }).addTo(map).bindPopup(
      `<div style="background:#ffffff;color:#1e2a3a;padding:8px 12px;border-radius:8px;min-width:160px;font-size:13px;">
        <strong style="color:#15B7AE">${c.business_name || "Unknown"}</strong><br/>
        <span style="color:#697a91">${c.owner_name || ""}</span><br/>
        <span style="margin-top:4px;display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;background:${color}30;color:${color}">${c.status || "—"}</span>
      </div>`,
      { className: "dark-popup" }
    );
  });
}
