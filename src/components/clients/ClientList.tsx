"use client";
import { useState, useMemo } from "react";
import { Search, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn, userColor } from "@/lib/utils";
import type { ClientRecord } from "@/lib/types";

interface ClientListProps {
  clients: ClientRecord[];
  selectedId: string | null;
  onSelect: (client: ClientRecord) => void;
}

function uniqueSorted(clients: ClientRecord[], key: keyof ClientRecord) {
  const seen: Record<string, boolean> = {};
  return clients
    .map((c) => String(c[key] ?? ""))
    .filter((v) => v && !seen[v] && (seen[v] = true))
    .sort();
}

// Soft, deterministic avatar colors so the list reads bright and lively.
const AVATARS = [
  { bg: "#dff5f1", fg: "#0e8f88" },
  { bg: "#e3eefb", fg: "#185fa5" },
  { bg: "#efe9fd", fg: "#6d28d9" },
  { bg: "#fde9ef", fg: "#be123c" },
  { bg: "#fff1e0", fg: "#c2410c" },
  { bg: "#e9f6e3", fg: "#3b6d11" },
  { bg: "#fbeafc", fg: "#a21caf" },
];
function avatarFor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

export function ClientList({ clients, selectedId, onSelect }: ClientListProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [assignedFilter, setAssignedFilter] = useState("All");
  const [mediaBuyerFilter, setMediaBuyerFilter] = useState("All");

  const assignedOptions = useMemo(() => ["All", ...uniqueSorted(clients, "assigned")], [clients]);
  const mediaBuyerOptions = useMemo(() => ["All", ...uniqueSorted(clients, "media_buyer")], [clients]);

  const filtered = useMemo(() => {
    return clients.filter((c) => {
      const name = `${c.business_name ?? ""} ${c.owner_name ?? ""}`.toLowerCase();
      if (search && !name.includes(search.toLowerCase())) return false;
      if (statusFilter !== "All" && String(c.status ?? "").toLowerCase() !== statusFilter.toLowerCase()) return false;
      if (assignedFilter !== "All" && String(c.assigned ?? "") !== assignedFilter) return false;
      if (mediaBuyerFilter !== "All" && String(c.media_buyer ?? "") !== mediaBuyerFilter) return false;
      return true;
    });
  }, [clients, search, statusFilter, assignedFilter, mediaBuyerFilter]);

  const hasFilters = statusFilter !== "All" || assignedFilter !== "All" || mediaBuyerFilter !== "All" || search;

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { live: 0, paused: 0, lost: 0, offboarded: 0, other: 0 };
    clients.forEach((c) => {
      const s = String(c.status ?? "").toLowerCase();
      if (s === "live") counts.live++;
      else if (s === "paused") counts.paused++;
      else if (s === "lost") counts.lost++;
      else if (s === "offboarded") counts.offboarded++;
      else counts.other++;
    });
    return counts;
  }, [clients]);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Bright brand header + status chips */}
      <div className="px-2.5 py-1.5" style={{ background: "linear-gradient(135deg, #15B7AE 0%, #2f8f9e 55%, #34568a 100%)" }}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-semibold text-[13px] tracking-tight">Clients</h2>
            <span className="text-[10px] font-bold text-white bg-white/25 rounded-full px-1.5 py-0.5">{clients.length}</span>
          </div>
          <div className="flex items-center gap-2.5 text-[11px] font-medium text-white/90">
            <span><b className="text-white">{statusCounts.live}</b> Live</span>
            <span><b className="text-white">{statusCounts.paused}</b> Paused</span>
            <span><b className="text-white">{statusCounts.lost}</b> Lost</span>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="p-2 border-b border-[#e4ebf2] space-y-1.5 bg-[#f6fbfc]">
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#15B7AE]" />
          <input
            type="text"
            placeholder="Search clients…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-8 py-2 bg-white border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] shadow-sm focus:outline-none focus:border-[#15B7AE] focus:ring-2 focus:ring-[#15B7AE]/20 transition-colors"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#697a91] hover:text-[#1f3559]">
              <X size={13} />
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="grid grid-cols-3 gap-1.5">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2 py-1.5 bg-white border border-[#d7e0ea] rounded text-xs text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
            <option value="All">All Status</option>
            {["Live", "Paused", "Lost", "Offboarded"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select value={assignedFilter} onChange={(e) => setAssignedFilter(e.target.value)}
            className="px-2 py-1.5 bg-white border border-[#d7e0ea] rounded text-xs text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
            {assignedOptions.map((o) => (
              <option key={o} value={o}>{o === "All" ? "All Assigned" : o}</option>
            ))}
          </select>
          <select value={mediaBuyerFilter} onChange={(e) => setMediaBuyerFilter(e.target.value)}
            className="px-2 py-1.5 bg-white border border-[#d7e0ea] rounded text-xs text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
            {mediaBuyerOptions.map((o) => (
              <option key={o} value={o}>{o === "All" ? "All Buyers" : o}</option>
            ))}
          </select>
        </div>

        {hasFilters && (
          <button onClick={() => { setSearch(""); setStatusFilter("All"); setAssignedFilter("All"); setMediaBuyerFilter("All"); }}
            className="text-xs text-[#0e8f88] hover:text-[#0e8f88] flex items-center gap-1">
            <X size={11} /> Clear filters ({filtered.length} showing)
          </button>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-[#8595a8] text-sm">No clients match filters</div>
        ) : (
          filtered.map((c, i) => {
            const id = String(c._id ?? c.row_number ?? i);
            const selected = selectedId === id;
            const status = String(c.status ?? "").toLowerCase();
            const label = String(c.business_name || c.owner_name || "Unnamed");
            const av = avatarFor(label);
            const initial = label.trim().charAt(0).toUpperCase() || "?";
            return (
              <button
                key={id}
                onClick={() => onSelect(c)}
                className={cn(
                  "group w-full text-left flex items-center gap-2.5 px-2.5 py-2 border-b border-[#f1f5f9] transition-colors hover:bg-[#effbf9]",
                  selected ? "bg-[#e6f7f5] border-l-[3px] border-l-[#15B7AE] pl-[7px]" : "border-l-[3px] border-l-transparent"
                )}
              >
                <span className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold ring-1 ring-black/5"
                  style={{ background: av.bg, color: av.fg }}>
                  {initial}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-semibold text-[#1f3559] truncate leading-tight flex-1">
                      {c.business_name || "Unnamed"}
                    </p>
                    <Badge variant={
                      status === "live" ? "green" :
                      status === "paused" ? "yellow" :
                      status === "lost" ? "red" : "gray"
                    }>
                      {c.status || "—"}
                    </Badge>
                  </div>
                  <p className="text-xs text-[#697a91] truncate mt-0.5">
                    {c.owner_name || ""}
                  </p>
                  {(c.assigned || c.version) && (
                    <p className="text-xs mt-0.5 truncate">
                      {c.assigned && (
                        <span className="font-medium" style={{ color: userColor(String(c.assigned))?.text ?? "#a6b3c4" }}>
                          {String(c.assigned)}
                        </span>
                      )}
                      {c.assigned && c.version && <span className="text-[#a6b3c4]"> · </span>}
                      {c.version && <span className="text-[#a6b3c4]">{String(c.version)}</span>}
                    </p>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
