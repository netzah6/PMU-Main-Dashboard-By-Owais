"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, ExternalLink, Receipt } from "lucide-react";
import { cn } from "@/lib/utils";

// Recent billing — the service-fee money that actually went through, one line
// per day. Open a day to see which clients made up that total, what each was
// charged, how many shows it covered and the Square receipt.
//
// Server-scoped: an admin gets every client, a Client Success Coach gets only
// their own book.

type ClientLine = {
  ownerKey: string; ownerName: string; coach: string;
  shows: number; total: number; chargedAt: string | null; chargedBy: string | null;
  manual: boolean; receiptUrl: string | null;
};
type Run = {
  day: string; total: number; shows: number; clientCount: number;
  manualOnly: boolean; clients: ClientLine[];
};

const money = (n: number) => `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function fmtDay(day: string) {
  // Parsed as midday so the calendar date can't slip a day in a west-of-UTC
  // timezone.
  const d = new Date(`${day}T12:00:00`);
  return isNaN(d.getTime())
    ? day
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export function RecentBilling({ coach, refreshKey }: { coach?: string; refreshKey?: number }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/ppa/payments${coach ? `?coach=${encodeURIComponent(coach)}` : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load billing history");
      setRuns((j.runs as Run[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load billing history");
    } finally {
      setLoading(false);
    }
  }, [coach]);

  // Only fetched once the panel is opened — it is a long history nobody needs
  // on every page load.
  useEffect(() => { if (open) load(); }, [open, load]);
  // A charge elsewhere on the page invalidates what is already showing.
  useEffect(() => { if (open && refreshKey) load(); }, [refreshKey, open, load]);

  const total = (runs ?? []).reduce((t, r) => t + r.total, 0);

  return (
    <div className="rounded-xl border border-[#c7edd4] bg-[#f4fbf7]">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <Receipt size={15} className="text-[#15803d] shrink-0" />
        <h2 className="text-sm font-bold text-[#1f3559]">Recent billing</h2>
        {runs
          ? <span className="text-xs font-semibold text-[#15803d]">{money(total)} collected across {runs.length} billing day{runs.length === 1 ? "" : "s"}</span>
          : <span className="text-xs text-[#697a91]">payments that went through &mdash; open a day to see who was charged</span>}
        <span className="ml-auto text-[#15803d] text-xs">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-1.5">
          {error && <p className="text-[11px] text-[#e11d48]">{error}</p>}
          {loading && !runs ? (
            <div className="flex items-center gap-2 text-xs text-[#697a91] py-2">
              <Loader2 size={13} className="animate-spin" /> Loading billing history…
            </div>
          ) : (runs ?? []).length === 0 ? (
            <p className="text-xs text-[#8595a8] py-1">Nothing has been charged in the last few months.</p>
          ) : (
            <ul className="space-y-1 max-h-[55vh] overflow-y-auto">
              {(runs ?? []).map((run) => {
                const isOpen = openDay === run.day;
                return (
                  <li key={run.day} className="rounded-lg border border-[#d9efe2] bg-white">
                    <button onClick={() => setOpenDay(isOpen ? null : run.day)}
                      className="w-full flex items-center gap-2 flex-wrap px-2.5 py-1.5 text-left">
                      <span className="text-[13px] font-bold text-[#15803d] tabular-nums w-[70px]">{money(run.total)}</span>
                      <span className="text-[12px] font-semibold text-[#1f3559]">{fmtDay(run.day)}</span>
                      <span className="text-[11px] text-[#697a91]">
                        {run.clientCount} client{run.clientCount === 1 ? "" : "s"} · {run.shows} show{run.shows === 1 ? "" : "s"}
                      </span>
                      {run.manualOnly && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#f1f5f9] text-[#64748b] border border-[#e2e8f0]"
                          title="Recorded in the dashboard as collected elsewhere (e.g. charged directly in Square)">
                          recorded by hand
                        </span>
                      )}
                      <span className="ml-auto text-[11px] text-[#8595a8]">{isOpen ? "▲" : "▼"}</span>
                    </button>

                    {isOpen && (
                      <div className="border-t border-[#eef3f8] px-2.5 py-1.5 space-y-0.5">
                        {run.clients.map((c, i) => (
                          <div key={`${c.ownerKey}-${i}`} className="flex items-center gap-2 flex-wrap text-[11px]">
                            <span className="font-bold text-[#0e8f88] tabular-nums w-[60px]">{money(c.total)}</span>
                            <span className="font-semibold text-[#1f3559]">{c.ownerName}</span>
                            <span className="text-[#697a91]">{c.shows} show{c.shows === 1 ? "" : "s"}</span>
                            {c.coach && <span className="text-[#8595a8]">· {c.coach}</span>}
                            {c.chargedBy && <span className="text-[#8595a8]">· by {c.chargedBy.split("@")[0]}</span>}
                            {c.receiptUrl ? (
                              <a href={c.receiptUrl} target="_blank" rel="noopener noreferrer"
                                className="ml-auto flex items-center gap-1 font-semibold text-[#0e8f88] hover:underline">
                                Receipt <ExternalLink size={10} />
                              </a>
                            ) : (
                              <span className={cn("ml-auto px-1.5 py-0.5 rounded text-[9px] font-bold",
                                "bg-[#f1f5f9] text-[#64748b] border border-[#e2e8f0]")}>no receipt</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
