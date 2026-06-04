"use client";
import { useState, useMemo } from "react";
import { Search, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
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
    <div className="flex flex-col h-full">
      {/* Stats bar */}
      <div className="px-3 py-2 bg-slate-800/60 border-b border-slate-700 flex gap-3 text-xs">
        <span className="text-emerald-400 font-medium">{statusCounts.live} Live</span>
        <span className="text-amber-400">{statusCounts.paused} Paused</span>
        <span className="text-red-400">{statusCounts.lost} Lost</span>
        <span className="text-slate-500 ml-auto">{clients.length} total</span>
      </div>

      {/* Search */}
      <div className="p-3 border-b border-slate-700 space-y-2">
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search clients…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-8 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-teal-500 transition-colors"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white">
              <X size={13} />
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="grid grid-cols-3 gap-1.5">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-xs text-slate-300 focus:outline-none focus:border-teal-500">
            <option value="All">All Status</option>
            {["Live", "Paused", "Lost", "Offboarded"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select value={assignedFilter} onChange={(e) => setAssignedFilter(e.target.value)}
            className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-xs text-slate-300 focus:outline-none focus:border-teal-500">
            {assignedOptions.map((o) => (
              <option key={o} value={o}>{o === "All" ? "All Assigned" : o}</option>
            ))}
          </select>
          <select value={mediaBuyerFilter} onChange={(e) => setMediaBuyerFilter(e.target.value)}
            className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-xs text-slate-300 focus:outline-none focus:border-teal-500">
            {mediaBuyerOptions.map((o) => (
              <option key={o} value={o}>{o === "All" ? "All Buyers" : o}</option>
            ))}
          </select>
        </div>

        {hasFilters && (
          <button onClick={() => { setSearch(""); setStatusFilter("All"); setAssignedFilter("All"); setMediaBuyerFilter("All"); }}
            className="text-xs text-teal-400 hover:text-teal-300 flex items-center gap-1">
            <X size={11} /> Clear filters ({filtered.length} showing)
          </button>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-slate-500 text-sm">No clients match filters</div>
        ) : (
          filtered.map((c, i) => {
            const id = String(c._id ?? c.row_number ?? i);
            const selected = selectedId === id;
            const status = String(c.status ?? "").toLowerCase();
            return (
              <button
                key={id}
                onClick={() => onSelect(c)}
                className={cn(
                  "w-full text-left px-3 py-3 border-b border-slate-700/40 hover:bg-slate-700/30 transition-colors",
                  selected && "bg-teal-900/20 border-l-[3px] border-l-teal-500"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white truncate leading-tight">
                      {c.business_name || "Unnamed"}
                    </p>
                    <p className="text-xs text-slate-400 truncate mt-0.5">
                      {c.owner_name || ""}
                    </p>
                    {(c.assigned || c.version) && (
                      <p className="text-xs text-slate-600 mt-0.5 truncate">
                        {[c.assigned, c.version].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="flex-shrink-0">
                    <Badge variant={
                      status === "live" ? "green" :
                      status === "paused" ? "yellow" :
                      status === "lost" ? "red" : "gray"
                    }>
                      {c.status || "—"}
                    </Badge>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
